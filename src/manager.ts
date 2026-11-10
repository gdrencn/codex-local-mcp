import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { resolveExecutable } from './config.js';
import { workerArguments, workerEnvironment } from './codex.js';
import {
  TaskError,
  isTerminal,
  publicTask,
  type Reachability,
  type Submission,
  type Task,
} from './domain.js';
import { checkService } from './health.js';
import { clip, JsonLineDecoder, summarizeEvent } from './output.js';
import { bootIdentity, processIdentity, signalTree, snapshotTree } from './processes.js';
import { TaskStore } from './store.js';

type StopState = 'cancelled' | 'timed_out' | 'interrupted';
interface Running {
  child: ChildProcessWithoutNullStreams;
  completed: boolean;
  failed: boolean;
  lastError: string | null;
  stderrTail: string;
  stop: StopState | null;
  timer: NodeJS.Timeout;
  escalation: NodeJS.Timeout | null;
  closed: Promise<void>;
  resolveClosed: () => void;
}

export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly requests = new Map<string, string>();
  private readonly running = new Map<string, Running>();
  private readonly changes = new EventEmitter().setMaxListeners(0);
  private readonly store: TaskStore;
  private readonly binary: string;
  private readonly version: Promise<string>;
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;
  private healthInFlight: Promise<Reachability> | undefined;

  constructor(
    readonly config: Config,
    private readonly health: () => Promise<Reachability> = () =>
      checkService(config.baseUrl, config.healthTimeoutMs),
  ) {
    this.binary = resolveExecutable(config.binary);
    this.store = new TaskStore(config.dataDir, config.maxLogBytes);
    this.store.open();
    try {
      for (const task of this.store.load()) {
        this.tasks.set(task.id, task);
        if (task.request_id) this.requests.set(task.request_id, task.id);
        if (!isTerminal(task.state)) {
          // A killed backend may leave its worker running. Only clean it up
          // when boot identity and process start ticks prove it is our worker.
          if (
            task.pid &&
            task.pid_boot === bootIdentity() &&
            task.pid_start &&
            processIdentity(task.pid)?.start === task.pid_start
          ) {
            signalTree(task.pid, 'SIGKILL');
          }
          task.state = 'interrupted';
          task.pid = null;
          task.pid_start = null;
          task.pid_boot = null;
          task.ended_at = new Date().toISOString();
          task.error = {
            code: 'server_restarted',
            message: 'Server restarted before this task completed; work was not replayed.',
          };
          this.record(task, 'task.interrupted', task.error);
        }
      }
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.version = promisify(execFile)(this.binary, ['--version'], {
      timeout: 3000,
      maxBuffer: 65536,
      env: workerEnvironment(),
    })
      .then((result) => result.stdout.trim())
      .catch((error) => `unavailable: ${clip(String(error))}`);
  }

  async status() {
    const [service, version] = await Promise.all([this.serviceHealth(), this.version]);
    const counts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      timed_out: 0,
      interrupted: 0,
    };
    for (const task of this.tasks.values()) counts[task.state]++;
    return {
      binary: this.binary,
      codex_version: version,
      service,
      max_concurrency: this.config.maxConcurrency,
      max_queue: this.config.maxQueue,
      counts,
      recent_tasks: [...this.tasks.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 20)
        .map((task) => ({ task_id: task.id, state: task.state, created_at: task.created_at })),
    };
  }

  hasWork(): boolean {
    return (
      this.running.size > 0 || [...this.tasks.values()].some((task) => task.state === 'queued')
    );
  }

  private serviceHealth(): Promise<Reachability> {
    // Coalesce concurrent checks without retaining stale health after completion.
    this.healthInFlight ??= this.health().finally(() => {
      this.healthInFlight = undefined;
    });
    return this.healthInFlight;
  }

  async submit(input: Submission) {
    return this.admit(input, null);
  }

  async continue(id: string, input: Omit<Submission, 'cwd' | 'sandbox'>) {
    const parent = this.get(id);
    if (!isTerminal(parent.state) || !parent.session_id)
      throw new TaskError(
        'not_resumable',
        'Task must be terminal and have an explicit Codex session ID',
      );
    return this.admit({ ...input, cwd: parent.cwd, sandbox: parent.sandbox }, parent);
  }

  private async admit(input: Submission, parent: Task | null) {
    if (this.closing) throw new TaskError('server_closing', 'Server is shutting down');
    const normalized = this.validate(input);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          ...normalized,
          request_id: undefined,
          parent_task_id: parent?.id ?? null,
        }),
      )
      .digest('hex');
    const duplicate = () => {
      const existingId = normalized.request_id
        ? this.requests.get(normalized.request_id)
        : undefined;
      if (!existingId) return undefined;
      const existing = this.get(existingId);
      if (existing.fingerprint !== fingerprint)
        throw new TaskError(
          'request_conflict',
          'request_id was already used for a different submission',
        );
      return { task: publicTask(existing), deduplicated: true };
    };
    const existing = duplicate();
    if (existing) return existing;
    const service = await this.serviceHealth();
    if (!service.available)
      throw new TaskError('service_unavailable', service.error ?? 'LAN service is unavailable');
    if (this.closing) throw new TaskError('server_closing', 'Server is shutting down');
    const raced = duplicate();
    if (raced) return raced;
    const queued = [...this.tasks.values()].filter((task) => task.state === 'queued').length;
    const sessionBusy = parent?.session_id && this.busySessions().has(parent.session_id);
    if (
      (this.running.size >= this.config.maxConcurrency || sessionBusy) &&
      queued >= this.config.maxQueue
    ) {
      throw new TaskError('queue_full', 'Pending task queue is full');
    }
    const task: Task = {
      id: randomUUID(),
      state: 'queued',
      ...normalized,
      fingerprint,
      parent_task_id: parent?.id ?? null,
      resume_session_id: parent?.session_id ?? null,
      session_id: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      pid: null,
      exit_code: null,
      exit_signal: null,
      final_message: null,
      final_message_truncated: false,
      usage: null,
      error: null,
      event_count: 0,
      logs_truncated: false,
    };
    this.tasks.set(task.id, task);
    if (task.request_id) this.requests.set(task.request_id, task.id);
    this.record(task, 'task.queued', {});
    this.pump();
    return { task: publicTask(task), deduplicated: false };
  }

  private validate(input: Submission) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 131072)
      throw new TaskError('invalid_prompt', 'Prompt must contain 1..131072 characters');
    if (!isAbsolute(input.cwd))
      throw new TaskError('invalid_cwd', 'cwd must be an existing absolute directory');
    let cwd: string;
    try {
      cwd = realpathSync(input.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error();
    } catch {
      throw new TaskError('invalid_cwd', 'cwd must be an existing directory');
    }
    const sandbox = input.sandbox ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox))
      throw new TaskError('invalid_sandbox', 'Only read-only and workspace-write are supported');
    const images = (input.images ?? []).map((path) => {
      try {
        if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error();
        return realpathSync(path);
      } catch {
        throw new TaskError('invalid_image', 'Images must be existing absolute file paths');
      }
    });
    if (images.length > 16)
      throw new TaskError('invalid_images', 'At most 16 image paths are supported');
    const timeout_ms = input.timeout_ms ?? this.config.defaultTimeoutMs;
    if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 86400000)
      throw new TaskError('invalid_timeout', 'timeout_ms must be an integer in 100..86400000');
    if (
      input.request_id !== undefined &&
      (!input.request_id.trim() || input.request_id.length > 128)
    )
      throw new TaskError('invalid_request_id', 'request_id must contain 1..128 characters');
    return {
      prompt: input.prompt,
      cwd,
      sandbox,
      images,
      timeout_ms,
      request_id: input.request_id ?? null,
    };
  }

  get(id: string): Task {
    // Validate the identifier even when the lookup misses.
    this.store.path(id, 'task.json');
    const task = this.tasks.get(id);
    if (!task) throw new TaskError('task_not_found', `Unknown task: ${id}`);
    return task;
  }

  async query(id: string, cursor = 0, limit = 50, waitMs = 0) {
    const task = this.get(id);
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 20000
    ) {
      throw new TaskError('invalid_pagination', 'Invalid cursor, limit, or wait_ms');
    }
    if (waitMs && task.event_count <= cursor && !isTerminal(task.state)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.changes.off(id, done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.changes.once(id, done);
      });
    }
    // Freeze the cursor ceiling before disk I/O so newly arriving events are
    // returned on the next poll rather than skipped after this read reaches EOF.
    const snapshot = { ...task };
    const events = await this.store.events(id, cursor, limit, snapshot.event_count);
    const next =
      events.length === limit ? events.at(-1)!.cursor : Math.max(cursor, snapshot.event_count);
    return {
      task: publicTask(snapshot),
      events,
      next_cursor: next,
      has_more: next < snapshot.event_count,
    };
  }

  async cancel(id: string) {
    const task = this.get(id);
    if (task.state === 'queued') {
      task.state = 'cancelled';
      task.ended_at = new Date().toISOString();
      this.record(task, 'task.cancelled', {});
      this.pump();
    } else if (task.state === 'running') {
      const running = this.running.get(id)!;
      this.stop(task, 'cancelled');
      await running.closed;
    }
    return { task: publicTask(task) };
  }

  private busySessions(): Set<string> {
    return new Set(
      [...this.running.keys()].flatMap((id) => {
        const task = this.get(id);
        return [task.session_id, task.resume_session_id].filter((id): id is string => id !== null);
      }),
    );
  }

  private pump(): void {
    while (!this.closing && this.running.size < this.config.maxConcurrency) {
      const busy = this.busySessions();
      const task = [...this.tasks.values()].find(
        (task) =>
          task.state === 'queued' && (!task.resume_session_id || !busy.has(task.resume_session_id)),
      );
      if (!task) return;
      this.start(task);
    }
  }

  private start(task: Task): void {
    task.state = 'running';
    task.started_at = new Date().toISOString();
    const child = spawn(this.binary, workerArguments(task, this.config), {
      cwd: task.cwd,
      env: workerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    task.pid = child.pid ?? null;
    task.pid_start = task.pid ? (processIdentity(task.pid)?.start ?? null) : null;
    task.pid_boot = task.pid ? bootIdentity() : null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const running: Running = {
      child,
      completed: false,
      failed: false,
      lastError: null,
      stderrTail: '',
      stop: null,
      timer: setTimeout(() => this.stop(task, 'timed_out'), task.timeout_ms),
      escalation: null,
      closed,
      resolveClosed,
    };
    this.running.set(task.id, running);
    this.record(task, 'task.running', { pid: task.pid });
    const decoder = new JsonLineDecoder(
      (line) => this.parseLine(task, running, line),
      () => {
        task.logs_truncated = true;
        this.record(task, 'output.oversize', {
          message: 'Worker event exceeded 256 KiB and was skipped',
        });
      },
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.store.append(task.id, 'stdout.jsonl', chunk)) task.logs_truncated = true;
      decoder.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      running.stderrTail = (running.stderrTail + chunk.toString('utf8')).slice(-4096);
      if (!this.store.append(task.id, 'stderr.log', chunk)) task.logs_truncated = true;
    });
    child.on('error', (error) => {
      running.failed = true;
      running.lastError = error.message;
    });
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') running.lastError = error.message;
    });
    child.once('close', (code, signal) => {
      decoder.end();
      clearTimeout(running.timer);
      // If root exited before an independently grouped child, still clean the snapshot.
      // Escalation remains active until its grace period when stopping a task.
      if (running.escalation === null) this.finalize(task, running, code, signal);
      else {
        // The escalation callback owns finalization after checking detached descendants.
        this.stopClosures.set(task.id, () => this.finalize(task, running, code, signal));
      }
    });
    child.stdin.end(task.prompt);
  }

  private readonly stopClosures = new Map<string, () => void>();

  private parseLine(task: Task, running: Running, line: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      event = parsed as Record<string, unknown>;
    } catch {
      this.record(task, 'output.unparsed', { text: clip(line) });
      return;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string')
      task.session_id = event.thread_id;
    if (event.type === 'turn.completed') {
      running.completed = true;
      task.usage = event.usage ?? null;
    }
    if (event.type === 'turn.failed') {
      running.failed = true;
      running.lastError = clip(JSON.stringify(event.error ?? 'Turn failed'));
    }
    if (event.type === 'error')
      running.lastError = clip(String(event.message ?? JSON.stringify(event)));
    const item = event.item as Record<string, unknown> | undefined;
    if (
      event.type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      task.final_message = clip(item.text, 16384);
      task.final_message_truncated = item.text.length > 16384;
    }
    this.record(
      task,
      typeof event.type === 'string' ? event.type : 'output.unknown',
      summarizeEvent(event),
    );
  }

  private stop(task: Task, state: StopState): void {
    const running = this.running.get(task.id);
    if (!running || running.stop) return;
    running.stop = state;
    clearTimeout(running.timer);
    this.record(task, 'task.stopping', { reason: state });
    const pid = running.child.pid;
    const tree = pid ? snapshotTree(pid) : [];
    if (pid) signalTree(pid, 'SIGTERM', tree);
    running.escalation = setTimeout(() => {
      if (pid) signalTree(pid, 'SIGKILL', tree);
      running.escalation = null;
      const finalize = this.stopClosures.get(task.id);
      this.stopClosures.delete(task.id);
      finalize?.();
    }, this.config.graceMs);
  }

  private finalize(
    task: Task,
    running: Running,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    task.exit_code = code;
    task.exit_signal = signal;
    task.pid = null;
    task.pid_start = null;
    task.pid_boot = null;
    task.ended_at = new Date().toISOString();
    task.state =
      running.stop ?? (code === 0 && running.completed && !running.failed ? 'succeeded' : 'failed');
    if (task.state !== 'succeeded')
      task.error = {
        code: running.stop ?? 'worker_failed',
        message:
          running.lastError ??
          (running.stop
            ? `Task ${running.stop}`
            : running.stderrTail.trim() || 'Worker exited without a successful completed turn'),
      };
    this.running.delete(task.id);
    this.record(task, `task.${task.state}`, { exit_code: code, exit_signal: signal });
    running.resolveClosed();
    this.pump();
  }

  private record(task: Task, type: string, detail: unknown): void {
    task.event_count++;
    if (
      !this.store.append(
        task.id,
        'events.jsonl',
        JSON.stringify({ cursor: task.event_count, at: new Date().toISOString(), type, detail }) +
          '\n',
      )
    )
      task.logs_truncated = true;
    this.store.save(task);
    this.changes.emit(task.id);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.close();
    return this.shutdownPromise;
  }

  private async close(): Promise<void> {
    this.closing = true;
    for (const task of this.tasks.values()) {
      if (task.state === 'queued') {
        task.state = 'interrupted';
        task.ended_at = new Date().toISOString();
        task.error = {
          code: 'server_shutdown',
          message: 'Server shut down before this task started',
        };
        this.record(task, 'task.interrupted', task.error);
      } else if (task.state === 'running') this.stop(task, 'interrupted');
    }
    await Promise.all([...this.running.values()].map((running) => running.closed));
    this.store.close();
  }
}

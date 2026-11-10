import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { MAX_FRAME, prepareBackend, type BackendReply } from './backend-protocol.js';
import { TaskError, type Submission } from './domain.js';
import { JsonLineDecoder } from './output.js';
import type { TaskService } from './service.js';
import type { TaskManager } from './manager.js';
import { bootIdentity, processIdentity } from './processes.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class BackendClient implements TaskService {
  private readonly pending = new Map<string, Pending>();
  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    const decoder = new JsonLineDecoder(
      (line) => {
        try {
          const reply = JSON.parse(line) as BackendReply;
          const pending = this.pending.get(reply.id);
          if (!pending) return;
          this.pending.delete(reply.id);
          clearTimeout(pending.timer);
          if (reply.error) pending.reject(new TaskError(reply.error.code, reply.error.message));
          else pending.resolve(reply.result);
        } catch {
          socket.destroy(new Error('Invalid backend response'));
        }
      },
      () => socket.destroy(new Error('Backend response exceeds frame limit')),
      MAX_FRAME,
    );
    socket.on('data', (chunk: Buffer) => decoder.push(chunk));
    socket.on('error', () => {
      /* close rejects all pending requests. */
    });
    socket.once('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new TaskError(
            'backend_disconnected',
            'Shared backend disconnected; reopen the MCP connection',
          ),
        );
      }
      this.pending.clear();
    });
  }

  static async open(socketPath: string, timeoutMs: number): Promise<BackendClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        resolve(new BackendClient(socket, timeoutMs));
      });
    });
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.socket.destroyed)
      return Promise.reject(
        new TaskError('backend_disconnected', 'Shared backend connection is closed'),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TaskError('backend_timeout', `Backend ${method} request timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  status(): ReturnType<TaskManager['status']> {
    return this.call('status', {}) as ReturnType<TaskManager['status']>;
  }
  submit(input: Submission): ReturnType<TaskManager['submit']> {
    return this.call('submit', input) as ReturnType<TaskManager['submit']>;
  }
  query(id: string, cursor = 0, limit = 50, waitMs = 0): ReturnType<TaskManager['query']> {
    return this.call('query', { task_id: id, cursor, limit, wait_ms: waitMs }) as ReturnType<
      TaskManager['query']
    >;
  }
  cancel(id: string): ReturnType<TaskManager['cancel']> {
    return this.call('cancel', { task_id: id }) as ReturnType<TaskManager['cancel']>;
  }
  continue(
    id: string,
    input: Omit<Submission, 'cwd' | 'sandbox'>,
  ): ReturnType<TaskManager['continue']> {
    return this.call('continue', { ...input, task_id: id }) as ReturnType<TaskManager['continue']>;
  }
  close(): void {
    this.socket.destroy();
  }
}

function backendEnvironment(config: Config): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_LOCAL_MCP_BINARY: config.binary,
    CODEX_LOCAL_MCP_BASE_URL: config.baseUrl,
    CODEX_LOCAL_MCP_DATA_DIR: config.dataDir,
    CODEX_LOCAL_MCP_MAX_CONCURRENCY: String(config.maxConcurrency),
    CODEX_LOCAL_MCP_MAX_QUEUE: String(config.maxQueue),
    CODEX_LOCAL_MCP_TIMEOUT_MS: String(config.defaultTimeoutMs),
    CODEX_LOCAL_MCP_GRACE_MS: String(config.graceMs),
    CODEX_LOCAL_MCP_HEALTH_TIMEOUT_MS: String(config.healthTimeoutMs),
    CODEX_LOCAL_MCP_MAX_LOG_BYTES: String(config.maxLogBytes),
    CODEX_LOCAL_MCP_SERVER_ID: config.mcpServerId,
    CODEX_LOCAL_MCP_BACKEND_IDLE_MS: String(config.backendIdleMs),
  };
}

export async function connectBackend(input: Config): Promise<BackendClient> {
  const { config, socketPath, signature } = prepareBackend(input);
  const timeout = Math.max(40000, config.graceMs + 10000);
  let lastSpawn = 0;
  let startupError = '';
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const client = await BackendClient.open(socketPath, timeout);
      try {
        await client.call('hello', { signature });
        return client;
      } catch (error) {
        client.close();
        throw error;
      }
    } catch (error) {
      if (
        ![
          'ENOENT',
          'ECONNREFUSED',
          'ECONNRESET',
          'EPIPE',
          'backend_disconnected',
          'backend_closing',
        ].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      if (!ownerIsAlive(config.dataDir) && Date.now() - lastSpawn >= 150) {
        lastSpawn = Date.now();
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL('./daemon.js', import.meta.url))],
          {
            detached: true,
            stdio: 'ignore',
            env: backendEnvironment(config),
          },
        );
        child.on('error', (error) => {
          startupError = error.message;
        });
        child.unref();
      }
      if (startupError) break;
      await delay(50);
    }
  }
  try {
    startupError ||= JSON.parse(
      readFileSync(join(config.dataDir, 'startup-error.json'), 'utf8'),
    ).message;
  } catch {
    /* No diagnostic available. */
  }
  throw new TaskError(
    'backend_start_failed',
    startupError ||
      'Shared backend did not start; check data-directory ownership and worker executable',
  );
}

function ownerIsAlive(dataDir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(dataDir, 'server.lock'), 'utf8')) as {
      pid: number;
      boot?: string;
      start?: string;
    };
    if (owner.boot && owner.boot !== bootIdentity()) return false;
    const identity = processIdentity(owner.pid);
    return !!identity && (!owner.start || owner.start === identity.start);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function stopBackend(input: Config): Promise<boolean> {
  const { config, socketPath } = prepareBackend(input, false);
  let client: BackendClient;
  try {
    client = await BackendClient.open(socketPath, 10000);
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false;
    throw error;
  }
  let pid: number;
  try {
    pid = ((await client.call('shutdown', {})) as { pid: number }).pid;
  } finally {
    client.close();
  }
  const deadline = Date.now() + config.graceMs + 10000;
  while (Date.now() < deadline) {
    try {
      const owner = JSON.parse(readFileSync(join(config.dataDir, 'server.lock'), 'utf8')) as {
        pid: number;
      };
      if (owner.pid !== pid) return true;
    } catch {
      return true;
    }
    await delay(25);
  }
  throw new TaskError('backend_stop_failed', 'Backend did not release its data-directory lock');
}

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TaskError, type Task, type TaskEvent } from './domain.js';
import { bootIdentity, processIdentity } from './processes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskStore {
  private readonly token = randomUUID();
  private readonly sizes = new Map<string, number>();
  private readonly eventOffsets = new Map<
    string,
    { cursor: number; start: number; end: number }[]
  >();
  private owned = false;

  constructor(
    readonly directory: string,
    private readonly maxLogBytes: number,
  ) {}

  open(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directory, 'tasks'), { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'server.lock');
    const acquire = () => {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            token: this.token,
            boot: bootIdentity(),
            start: processIdentity(process.pid)?.start,
          }),
        );
      } finally {
        closeSync(fd);
      }
      this.owned = true;
    };
    try {
      acquire();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const guard = join(this.directory, '.lock-recovery');
    try {
      mkdirSync(guard);
    } catch {
      throw new TaskError('store_in_use', 'Another server is acquiring this data directory');
    }
    try {
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as {
        pid: number;
        boot?: string;
        start?: string;
      };
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw new Error('Invalid data-directory lock');
      try {
        if (
          (owner.boot && owner.boot !== bootIdentity()) ||
          (owner.start && processIdentity(owner.pid)?.start !== owner.start)
        ) {
          throw Object.assign(new Error('Stale process identity'), { code: 'ESRCH' });
        }
        process.kill(owner.pid, 0);
        throw new TaskError('store_in_use', `Data directory belongs to live PID ${owner.pid}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      unlinkSync(lock);
      acquire();
    } finally {
      rmdirSync(guard);
    }
  }

  close(): void {
    if (!this.owned) return;
    const lock = join(this.directory, 'server.lock');
    const owner = JSON.parse(readFileSync(lock, 'utf8')) as { token: string };
    if (owner.token === this.token) unlinkSync(lock);
    this.owned = false;
  }

  path(id: string, filename: string): string {
    if (!UUID.test(id)) throw new TaskError('invalid_task_id', 'Task ID must be a UUID');
    return join(this.directory, 'tasks', id, filename);
  }

  save(task: Task): void {
    const target = this.path(task.id, 'task.json');
    mkdirSync(join(this.directory, 'tasks', task.id), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(task, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, target);
  }

  load(): Task[] {
    return readdirSync(join(this.directory, 'tasks'))
      .filter((id) => UUID.test(id))
      .flatMap((id) => {
        const file = this.path(id, 'task.json');
        return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as Task] : [];
      });
  }

  append(id: string, filename: string, value: string | Buffer): boolean {
    const path = this.path(id, filename);
    mkdirSync(join(this.directory, 'tasks', id), { recursive: true, mode: 0o700 });
    const current = this.sizes.get(path) ?? (existsSync(path) ? statSync(path).size : 0);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    // Never write partial JSON lines; raw output truncates only on chunk boundaries.
    if (current + data.length > this.maxLogBytes) return false;
    appendFileSync(path, data, { mode: 0o600 });
    this.sizes.set(path, current + data.length);
    if (filename === 'events.jsonl' && (current === 0 || this.eventOffsets.has(path))) {
      const offsets = this.eventOffsets.get(path) ?? [];
      const event = JSON.parse(data.toString('utf8')) as TaskEvent;
      offsets.push({ cursor: event.cursor, start: current, end: current + data.length });
      this.eventOffsets.set(path, offsets);
    }
    return true;
  }

  async events(
    id: string,
    cursor: number,
    limit: number,
    ceiling = Infinity,
  ): Promise<TaskEvent[]> {
    const path = this.path(id, 'events.jsonl');
    if (!existsSync(path)) return [];
    let offsets = this.eventOffsets.get(path);
    if (!offsets) {
      offsets = [];
      const data = readFileSync(path);
      for (let start = 0; start < data.length;) {
        const newline = data.indexOf(10, start);
        if (newline < 0) break;
        const event = JSON.parse(data.subarray(start, newline).toString('utf8')) as TaskEvent;
        offsets.push({ cursor: event.cursor, start, end: newline + 1 });
        start = newline + 1;
      }
      this.eventOffsets.set(path, offsets);
    }
    let low = 0,
      high = offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle]!.cursor <= cursor) low = middle + 1;
      else high = middle;
    }
    const selected = offsets.slice(low, low + limit).filter((entry) => entry.cursor <= ceiling);
    if (!selected.length) return [];
    const input = createReadStream(path, {
      encoding: 'utf8',
      start: selected[0]!.start,
      end: selected.at(-1)!.end - 1,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const result: TaskEvent[] = [];
    try {
      for await (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as TaskEvent;
        if (event.cursor > cursor) result.push(event);
        if (result.length >= limit) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return result;
  }
}

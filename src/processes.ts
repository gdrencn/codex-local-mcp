import { readdirSync, readFileSync } from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  start: string;
}

export function bootIdentity(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

export function processIdentity(pid: number): ProcessIdentity | undefined {
  const info = inspect(pid);
  return info && info.state !== 'Z' ? { pid, start: info.start } : undefined;
}

function inspect(pid: number): { parent: number; start: string; state: string } | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0]!, parent: Number(fields[1]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/** Snapshot descendants before killing a parent; detached tool children may own another process group. */
export function snapshotTree(root: number): ProcessIdentity[] {
  const processes = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .map((pid) => ({ pid, info: inspect(pid) }))
    .filter((entry) => entry.info !== undefined);
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    const siblings = children.get(entry.info!.parent) ?? [];
    siblings.push(entry.pid);
    children.set(entry.info!.parent, siblings);
  }
  const selected = new Set([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    for (const pid of children.get(queue[index]!) ?? []) {
      if (!selected.has(pid)) {
        selected.add(pid);
        queue.push(pid);
      }
    }
  }
  return processes
    .filter((entry) => selected.has(entry.pid))
    .map((entry) => ({ pid: entry.pid, start: entry.info!.start }));
}

export function signalTree(root: number, signal: NodeJS.Signals, known = snapshotTree(root)): void {
  // Kill known descendants individually as well as the root process group.
  for (const identity of [...known].reverse()) {
    const current = inspect(identity.pid);
    if (current?.start !== identity.start || current.state === 'Z') continue;
    try {
      process.kill(identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  // Only target the group while the recorded root still has the same identity.
  const identity = known.find((entry) => entry.pid === root);
  if (identity && inspect(root)?.start === identity.start) {
    try {
      process.kill(-root, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

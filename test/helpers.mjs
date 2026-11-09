import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskManager } from '../dist/manager.js';
import { loadConfig } from '../dist/config.js';

export const fixture = resolve('test/fixtures/worker.mjs');
export const available = async () => ({ available: true, checked_at: new Date().toISOString() });
export const terminal = (state) => !['queued', 'running'].includes(state);

export async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-mcp-test-'));
  const config = {
    ...loadConfig({}),
    binary: fixture,
    dataDir: join(root, 'data'),
    defaultTimeoutMs: 3000,
    graceMs: 60,
    ...overrides,
  };
  const manager = new TaskManager(config, available);
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    manager,
    submit: (options = {}, more = {}) =>
      manager.submit({ prompt: JSON.stringify(options), cwd: root, ...more }),
  };
}

export async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function completed(manager, id) {
  await until(() => terminal(manager.get(id).state));
  return (await manager.query(id)).task;
}

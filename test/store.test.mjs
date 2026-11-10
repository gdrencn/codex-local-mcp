import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../dist/store.js';

test('indexed pages retain UTF-8 boundaries, cursor ceilings, and recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-mcp-index-'));
  const a = new TaskStore(root, 16777216);
  a.open();
  const id = randomUUID();
  for (let cursor = 1; cursor <= 2000; cursor++)
    a.append(
      id,
      'events.jsonl',
      JSON.stringify({ cursor, at: 'now', type: 'test', detail: '中文🙂' }) + '\n',
    );
  assert.deepEqual(
    (await a.events(id, 1980, 10, 1985)).map((event) => event.cursor),
    [1981, 1982, 1983, 1984, 1985],
  );
  a.close();
  const b = new TaskStore(root, 16777216);
  b.open();
  t.after(async () => {
    b.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await b.events(id, 1999, 10);
  assert.equal(page[0].cursor, 2000);
  assert.equal(page[0].detail, '中文🙂');
});

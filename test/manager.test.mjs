import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, until, completed, available } from './helpers.mjs';
import { TaskManager } from '../dist/manager.js';

test('concurrent health checks coalesce without caching completed results', async (t) => {
  const { root, manager } = await setup(t);
  let count = 0;
  const releases = [];
  manager.health = () => {
    count++;
    return new Promise((resolve) =>
      releases.push(() => resolve({ available: true, checked_at: '' })),
    );
  };
  const requests = [
    manager.status(),
    manager.submit({ cwd: root, prompt: '{}' }),
    manager.submit({ cwd: root, prompt: '{}' }),
  ];
  const simultaneous = count;
  for (const release of releases) release();
  await Promise.all(requests);
  assert.equal(simultaneous, 1);
  manager.health = async () => {
    count++;
    return { available: true, checked_at: '' };
  };
  await manager.status();
  assert.equal(count, 2);
});

test('events arriving during query I/O are not skipped by its cursor', async (t) => {
  const { manager, submit } = await setup(t);
  const job = await submit({ delay: 200, answer: 'late event' });
  const ceiling = manager.get(job.task.id).event_count;
  const read = manager.store.events.bind(manager.store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reading = false;
  manager.store.events = async (...args) => {
    const events = await read(...args);
    reading = true;
    await gate;
    return events;
  };
  const pending = manager.query(job.task.id, ceiling);
  await until(() => reading && manager.get(job.task.id).state === 'succeeded');
  release();
  const first = await pending;
  assert.equal(first.next_cursor, ceiling);
  manager.store.events = read;
  const next = await manager.query(job.task.id, first.next_cursor);
  assert.ok(next.events.some((event) => event.type === 'turn.completed'));
});

test('four independent workers start before a fifth queued worker', async (t) => {
  const { manager, submit } = await setup(t);
  const jobs = await Promise.all(
    Array.from({ length: 5 }, (_, i) => submit({ answer: String(i), delay: 250 })),
  );
  assert.deepEqual(
    jobs.map((job) => job.task.state),
    ['running', 'running', 'running', 'running', 'queued'],
  );
  const results = await Promise.all(jobs.map((job) => completed(manager, job.task.id)));
  assert.ok(results.every((task) => task.state === 'succeeded'));
  assert.equal(new Set(results.map((task) => task.session_id)).size, 5);
  assert.deepEqual(
    results.map((task) => task.final_message),
    ['0', '1', '2', '3', '4'],
  );
  assert.ok(
    Date.parse(results[4].started_at) >=
      Math.min(...results.slice(0, 4).map((task) => Date.parse(task.ended_at))),
  );
});

test('stdin and native arguments preserve literal characters and disable scheduler recursion', async (t) => {
  const { root, manager, submit } = await setup(t);
  const capture = join(root, 'capture.json');
  const answer = 'space \'quote\' "double" $(not-executed);\n中文';
  const image = join(root, 'image with spaces.png');
  await writeFile(image, 'image');
  const job = await submit({ capture, answer, fragmented: true }, { images: [image] });
  const result = await completed(manager, job.task.id);
  assert.equal(result.final_message, answer);
  const seen = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(seen.args.at(-1), '-');
  assert.ok(seen.args.includes(image));
  assert.ok(seen.args.includes('mcp_servers.codex_local={enabled=false,command="/bin/false"}'));
  assert.ok(seen.args.includes('sandbox_mode="read-only"'));
  assert.equal(seen.cwd, root);
  assert.equal(seen.inherited_thread, null);
  assert.equal(JSON.parse(seen.prompt).answer, answer);
});

test('request IDs deduplicate races, reject different input, and work while offline', async (t) => {
  const { manager, submit } = await setup(t);
  const results = await Promise.all([
    submit({ answer: 'one' }, { request_id: 'same' }),
    submit({ answer: 'one' }, { request_id: 'same' }),
  ]);
  assert.equal(results[0].task.id, results[1].task.id);
  await assert.rejects(submit({ answer: 'two' }, { request_id: 'same' }), {
    code: 'request_conflict',
  });
  manager.health = async () => ({ available: false, checked_at: '', error: 'offline' });
  assert.equal(
    (await submit({ answer: 'one' }, { request_id: 'same' })).task.id,
    results[0].task.id,
  );
  await assert.rejects(submit({ answer: 'new' }), { code: 'service_unavailable' });
});

test('cancelling one worker cleans detached descendants and preserves other workers', async (t) => {
  const { root, manager, submit } = await setup(t);
  const childFile = join(root, 'child.pid');
  const first = await submit({ hold: true, ignore_term: true, detached_child: childFile });
  const other = await submit({ answer: 'unaffected', delay: 400 });
  await until(() => existsSync(childFile));
  const childPid = Number(await readFile(childFile, 'utf8'));
  const result = await manager.cancel(first.task.id);
  assert.equal(result.task.state, 'cancelled');
  assert.equal((await completed(manager, other.task.id)).final_message, 'unaffected');
  await until(() => {
    try {
      return readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
    } catch {
      return true;
    }
  });
});

test('execution timeouts do not charge queue wait and queue cancellation is immediate', async (t) => {
  const { manager, submit } = await setup(t, { maxConcurrency: 1 });
  const first = await submit({ hold: true }, { timeout_ms: 150 });
  const second = await submit({ answer: 'later' }, { timeout_ms: 200 });
  const third = await submit({ hold: true });
  assert.equal(second.task.state, 'queued');
  assert.equal((await manager.cancel(third.task.id)).task.state, 'cancelled');
  assert.equal((await completed(manager, first.task.id)).state, 'timed_out');
  const result = await completed(manager, second.task.id);
  assert.equal(result.state, 'succeeded');
  assert.ok(result.queue_ms >= 150);
});

test('same-session continuations serialize while an independent job uses another slot', async (t) => {
  const { manager, root, submit } = await setup(t, { maxConcurrency: 2 });
  const parent = await submit();
  const parentResult = await completed(manager, parent.task.id);
  const a = await manager.continue(parent.task.id, { prompt: JSON.stringify({ delay: 200 }) });
  const b = await manager.continue(parent.task.id, { prompt: JSON.stringify({ delay: 25 }) });
  const independent = await manager.submit({ cwd: root, prompt: JSON.stringify({ delay: 25 }) });
  assert.equal(a.task.state, 'running');
  assert.equal(b.task.state, 'queued');
  assert.equal(independent.task.state, 'running');
  const [ar, br] = await Promise.all([
    completed(manager, a.task.id),
    completed(manager, b.task.id),
  ]);
  assert.equal(ar.session_id, parentResult.session_id);
  assert.equal(br.session_id, parentResult.session_id);
  assert.ok(Date.parse(br.started_at) >= Date.parse(ar.ended_at));
});

test('turn failures, nonzero exits, and missing completion never report success', async (t) => {
  const { manager, submit } = await setup(t);
  for (const options of [{ failure: true }, { exit_code: 17 }, { incomplete: true }]) {
    const job = await submit(options);
    assert.equal((await completed(manager, job.task.id)).state, 'failed');
  }
});

test('startup failures surface bounded stderr in the task error', async (t) => {
  const { manager, submit } = await setup(t);
  const job = await submit({ startup_error: true });
  const result = await completed(manager, job.task.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.exit_code, 2);
  assert.match(result.error.message, /fixture startup failure/);
});

test('malformed and oversize output is bounded and event pagination terminates', async (t) => {
  const { manager, submit } = await setup(t, { maxLogBytes: 8192 });
  const job = await submit({ malformed: true, oversize: true, answer: 'final' });
  const result = await completed(manager, job.task.id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.final_message, 'final');
  assert.equal(result.logs_truncated, true);
  let cursor = 0;
  const events = [];
  for (let i = 0; i < 20; i++) {
    const page = await manager.query(job.task.id, cursor, 2);
    events.push(...page.events);
    assert.ok(page.next_cursor >= cursor);
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  assert.equal(cursor, manager.get(job.task.id).event_count);
  assert.ok(events.some((event) => event.type === 'output.unparsed'));
  assert.ok(events.some((event) => event.type === 'output.oversize'));
});

test('data ownership, persisted results, unfinished recovery, and idempotency survive restart', async (t) => {
  const { config, manager, submit } = await setup(t);
  assert.throws(() => new TaskManager(config, available), { code: 'store_in_use' });
  const done = await submit({ answer: 'saved' }, { request_id: 'persisted' });
  await completed(manager, done.task.id);
  const pending = await submit({ hold: true });
  await manager.shutdown();
  // Simulate a crash-era metadata snapshot after releasing the test owner's lock.
  const file = join(config.dataDir, 'tasks', pending.task.id, 'task.json');
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  snapshot.state = 'running';
  snapshot.ended_at = null;
  await writeFile(file, JSON.stringify(snapshot));
  const reopened = new TaskManager(config, available);
  try {
    assert.equal(reopened.get(done.task.id).final_message, 'saved');
    assert.equal(reopened.get(pending.task.id).state, 'interrupted');
    assert.equal(reopened.get(pending.task.id).error.code, 'server_restarted');
    assert.equal(
      (
        await reopened.submit({
          prompt: JSON.stringify({ answer: 'saved' }),
          cwd: config.dataDir + '/../',
          request_id: 'persisted',
        })
      ).task.id,
      done.task.id,
    );
  } finally {
    await reopened.shutdown();
  }
});

test('queue bounds and validation return explicit domain errors', async (t) => {
  const { manager, submit } = await setup(t, { maxConcurrency: 1, maxQueue: 1 });
  await submit({ hold: true });
  await submit({ hold: true });
  await assert.rejects(submit(), { code: 'queue_full' });
  await assert.rejects(manager.submit({ prompt: 'x', cwd: 'relative' }), { code: 'invalid_cwd' });
  await assert.rejects(manager.query('invalid'), { code: 'invalid_task_id' });
});

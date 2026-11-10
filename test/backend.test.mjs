import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectBackend, stopBackend } from '../dist/backend-client.js';
import { loadConfig } from '../dist/config.js';
import { fixture, until } from './helpers.mjs';

async function context(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-mcp-shared-'));
  let healthy = true;
  const health = http.createServer((_req, response) => {
    response.statusCode = healthy ? 200 : 503;
    response.end(JSON.stringify({ data: healthy ? [{ id: 'fixture' }] : [] }));
  });
  await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    CODEX_LOCAL_MCP_BINARY: fixture,
    CODEX_LOCAL_MCP_BASE_URL: `http://127.0.0.1:${health.address().port}/v1`,
    CODEX_LOCAL_MCP_DATA_DIR: join(root, 'data'),
    CODEX_LOCAL_MCP_GRACE_MS: '50',
    ...extra,
  };
  const config = loadConfig(env);
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await stopBackend(config);
    await new Promise((resolve) => health.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const client = await connectBackend(config);
    clients.push(client);
    return client;
  };
  const sdk = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js')],
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'shared-client-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return {
      close: () => client.close(),
      call: async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError)
          throw Object.assign(
            new Error(result.structuredContent.error.message),
            result.structuredContent.error,
          );
        return result.structuredContent;
      },
    };
  };
  return {
    root,
    config,
    open,
    sdk,
    setHealthy: (value) => {
      healthy = value;
    },
  };
}

test('two MCP conversations share four slots, queued work, and independent cancellation', async (t) => {
  const { root, sdk } = await context(t);
  const [a, b] = await Promise.all([sdk(), sdk()]);
  const [sa, sb] = await Promise.all([a.call('local_status'), b.call('local_status')]);
  assert.equal(sa.backend.pid, sb.backend.pid);
  assert.equal(sa.backend.shared, true);
  const jobs = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      (i % 2 ? a : b).call('local_submit', { cwd: root, prompt: JSON.stringify({ hold: true }) }),
    ),
  );
  const status = await b.call('local_status');
  assert.equal(status.counts.running, 4);
  assert.equal(status.counts.queued, 1);
  const queued = jobs.find((job) => job.task.state === 'queued');
  assert.ok(queued);
  const first = jobs.find((job) => job.task.state === 'running');
  await b.call('local_cancel', { task_id: first.task.id });
  await until(
    async () => (await b.call('local_task', { task_id: queued.task.id })).task.state === 'running',
  );
  await a.close();
  assert.equal((await b.call('local_status')).counts.running, 4);
  await Promise.all(
    jobs
      .filter((job) => job !== first)
      .map((job) => b.call('local_cancel', { task_id: job.task.id })),
  );
  assert.equal((await b.call('local_status')).counts.running, 0);
});

test('disconnected submitters do not interrupt work and another client can continue the session', async (t) => {
  const { root, open } = await context(t);
  const a = await open();
  const submitted = await a.submit({
    cwd: root,
    prompt: JSON.stringify({ answer: 'after disconnect', delay: 250 }),
  });
  a.close();
  const b = await open();
  await until(async () => (await b.query(submitted.task.id)).task.state === 'succeeded');
  const task = (await b.query(submitted.task.id)).task;
  assert.equal(task.final_message, 'after disconnect');
  const followup = await b.continue(task.id, { prompt: JSON.stringify({ answer: 'follow-up' }) });
  await until(async () => (await b.query(followup.task.id)).task.state === 'succeeded');
  assert.equal((await b.query(followup.task.id)).task.session_id, task.session_id);
});

test('backend configuration mismatches do not replace the owner', async (t) => {
  const { config, open } = await context(t);
  const a = await open();
  const before = await a.status();
  await assert.rejects(connectBackend({ ...config, maxConcurrency: 2 }), {
    code: 'configuration_mismatch',
  });
  assert.equal((await a.status()).backend.pid, before.backend.pid);
});

test('hard backend crash recovers task state and cleans the recorded orphan worker', async (t) => {
  const { root, open } = await context(t);
  const a = await open();
  const status = await a.status();
  const job = await a.submit({ cwd: root, prompt: JSON.stringify({ hold: true }) });
  await until(async () => (await a.query(job.task.id)).task.session_id !== null);
  const worker = (await a.query(job.task.id)).task;
  assert.ok(worker.pid_start);
  assert.ok(worker.pid_boot);
  process.kill(status.backend.pid, 'SIGKILL');
  a.close();
  const b = await open();
  assert.equal((await b.query(job.task.id)).task.state, 'interrupted');
  await until(() => {
    try {
      return readFileSync(`/proc/${worker.pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
    } catch {
      return true;
    }
  });
});

test('backend restart preserves results and interrupted work is not replayed', async (t) => {
  const { root, config, open } = await context(t);
  const a = await open();
  const saved = await a.submit({
    cwd: root,
    prompt: JSON.stringify({ answer: 'saved' }),
    request_id: 'saved',
  });
  await until(async () => (await a.query(saved.task.id)).task.state === 'succeeded');
  const held = await a.submit({ cwd: root, prompt: JSON.stringify({ hold: true }) });
  assert.equal(await stopBackend(config), true);
  const b = await open();
  assert.equal((await b.query(saved.task.id)).task.final_message, 'saved');
  assert.equal((await b.query(held.task.id)).task.state, 'interrupted');
  assert.equal(
    (
      await b.submit({
        cwd: root,
        prompt: JSON.stringify({ answer: 'saved' }),
        request_id: 'saved',
      })
    ).task.id,
    saved.task.id,
  );
});

test('idle backend exits and a fresh client can restart it', async (t) => {
  const { config, open } = await context(t, { CODEX_LOCAL_MCP_BACKEND_IDLE_MS: '100' });
  const a = await open();
  const old = await a.status();
  a.close();
  await until(() => !existsSync(join(config.dataDir, 'server.lock')));
  const b = await open();
  assert.notEqual((await b.status()).backend.pid, old.backend.pid);
});

test('long polling stays responsive and offline service permits existing task access and deduplication', async (t) => {
  const { root, open, setHealthy } = await context(t);
  const a = await open();
  const job = await a.submit({
    cwd: root,
    prompt: JSON.stringify({ hold: true }),
    request_id: 'hold',
  });
  await until(async () => (await a.query(job.task.id)).task.event_count >= 4);
  const previous = (await a.query(job.task.id)).task;
  const started = Date.now();
  const poll = a.query(job.task.id, previous.event_count, 50, 500);
  const status = await a.status();
  assert.ok(Date.now() - started < 1500);
  assert.equal(status.counts.running, 1);
  setHealthy(false);
  assert.equal(
    (await a.submit({ cwd: root, prompt: JSON.stringify({ hold: true }), request_id: 'hold' })).task
      .id,
    job.task.id,
  );
  await assert.rejects(a.submit({ cwd: root, prompt: 'new' }), { code: 'service_unavailable' });
  await a.cancel(job.task.id);
  await poll;
  assert.equal((await a.query(job.task.id)).task.state, 'cancelled');
});

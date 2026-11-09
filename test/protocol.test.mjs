import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, until } from './helpers.mjs';

test('official SDK client initializes stdio, lists tools, runs jobs, and reads structured errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-mcp-wire-'));
  const health = http.createServer((_req, res) =>
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })),
  );
  await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js')],
    stderr: 'pipe',
    env: {
      ...process.env,
      CODEX_LOCAL_MCP_BINARY: fixture,
      CODEX_LOCAL_MCP_BASE_URL: `http://127.0.0.1:${health.address().port}/v1`,
      CODEX_LOCAL_MCP_DATA_DIR: join(root, 'data'),
      CODEX_LOCAL_MCP_GRACE_MS: '50',
    },
  });
  let diagnostics = '';
  transport.stderr?.on('data', (data) => (diagnostics += data));
  const client = new Client({ name: 'codex-local-mcp-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => health.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'local_cancel',
    'local_continue',
    'local_status',
    'local_submit',
    'local_task',
  ]);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const status = await call('local_status');
  assert.equal(status.structuredContent.max_concurrency, 4);
  const submitted = await call('local_submit', {
    cwd: root,
    prompt: JSON.stringify({ answer: 'wire-ok' }),
    request_id: 'wire',
  });
  const id = submitted.structuredContent.task.id;
  let result;
  await until(async () => {
    result = await call('local_task', { task_id: id });
    return result.structuredContent.task.state === 'succeeded';
  });
  assert.equal(result.structuredContent.task.final_message, 'wire-ok');
  assert.ok(result.structuredContent.events.length > 0);
  const resumed = await call('local_continue', {
    task_id: id,
    prompt: JSON.stringify({ answer: 'resumed' }),
  });
  await until(
    async () =>
      (await call('local_task', { task_id: resumed.structuredContent.task.id })).structuredContent
        .task.state === 'succeeded',
  );
  const missing = await call('local_task', { task_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'task_not_found');
  assert.equal(diagnostics, '');
});

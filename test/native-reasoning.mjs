import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../dist/config.js';
import { stopBackend } from '../dist/backend-client.js';

// Opt-in native CLI contract check. A loopback Responses fixture records actual
// requests from both entry points; no credentials or LAN model are required.
const root = await mkdtemp(join(tmpdir(), 'codex-local-reasoning-'));
const binary = resolve(process.env.CODEX_LOCAL_TEST_BINARY ?? 'examples/codex-local.sh');
const requests = [];
const service = http.createServer(async (request, reply) => {
  if (request.url === '/v1/models' && request.method === 'GET') {
    reply.end(JSON.stringify({ data: [{ id: 'reasoning-fixture' }] }));
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'REASONING_OK', annotations: [] }],
  };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'REASONING_OK',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.end(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(''),
  );
});
await new Promise((resolveListen) => service.listen(0, '127.0.0.1', resolveListen));
const baseUrl = `http://127.0.0.1:${service.address().port}/v1`;
const home = join(root, 'home');
await mkdir(home);
const env = {
  ...process.env,
  CODEX_HOME: home,
  XDG_CACHE_HOME: join(root, 'cache'),
  CODEX_LOCAL_BASE_URL: baseUrl,
  CODEX_LOCAL_BACKUP_BASE_URL: '',
  CODEX_LOCAL_MCP_BASE_URL: baseUrl,
  CODEX_LOCAL_MCP_BACKUP_BASE_URL: '',
  CODEX_LOCAL_MCP_ENDPOINTS_FILE: join(root, 'endpoints.json'),
  CODEX_LOCAL_MCP_DATA_DIR: join(root, 'data'),
  CODEX_LOCAL_MCP_BINARY: binary,
  CODEX_LOCAL_MCP_TIMEOUT_MS: '30000',
};
const client = new Client({ name: 'native-reasoning-test', version: '1.0.0' });
try {
  const child = spawn(
    binary,
    [
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '-a',
      'never',
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      root,
      '--json',
      'Reply REASONING_OK.',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('close', resolveExit);
      child.once('error', reject);
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /REASONING_OK/);
  } finally {
    clearTimeout(timer);
  }
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js')],
      env,
      stderr: 'pipe',
    }),
  );
  const submitted = await client.callTool({
    name: 'local_submit',
    arguments: { cwd: root, prompt: 'Reply REASONING_OK.' },
  });
  assert.ok(!submitted.isError, JSON.stringify(submitted.structuredContent));
  let task;
  do {
    const page = await client.callTool({
      name: 'local_task',
      arguments: { task_id: submitted.structuredContent.task.id, wait_ms: 1000 },
    });
    task = page.structuredContent.task;
  } while (['queued', 'running'].includes(task.state));
  assert.equal(task.state, 'succeeded', JSON.stringify(task));
  assert.equal(task.final_message.trim(), 'REASONING_OK');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      request.reasoning?.effort,
      'xhigh',
      JSON.stringify({ reasoning: request.reasoning }),
    );
    assert.ok(!request.reasoning.summary || request.reasoning.summary === 'none');
  }
  console.log(
    JSON.stringify({
      passed: true,
      standalone_effort: requests[0].reasoning.effort,
      mcp_effort: requests[1].reasoning.effort,
    }),
  );
} finally {
  await client.close();
  await stopBackend(loadConfig(env));
  await new Promise((resolveClose) => service.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}

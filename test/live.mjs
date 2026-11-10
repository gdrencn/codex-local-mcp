import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../dist/config.js';
import { stopBackend } from '../dist/backend-client.js';

// This check deliberately requires an explicitly configured service endpoint.
if (!process.env.CODEX_LOCAL_MCP_BASE_URL)
  throw new Error(
    'Set CODEX_LOCAL_MCP_BASE_URL to the same /v1 endpoint used by your codex-local launcher.',
  );
const root = await mkdtemp(join(tmpdir(), 'codex-local-mcp-live-'));
const client = new Client({ name: 'codex-local-mcp-live-check', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/cli.js')],
  stderr: 'pipe',
  env: {
    ...process.env,
    CODEX_LOCAL_MCP_DATA_DIR: join(root, 'state'),
    CODEX_LOCAL_MCP_ENDPOINTS_FILE: join(root, 'endpoints.json'),
    CODEX_LOCAL_MCP_TIMEOUT_MS: '180000',
  },
});
transport.stderr?.on('data', (data) => process.stderr.write(data));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent;
};
async function wait(id) {
  let cursor = 0;
  const events = [];
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const result = await call('local_task', { task_id: id, cursor, wait_ms: 1000 });
    cursor = result.next_cursor;
    events.push(...result.events);
    if (!['queued', 'running'].includes(result.task.state)) {
      assert.equal(result.task.state, 'succeeded', JSON.stringify(result.task));
      return { ...result.task, events };
    }
  }
  throw new Error('Live task did not finish within the check deadline');
}
function testImage() {
  const w = 320,
    h = 180,
    data = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let rgb = [255, 255, 255];
      if (x >= 25 && x < 125 && y >= 40 && y < 140) rgb = [230, 20, 20];
      if ((x - 235) ** 2 + (y - 90) ** 2 < 2500) rgb = [20, 40, 230];
      rgb.forEach((v, i) => (data[y * (w * 3 + 1) + 1 + x * 3 + i] = v));
    }
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const name = Buffer.from(type),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, payload])));
    return Buffer.concat([length, name, payload, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(data)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

try {
  await client.connect(transport);
  const status = await call('local_status');
  assert.equal(status.service.available, true);
  console.log(JSON.stringify({ phase: 'connected', max_concurrency: status.max_concurrency }));
  const fixtures = await Promise.all(
    [1, 2].map(async (index) => {
      const cwd = join(root, `worker-${index}`);
      await mkdir(cwd);
      const token = `FILE_${randomBytes(12).toString('hex')}`;
      await writeFile(join(cwd, 'verification.txt'), token + '\n');
      return { cwd, token };
    }),
  );
  const jobs = await Promise.all(
    fixtures.map(({ cwd }) =>
      call('local_submit', {
        cwd,
        prompt:
          'Read verification.txt once using a local shell tool, then reply only with its token.',
      }),
    ),
  );
  console.log(
    JSON.stringify({ phase: 'parallel_submitted', task_ids: jobs.map((job) => job.task.id) }),
  );
  const results = await Promise.all(jobs.map((job) => wait(job.task.id)));
  results.forEach((task, i) => {
    assert.equal(task.final_message.trim(), fixtures[i].token);
    assert.ok(task.events.some((event) => event.detail?.item?.type === 'command_execution'));
  });
  assert.notEqual(results[0].session_id, results[1].session_id);
  assert.ok(
    Math.max(...results.map((task) => Date.parse(task.started_at))) <
      Math.min(...results.map((task) => Date.parse(task.ended_at))),
  );
  console.log(
    JSON.stringify({
      phase: 'parallel_passed',
      elapsed_ms: results.map((task) => task.elapsed_ms),
    }),
  );
  const followup = await call('local_continue', {
    task_id: results[0].id,
    prompt: 'What token did you just read? Do not use tools. Reply only with that token.',
  });
  const resumed = await wait(followup.task.id);
  assert.equal(resumed.session_id, results[0].session_id);
  assert.equal(resumed.final_message.trim(), fixtures[0].token);
  console.log(JSON.stringify({ phase: 'continuation_passed' }));
  const editDir = join(root, 'edit');
  await mkdir(editDir);
  const editToken = `EDIT_${randomBytes(8).toString('hex')}`;
  const edit = await call('local_submit', {
    cwd: editDir,
    sandbox: 'workspace-write',
    prompt: `This temporary workspace edit is authorized. Create result.txt containing exactly ${editToken} followed by one newline. Verify by reading it with a local tool. Finish with EDIT_DONE.`,
  });
  const edited = await wait(edit.task.id);
  assert.equal(await readFile(join(editDir, 'result.txt'), 'utf8'), editToken + '\n');
  assert.ok(edited.events.some((event) => event.detail?.item?.type === 'command_execution'));
  console.log(JSON.stringify({ phase: 'workspace_edit_passed' }));
  const image = join(root, 'shapes.png');
  await writeFile(image, testImage());
  const vision = await call('local_submit', {
    cwd: root,
    images: [image],
    prompt:
      'Describe the shape and color on the left and on the right of the attached image. Answer in one short English sentence. Do not use tools.',
  });
  const viewed = await wait(vision.task.id);
  const answer = viewed.final_message.toLowerCase();
  for (const word of ['red', 'square', 'blue', 'circle'])
    assert.ok(answer.includes(word), viewed.final_message);
  console.log(JSON.stringify({ phase: 'image_passed', answer: viewed.final_message }));

  const sleeper = await call('local_submit', {
    cwd: root,
    prompt: 'Use the local shell tool to run sleep 30. After it finishes, reply SLEEP_DONE.',
  });
  let cursor = 0,
    sawSleep = false;
  const untilSleep = Date.now() + 120000;
  while (Date.now() < untilSleep && !sawSleep) {
    const page = await call('local_task', { task_id: sleeper.task.id, cursor, wait_ms: 1000 });
    cursor = page.next_cursor;
    sawSleep = page.events.some((event) => /sleep 30/.test(event.detail?.item?.command ?? ''));
    assert.ok(['queued', 'running'].includes(page.task.state), JSON.stringify(page.task));
  }
  assert.ok(sawSleep, 'Worker did not start the expected local sleep command');
  const survivor = await call('local_submit', {
    cwd: root,
    prompt: 'Do not use tools. Reply exactly SURVIVOR_OK.',
  });
  const cancelled = await call('local_cancel', { task_id: sleeper.task.id });
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal((await wait(survivor.task.id)).final_message.trim(), 'SURVIVOR_OK');
  console.log(JSON.stringify({ phase: 'independent_cancellation_passed' }));

  const deadlineTask = await call('local_submit', {
    cwd: root,
    timeout_ms: 1500,
    prompt: 'Use the local shell tool to run sleep 30. After it finishes, reply SLEEP_DONE.',
  });
  let timed;
  const untilTimeout = Date.now() + 30000;
  while (Date.now() < untilTimeout) {
    timed = await call('local_task', { task_id: deadlineTask.task.id, wait_ms: 1000 });
    if (!['queued', 'running'].includes(timed.task.state)) break;
  }
  assert.equal(timed.task.state, 'timed_out');
  console.log(JSON.stringify({ phase: 'execution_timeout_passed' }));

  const duplicateInput = {
    cwd: root,
    prompt: 'Do not use tools. Reply exactly DEDUPE_OK.',
    request_id: 'live-idempotency',
  };
  const [one, two] = await Promise.all([
    call('local_submit', duplicateInput),
    call('local_submit', duplicateInput),
  ]);
  assert.equal(one.task.id, two.task.id);
  assert.equal((await wait(one.task.id)).final_message.trim(), 'DEDUPE_OK');
  const missing = await client.callTool({
    name: 'local_task',
    arguments: { task_id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'task_not_found');
  console.log(JSON.stringify({ phase: 'idempotency_and_errors_passed' }));
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'parallel_native_tools',
        'explicit_session_continuation',
        'workspace_edit',
        'image_input',
        'independent_cancellation',
        'execution_timeout',
        'idempotency_and_errors',
      ],
    }),
  );
} finally {
  await client.close();
  await stopBackend(loadConfig({ ...process.env, CODEX_LOCAL_MCP_DATA_DIR: join(root, 'state') }));
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { stopBackend } from '../dist/backend-client.js';

// Opt-in: uses the registered ChatGPT-backed Codex, isolated task/address files,
// and a loopback health fixture. No model inference or user endpoint edits.
const root = await mkdtemp(join(tmpdir(), 'codex-local-native-recovery-'));
const file = join(root, 'endpoints.json');
const dataDir = join(root, 'data');
let healthy = false;
const service = http.createServer((_request, response) => {
  response.end(JSON.stringify({ data: healthy ? [{ id: 'health-fixture' }] : [] }));
});
await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
const primary = `http://127.0.0.1:${service.address().port}/v1`;
await writeFile(file, JSON.stringify({ primary, backup: null }));

async function run(prompt) {
  const child = spawn(
    'codex',
    [
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '-a',
      'never',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      `mcp_servers.codex_local.env.CODEX_LOCAL_MCP_DATA_DIR=${JSON.stringify(dataDir)}`,
      '-c',
      `mcp_servers.codex_local.env.CODEX_LOCAL_MCP_ENDPOINTS_FILE=${JSON.stringify(file)}`,
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      tmpdir(),
      '--json',
      prompt,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already closed. */
    }
  }, 120000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, stderr);
    const items = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'item.completed')
      .map((event) => event.item);
    assert.ok(
      !items.some((item) => item.type === 'command_execution'),
      'Main agent must use MCP rather than shell',
    );
    return {
      items,
      tools: items.filter((item) => item.type === 'mcp_tool_call' && item.server === 'codex_local'),
      answer: items
        .filter((item) => item.type === 'agent_message')
        .map((item) => item.text)
        .join('\n'),
    };
  } finally {
    clearTimeout(timer);
  }
}

try {
  const offline = await run(
    '执行授权的只读检查：仅通过 codex_local MCP 的 local_status 检查本地模型服务。服务无法使用时按 MCP 指引在本对话中询问我提供可用的 IP 和端口，然后结束当前回复等待我回答。不要猜测或修改服务地址，不要提交任务，不要使用 shell。请用中文回复。',
  );
  assert.ok(offline.tools.some((item) => item.tool === 'local_status'));
  assert.ok(!offline.tools.some((item) => item.tool === 'local_set_service'));
  assert.match(offline.answer, /IP|地址/);
  assert.match(offline.answer, /端口/);
  console.log(JSON.stringify({ phase: 'user_question_verified', answer: offline.answer }));
  healthy = true;
  const recovered = await run(
    `这是用户对服务地址问题的答复：可用地址为 ${primary}，不要备用地址。我明确授权你调用 codex_local MCP 的 local_set_service 验证并保存该 primary，backup 设为 null，然后用 local_status 检查。不要提交推理任务，不要使用 shell。成功后回复 RECOVERY_OK。`,
  );
  assert.ok(recovered.tools.some((item) => item.tool === 'local_set_service'));
  assert.ok(recovered.tools.some((item) => item.tool === 'local_status'));
  assert.match(recovered.answer, /RECOVERY_OK/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { primary, backup: null });
  console.log(
    JSON.stringify({ passed: true, user_question_verified: true, verified_live_recovery: true }),
  );
} finally {
  await stopBackend(loadConfig({ ...process.env, CODEX_LOCAL_MCP_DATA_DIR: dataDir }));
  await new Promise((resolve) => service.close(resolve));
  await rm(root, { recursive: true, force: true });
}

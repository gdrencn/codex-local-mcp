import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Opt-in test of the user's registered MCP and main ChatGPT-backed Codex.
// It does not change account/configuration or set a tool-approval override.
const root = await mkdtemp(join(tmpdir(), 'codex-local-main-client-'));
const token = `NATIVE_${randomBytes(12).toString('hex')}`;
await writeFile(join(root, 'verification.txt'), token + '\n');
const prompt = `Execute this authorized read-only test through the registered codex_local MCP. Do not read files yourself or call a shell tool. Call local_status, then local_submit with cwd ${root} and prompt "Read verification.txt once using a local shell tool, then reply only with its token." Poll local_task until succeeded. Finish with only the worker's token. Do not change configuration.`;
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
child.stdout.on('data', (data) => {
  stdout += data;
});
child.stderr.on('data', (data) => {
  stderr = (stderr + data).slice(-8192);
});
const timer = setTimeout(() => process.kill(-child.pid, 'SIGTERM'), 240000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  assert.equal(code, 0, stderr);
  const events = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const items = events
    .filter((event) => event.type === 'item.completed')
    .map((event) => event.item);
  const tools = new Set(
    items
      .filter((item) => item.type === 'mcp_tool_call' && item.server === 'codex_local')
      .map((item) => item.tool),
  );
  assert.ok(
    ['local_status', 'local_submit', 'local_task'].every((name) => tools.has(name)),
    stdout,
  );
  assert.ok(
    items.some((item) => item.type === 'agent_message' && item.text.trim() === token),
    stdout,
  );
  assert.ok(
    !items.some((item) => item.type === 'command_execution'),
    'Main agent must not read the fixture itself',
  );
  console.log(
    JSON.stringify({ passed: true, tools: [...tools], exact_worker_token_verified: true }),
  );
} finally {
  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}

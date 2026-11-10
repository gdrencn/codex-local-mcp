import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasJq = spawnSync('jq', ['--version']).status === 0;
async function context(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'codex'),
    `#!/usr/bin/env node
let input = ''; for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),pid:process.pid,no_proxy:process.env.NO_PROXY}));
process.exitCode = Number(process.env.PROBE_EXIT ?? 0);
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, 'curl'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const url = process.argv.at(-1);
appendFileSync(process.env.PROBE_LOG, url+'\\n');
const response = JSON.parse(process.env.PROBE_ROUTES)[url];
if (!response) process.exit(7);
console.log(typeof response === 'string' ? response : JSON.stringify(response));
`,
    { mode: 0o755 },
  );
  const primary = 'http://primary.example:8080/v1';
  const backup = 'http://backup.example:8081/v1';
  const file = join(root, 'endpoints.json');
  await writeFile(file, JSON.stringify({ primary, backup }));
  const routes = {
    [`${primary}/models`]: { data: [{ id: 'primary-model' }] },
    [`${backup}/models`]: { data: [{ id: 'backup-model' }] },
  };
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    XDG_CACHE_HOME: join(root, 'cache'),
    CODEX_LOCAL_MCP_ENDPOINTS_FILE: file,
    PROBE_LOG: join(root, 'probes'),
    PROBE_ROUTES: JSON.stringify(routes),
    NO_PROXY: 'localhost',
  };
  delete env.CODEX_LOCAL_BASE_URL;
  delete env.CODEX_LOCAL_BACKUP_BASE_URL;
  delete env.CODEX_LOCAL_ENDPOINTS_FILE;
  const run = (args = [], input = '', overrides = {}) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(resolve('examples/codex-local.sh'), args, {
        cwd: root,
        env: { ...env, ...overrides },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        try {
          const result = JSON.parse(stdout);
          const configs = result.args.flatMap((arg, index) =>
            arg === '-c' ? [result.args[index + 1]] : [],
          );
          const value = (name) =>
            JSON.parse(configs.find((text) => text.startsWith(`${name}=`)).slice(name.length + 1));
          resolveRun({
            ...result,
            code,
            stderr,
            model: value('model'),
            catalog: value('model_catalog_json'),
            provider: configs.find((text) => text.startsWith('model_providers.')),
            launcher_pid: child.pid,
          });
        } catch (error) {
          reject(new Error(`${error}: ${stderr}`));
        }
      });
      child.stdin.end(input);
    });
  const probes = async () => {
    try {
      return (await readFile(env.PROBE_LOG, 'utf8')).trim().split('\n');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return { root, file, primary, backup, routes, run, probes };
}

test(
  'shell launcher chooses primary, then backup with its own model and catalog',
  { skip: !hasJq },
  async (t) => {
    const { primary, backup, routes, run, probes } = await context(t);
    const first = await run(['exec', 'hello']);
    assert.equal(first.model, 'primary-model');
    assert.ok(first.provider.includes(`base_url="${primary}"`));
    assert.deepEqual(await probes(), [`${primary}/models`]);
    delete routes[`${primary}/models`];
    const fallback = await run(['exec', 'hello'], '', { PROBE_ROUTES: JSON.stringify(routes) });
    assert.equal(fallback.model, 'backup-model');
    assert.ok(fallback.provider.includes(`base_url="${backup}"`));
    assert.equal(
      JSON.parse(await readFile(fallback.catalog, 'utf8')).models[0].slug,
      'backup-model',
    );
    assert.equal(fallback.no_proxy, 'localhost,backup.example');
    assert.notEqual(first.catalog, fallback.catalog);
  },
);

test(
  'shell launcher honors worker pinning even when a saved backup is healthy',
  { skip: !hasJq },
  async (t) => {
    const { primary, routes, run, probes } = await context(t);
    delete routes[`${primary}/models`];
    const result = await run(['exec', 'hello'], '', {
      CODEX_LOCAL_BASE_URL: primary,
      CODEX_LOCAL_BACKUP_BASE_URL: '',
      PROBE_ROUTES: JSON.stringify(routes),
    });
    assert.deepEqual(await probes(), [`${primary}/models`]);
    assert.equal(result.model, 'codex-local');
    assert.match(result.stderr, /provide a working IP/);
    assert.ok(result.provider.includes(`base_url="${primary}"`));
  },
);

test(
  'offline help skips probes and native arguments, stdin, cwd, process identity and exit status pass through',
  { skip: !hasJq },
  async (t) => {
    const { root, run, probes } = await context(t);
    await run(['exec', '--help']);
    assert.deepEqual(await probes(), []);
    const args = [
      'exec',
      '--json',
      '',
      `a 'quote' and "double"`,
      '$(do-not-run); `literal`',
      'line one\nline two',
      '-c',
      'model="override"',
    ];
    const result = await run(args, 'stdin payload\n', { PROBE_EXIT: '23' });
    assert.deepEqual(result.args.slice(-args.length), args);
    assert.equal(result.input, 'stdin payload\n');
    assert.equal(result.cwd, root);
    assert.equal(result.pid, result.launcher_pid);
    assert.equal(result.code, 23);
  },
);

test(
  'offline backup discovery never contaminates primary model cache',
  { skip: !hasJq },
  async (t) => {
    const { primary, routes, run } = await context(t);
    const original = await run(['exec', 'hello']);
    delete routes[`${primary}/models`];
    await run(['exec', 'hello'], '', { PROBE_ROUTES: JSON.stringify(routes) });
    const offline = await run(['exec', 'hello'], '', { PROBE_ROUTES: '{}' });
    assert.equal(offline.model, original.model);
    assert.equal(offline.catalog, original.catalog);
  },
);

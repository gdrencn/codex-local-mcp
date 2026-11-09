import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkService } from '../dist/health.js';
import { loadConfig } from '../dist/config.js';

test('health validates model-list responses and enforces a total deadline', async (t) => {
  let mode = 'valid';
  const server = http.createServer((_req, res) => {
    if (mode === 'trickle') {
      const timer = setInterval(() => res.write(' '), 10);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(mode === 'valid' ? JSON.stringify({ data: [{ id: 'model' }] }) : 'invalid');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  assert.equal((await checkService(url, 100)).available, true);
  mode = 'invalid';
  assert.equal((await checkService(url, 100)).available, false);
  mode = 'trickle';
  const start = Date.now();
  assert.equal((await checkService(url, 100)).available, false);
  assert.ok(Date.now() - start < 1000);
});

test('configuration rejects unsupported limits and unsafe URL formats', () => {
  assert.equal(loadConfig({}).maxConcurrency, 4);
  assert.throws(() => loadConfig({ CODEX_LOCAL_MCP_MAX_CONCURRENCY: '0' }));
  assert.throws(() => loadConfig({ CODEX_LOCAL_MCP_BASE_URL: 'file:///tmp/models' }));
  assert.throws(() => loadConfig({ CODEX_LOCAL_MCP_SERVER_ID: 'invalid.key' }));
});

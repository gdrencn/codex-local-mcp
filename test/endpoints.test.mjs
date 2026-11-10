import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointRegistry, normalizeEndpoint } from '../dist/endpoints.js';
import { loadConfig } from '../dist/config.js';

async function context(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-local-endpoints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probes = [];
  const servers = [];
  const server = async (name) => {
    let mode = 'valid';
    const listener = http.createServer((request, response) => {
      probes.push(name);
      assert.equal(request.url, '/v1/models');
      if (mode === 'timeout') return;
      response.statusCode = mode === 'http-error' ? 503 : 200;
      response.end(
        mode === 'invalid'
          ? 'invalid'
          : JSON.stringify({ data: mode === 'no-id' ? [{}] : [{ id: name }] }),
      );
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    servers.push(listener);
    return {
      url: `http://127.0.0.1:${listener.address().port}/v1`,
      mode: (value) => {
        mode = value;
      },
    };
  };
  t.after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
  });
  const primary = await server('primary');
  const backup = await server('backup');
  const config = {
    ...loadConfig({}),
    baseUrl: primary.url,
    backupUrl: backup.url,
    endpointsFile: join(root, 'endpoints.json'),
    healthTimeoutMs: 80,
  };
  return { primary, backup, probes, config, registry: new EndpointRegistry(config) };
}

test('endpoint input accepts IP:port, IPv6, default ports and URL prefixes; rejects ambiguous or unsafe input', () => {
  assert.equal(normalizeEndpoint(' 127.0.0.1:8080 '), 'http://127.0.0.1:8080/v1');
  assert.equal(normalizeEndpoint('127.0.0.1:80'), 'http://127.0.0.1/v1');
  assert.equal(normalizeEndpoint('[::1]:8080'), 'http://[::1]:8080/v1');
  assert.equal(
    normalizeEndpoint('https://example.test/prefix/v1/'),
    'https://example.test/prefix/v1',
  );
  for (const input of [
    'localhost',
    'file:///tmp/models',
    'http://user:password@localhost:1234',
    'http://localhost/?key=secret',
    'http://localhost/#fragment',
  ]) {
    assert.throws(() => normalizeEndpoint(input), { code: 'invalid_endpoint' });
  }
});

test('primary success does not contact backup; invalid, empty, HTTP error and timed-out primary fall back in order', async (t) => {
  const { primary, backup, probes, registry } = await context(t);
  const healthy = await registry.check();
  assert.equal(healthy.active_base_url, primary.url);
  assert.equal(healthy.using_backup, false);
  assert.deepEqual(probes.splice(0), ['primary']);
  for (const mode of ['invalid', 'no-id', 'http-error', 'timeout']) {
    primary.mode(mode);
    const fallback = await registry.check();
    assert.equal(fallback.active_base_url, backup.url);
    assert.equal(fallback.using_backup, true);
    assert.deepEqual(probes.splice(0), ['primary', 'backup']);
    assert.deepEqual(
      fallback.attempts.map((attempt) => attempt.available),
      [false, true],
    );
  }
});

test('all-down result directs the calling agent to ask the user and identifies the recovery tool', async (t) => {
  const { primary, backup, registry } = await context(t);
  primary.mode('no-id');
  backup.mode('http-error');
  const status = await registry.check();
  assert.equal(status.available, false);
  assert.equal(status.active_base_url, null);
  assert.equal(status.requires_user_input, true);
  assert.equal(status.next_action, 'ask_user_for_service_address');
  assert.equal(status.recovery_tool, 'local_set_service');
  assert.match(status.user_prompt, /IP/);
  assert.equal(status.attempts.length, 2);
});

test('verified updates persist atomically, preserve or clear backup, and never accept a failed primary via a healthy backup', async (t) => {
  const { primary, backup, config, registry } = await context(t);
  const result = await registry.set({ primary: primary.url });
  assert.deepEqual(result.endpoints, { primary: primary.url, backup: backup.url });
  assert.equal((await stat(config.endpointsFile)).mode & 0o777, 0o600);
  const original = await readFile(config.endpointsFile, 'utf8');
  primary.mode('http-error');
  await assert.rejects(
    registry.set({ primary: primary.url }),
    (error) => error.code === 'service_unavailable' && error.details.requires_user_input,
  );
  assert.equal(await readFile(config.endpointsFile, 'utf8'), original);
  await registry.set({ primary: backup.url, backup: null });
  assert.deepEqual(registry.current(), { primary: backup.url, backup: null });
  await registry.set({ primary: backup.url, backup: backup.url });
  assert.equal(registry.current().backup, null);
});

test('invalid saved configuration is reported and a verified update repairs it live', async (t) => {
  const { primary, config, registry } = await context(t);
  await writeFile(config.endpointsFile, 'invalid json');
  assert.equal((await registry.check()).requires_user_input, true);
  await registry.set({ primary: primary.url, backup: null });
  assert.equal((await registry.check()).available, true);
});

import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface Config {
  binary: string;
  baseUrl: string;
  dataDir: string;
  maxConcurrency: number;
  maxQueue: number;
  defaultTimeoutMs: number;
  graceMs: number;
  healthTimeoutMs: number;
  maxLogBytes: number;
  mcpServerId: string;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be an integer in ${min}..${max}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (process.platform !== 'linux')
    throw new Error('The initial process supervisor supports Linux only.');
  const baseUrl = (env.CODEX_LOCAL_MCP_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'CODEX_LOCAL_MCP_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment',
    );
  }
  const mcpServerId = env.CODEX_LOCAL_MCP_SERVER_ID ?? 'codex_local';
  if (!/^[A-Za-z0-9_-]+$/.test(mcpServerId)) throw new Error('Invalid CODEX_LOCAL_MCP_SERVER_ID');
  return {
    binary: env.CODEX_LOCAL_MCP_BINARY ?? 'codex-local',
    baseUrl,
    dataDir: resolve(
      env.CODEX_LOCAL_MCP_DATA_DIR ??
        join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'codex-local-mcp'),
    ),
    maxConcurrency: integer(env, 'CODEX_LOCAL_MCP_MAX_CONCURRENCY', 4, 1, 64),
    maxQueue: integer(env, 'CODEX_LOCAL_MCP_MAX_QUEUE', 16, 0, 10000),
    defaultTimeoutMs: integer(env, 'CODEX_LOCAL_MCP_TIMEOUT_MS', 600000, 100, 86400000),
    graceMs: integer(env, 'CODEX_LOCAL_MCP_GRACE_MS', 2000, 10, 30000),
    healthTimeoutMs: integer(env, 'CODEX_LOCAL_MCP_HEALTH_TIMEOUT_MS', 3000, 50, 30000),
    maxLogBytes: integer(env, 'CODEX_LOCAL_MCP_MAX_LOG_BYTES', 16777216, 4096, 1073741824),
    mcpServerId,
  };
}

export function resolveExecutable(binary: string, path = process.env.PATH ?? ''): string {
  const candidates =
    isAbsolute(binary) || binary.includes('/')
      ? [resolve(binary)]
      : path.split(delimiter).map((dir) => join(dir, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Worker executable not found or not executable: ${binary}`);
}

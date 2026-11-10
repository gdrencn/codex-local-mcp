import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { resolveExecutable } from './config.js';
import { VERSION } from './version.js';

export interface BackendRequest {
  id: string;
  method: string;
  params: unknown;
}
export interface BackendReply {
  id: string;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
export const MAX_FRAME = 4 * 1024 * 1024;

export function prepareBackend(
  config: Config,
  resolveBinary = true,
): { config: Config; socketPath: string; signature: string } {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const normalized = {
    ...config,
    dataDir: realpathSync(config.dataDir),
    binary: resolveBinary ? resolveExecutable(config.binary) : config.binary,
  };
  const uid = process.getuid!();
  const runtime = join(tmpdir(), `codex-local-mcp-${uid}`);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const info = statSync(runtime);
  if (info.uid !== uid || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error(`Expected a private runtime directory owned by the current user: ${runtime}`);
  }
  chmodSync(runtime, 0o700);
  const key = createHash('sha256').update(normalized.dataDir).digest('hex').slice(0, 24);
  const socketPath = join(runtime, `${key}.sock`);
  if (Buffer.byteLength(socketPath) > 100)
    throw new Error('Unix socket path is too long; use a shorter TMPDIR');
  const signature = createHash('sha256')
    .update(JSON.stringify({ version: VERSION, ...normalized }))
    .digest('hex');
  return { config: normalized, socketPath, signature };
}

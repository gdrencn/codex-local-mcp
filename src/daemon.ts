import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { MAX_FRAME, prepareBackend, type BackendRequest } from './backend-protocol.js';
import { loadConfig } from './config.js';
import {
  cancelSchema,
  continueSchema,
  querySchema,
  statusSchema,
  submitSchema,
} from './contracts.js';
import { TaskError } from './domain.js';
import { TaskManager } from './manager.js';
import { clip, JsonLineDecoder } from './output.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const { config, socketPath, signature } = prepareBackend(loadConfig());
  const manager = new TaskManager(config);
  const clients = new Set<net.Socket>();
  let closing = false;
  let idle: NodeJS.Timeout | undefined;
  let shutdown: Promise<void> | undefined;

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'hello': {
        if ((params as { signature?: string } | null)?.signature !== signature) {
          throw new TaskError(
            'configuration_mismatch',
            'Shared backend uses another version or configuration. Stop it with --stop-backend, then reopen MCP connections; alternatively choose another data directory.',
          );
        }
        return { pid: process.pid, version: VERSION };
      }
      case 'status': {
        statusSchema.parse(params);
        return {
          ...(await manager.status()),
          backend: { pid: process.pid, version: VERSION, shared: true },
        };
      }
      case 'submit':
        return manager.submit(submitSchema.parse(params));
      case 'query': {
        const value = querySchema.parse(params);
        return manager.query(value.task_id, value.cursor, value.limit, value.wait_ms);
      }
      case 'cancel':
        return manager.cancel(cancelSchema.parse(params).task_id);
      case 'continue': {
        const value = continueSchema.parse(params);
        return manager.continue(value.task_id, value);
      }
      default:
        throw new TaskError('unknown_method', 'Unknown backend method');
    }
  }

  const server = net.createServer((socket) => {
    if (closing || clients.size >= 128) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    if (idle) {
      clearTimeout(idle);
      idle = undefined;
    }
    let inFlight = 0;
    const decoder = new JsonLineDecoder(
      (line) => {
        let request: BackendRequest;
        try {
          request = JSON.parse(line) as BackendRequest;
          if (
            !request ||
            typeof request.id !== 'string' ||
            request.id.length > 128 ||
            typeof request.method !== 'string'
          )
            throw new Error();
        } catch {
          socket.destroy();
          return;
        }
        if (++inFlight > 128) {
          socket.destroy();
          return;
        }
        if (request.method === 'shutdown') {
          socket.write(
            JSON.stringify({ id: request.id, result: { pid: process.pid } }) + '\n',
            () => {
              void stop();
            },
          );
          return;
        }
        void (async () => {
          try {
            if (closing) throw new TaskError('backend_closing', 'Shared backend is shutting down');
            const result = await dispatch(request.method, request.params);
            if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + '\n');
          } catch (error) {
            const detail = {
              code: error instanceof TaskError ? error.code : 'invalid_request',
              message: clip(error instanceof Error ? error.message : String(error)),
            };
            if (!socket.destroyed)
              socket.write(JSON.stringify({ id: request.id, error: detail }) + '\n');
          } finally {
            inFlight--;
          }
        })();
      },
      () => socket.destroy(),
      MAX_FRAME,
    );
    socket.on('data', (chunk: Buffer) => decoder.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
  });

  function stop(): Promise<void> {
    shutdown ??= (async () => {
      closing = true;
      clearInterval(heartbeat);
      if (idle) clearTimeout(idle);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of clients) socket.end();
      // Close the listener before releasing the store lock, so a replacement
      // backend cannot have its new socket unlinked by this instance's close.
      await stopped;
      await manager.shutdown();
    })();
    return shutdown;
  }

  if (existsSync(socketPath)) unlinkSync(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  const heartbeat = setInterval(
    () => {
      if (clients.size || manager.hasWork()) {
        if (idle) {
          clearTimeout(idle);
          idle = undefined;
        }
      } else if (!idle)
        idle = setTimeout(() => {
          void stop();
        }, config.backendIdleMs);
    },
    Math.min(1000, config.backendIdleMs),
  );
  const fatal = (error: unknown) => {
    writeFileSync(
      join(config.dataDir, 'startup-error.json'),
      JSON.stringify({ message: clip(String(error), 4096) }),
      { mode: 0o600 },
    );
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
}

main().catch((error) => {
  if (error instanceof TaskError && error.code === 'store_in_use') return;
  try {
    const config = loadConfig();
    writeFileSync(
      join(config.dataDir, 'startup-error.json'),
      JSON.stringify({ message: clip(String(error), 4096) }),
      { mode: 0o600 },
    );
  } catch {
    /* The connecting client will report a bounded startup failure. */
  }
  process.exitCode = 1;
});

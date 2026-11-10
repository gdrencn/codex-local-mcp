#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { connectBackend, stopBackend } from './backend-client.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`codex-local-mcp ${VERSION}`);
    return;
  }
  if (process.argv.includes('--help')) {
    console.log(
      'codex-local-mcp: stdio MCP bridge for shared parallel Codex workers.\n--stop-backend stops the shared scheduler for this data directory.\nConfigure with CODEX_LOCAL_MCP_* environment variables; see README.md.',
    );
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === '--stop-backend') {
    console.log(
      (await stopBackend(loadConfig())) ? 'Shared backend stopped.' : 'No shared backend running.',
    );
    return;
  }
  if (process.argv.length > 2) throw new Error('Unknown arguments; use --help');
  const manager = await connectBackend(loadConfig());
  const handle = serveStdio(() => createServer(manager), {
    onerror: (error) => console.error(error.message),
  });
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      manager.close();
      await handle.close();
    })());
  const stop = () => {
    void shutdown().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.once('end', stop);
  process.once('uncaughtException', (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
  process.once('unhandledRejection', (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

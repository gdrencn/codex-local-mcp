import { McpServer } from '@modelcontextprotocol/server';
import { TaskError } from './domain.js';
import type { TaskService } from './service.js';
import {
  statusSchema,
  submitSchema,
  querySchema,
  cancelSchema,
  continueSchema,
} from './contracts.js';
import { VERSION } from './version.js';

function toolResult(handler: () => Promise<unknown>) {
  return handler()
    .then((value) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    }))
    .catch((error: unknown) => {
      const detail = {
        code: error instanceof TaskError ? error.code : 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: detail }) }],
        structuredContent: { error: detail },
      };
    });
}

export function createServer(manager: TaskService): McpServer {
  const server = new McpServer(
    { name: 'codex-local-mcp', version: VERSION },
    {
      instructions:
        'Delegate independent bounded tasks with local_submit; clients share four worker slots by default. Poll local_task by task ID and cursor, cancel with local_cancel, and continue with local_continue. Disconnecting does not cancel a task. Workers execute tools on this computer. Use separate worktrees or disjoint write scopes for concurrent edits. Model-list reachability does not prove generation. Do not expose this scheduler to workers.',
    },
  );
  server.registerTool(
    'local_status',
    {
      description:
        'Check worker executable, service reachability, concurrency limits, counts, and recent task IDs.',
      inputSchema: statusSchema,
      annotations: { readOnlyHint: true },
    },
    () => toolResult(() => manager.status()),
  );
  server.registerTool(
    'local_submit',
    {
      description:
        'Submit a bounded local Codex task and immediately receive its task ID. Distinct sessions run concurrently; excess tasks queue. Prompts run read-only unless workspace-write is explicitly requested.',
      inputSchema: submitSchema,
    },
    (input) => toolResult(() => manager.submit(input)),
  );
  server.registerTool(
    'local_task',
    {
      description:
        'Get task state, final answer, usage, and bounded event pages. Use next_cursor on subsequent calls; optional wait_ms long-polls up to 20 seconds.',
      inputSchema: querySchema,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      toolResult(() => manager.query(input.task_id, input.cursor, input.limit, input.wait_ms)),
  );
  server.registerTool(
    'local_cancel',
    {
      description:
        'Cancel one queued or running task. Wait for confirmed worker exit before returning; other tasks remain independent.',
      inputSchema: cancelSchema,
    },
    (input) => toolResult(() => manager.cancel(input.task_id)),
  );
  server.registerTool(
    'local_continue',
    {
      description:
        "Submit a follow-up using a terminal task's explicit Codex session ID, directory, and sandbox. Turns targeting the same session are serialized.",
      inputSchema: continueSchema,
    },
    (input) => toolResult(() => manager.continue(input.task_id, input)),
  );
  return server;
}

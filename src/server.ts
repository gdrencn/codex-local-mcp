import { McpServer } from '@modelcontextprotocol/server';
import { TaskError } from './domain.js';
import type { TaskService } from './service.js';
import {
  statusSchema,
  submitSchema,
  querySchema,
  cancelSchema,
  continueSchema,
  serviceSchema,
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
        ...(error instanceof TaskError ? error.details : {}),
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
        'Check local_status: primary is tried before backup. If requires_user_input is true or service_unavailable occurs, ask the user for a working IP:port in this conversation; after their answer use local_set_service to verify and save it. Never replay a task that already ran tools. Clients share four worker slots. Submit independent tasks, poll local_task by cursor, cancel or continue explicitly. Disconnecting does not cancel work. Use separate worktrees for overlapping edits.',
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
    'local_set_service',
    {
      description:
        'After the user supplies a new service IP:port or URL, verify its primary endpoint and save it for all conversations and the shell launcher. Omitted backup preserves it; null clears it. Failed verification leaves configuration unchanged. Does not retry or replay existing tasks.',
      inputSchema: serviceSchema,
    },
    (input) => toolResult(() => manager.setService(input)),
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

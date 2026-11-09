import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TaskError } from './domain.js';
import type { TaskManager } from './manager.js';

const taskId = z.string().uuid();
const prompt = z.string().min(1).max(131072);
const images = z.array(z.string().min(1)).max(16).optional();
const timeout_ms = z.number().int().min(100).max(86400000).optional();
const request_id = z.string().min(1).max(128).optional();

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

export function createServer(manager: TaskManager): McpServer {
  const server = new McpServer(
    { name: 'codex-local-mcp', version: '0.1.0' },
    {
      instructions:
        'Delegate independent bounded tasks with local_submit; up to four workers run by default. Poll local_task by task ID and cursor, cancel with local_cancel, and continue an explicit completed task with local_continue. Workers execute tools on this computer. Supply separate worktrees or disjoint write scopes for concurrent edits. A reachable model list does not prove generation works. Do not expose this scheduler to its workers.',
    },
  );
  server.registerTool(
    'local_status',
    {
      description:
        'Check worker executable, service reachability, concurrency limits, counts, and recent task IDs.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () => toolResult(() => manager.status()),
  );
  server.registerTool(
    'local_submit',
    {
      description:
        'Submit a bounded local Codex task and immediately receive its task ID. Distinct sessions run concurrently; excess tasks queue. Prompts run read-only unless workspace-write is explicitly requested.',
      inputSchema: z
        .object({
          prompt,
          cwd: z.string().min(1),
          sandbox: z.enum(['read-only', 'workspace-write']).optional(),
          images,
          timeout_ms,
          request_id,
        })
        .strict(),
    },
    (input) => toolResult(() => manager.submit(input)),
  );
  server.registerTool(
    'local_task',
    {
      description:
        'Get task state, final answer, usage, and bounded event pages. Use next_cursor on subsequent calls; optional wait_ms long-polls up to 20 seconds.',
      inputSchema: z
        .object({
          task_id: taskId,
          cursor: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          wait_ms: z.number().int().min(0).max(20000).optional(),
        })
        .strict(),
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
      inputSchema: z.object({ task_id: taskId }).strict(),
    },
    (input) => toolResult(() => manager.cancel(input.task_id)),
  );
  server.registerTool(
    'local_continue',
    {
      description:
        "Submit a follow-up using a terminal task's explicit Codex session ID, directory, and sandbox. Turns targeting the same session are serialized.",
      inputSchema: z.object({ task_id: taskId, prompt, images, timeout_ms, request_id }).strict(),
    },
    (input) => toolResult(() => manager.continue(input.task_id, input)),
  );
  return server;
}

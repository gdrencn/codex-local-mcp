import * as z from 'zod/v4';

const taskId = z.string().uuid();
const prompt = z.string().min(1).max(131072);
const images = z.array(z.string().min(1)).max(16).optional();
const timeout_ms = z.number().int().min(100).max(86400000).optional();
const request_id = z.string().min(1).max(128).optional();

export const statusSchema = z.object({}).strict();
export const serviceSchema = z
  .object({
    primary: z.string().min(1).max(2048),
    backup: z.string().min(1).max(2048).nullable().optional(),
  })
  .strict();
export const submitSchema = z
  .object({
    prompt,
    cwd: z.string().min(1),
    sandbox: z.enum(['read-only', 'workspace-write']).optional(),
    images,
    timeout_ms,
    request_id,
  })
  .strict();
export const querySchema = z
  .object({
    task_id: taskId,
    cursor: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    wait_ms: z.number().int().min(0).max(20000).optional(),
  })
  .strict();
export const cancelSchema = z.object({ task_id: taskId }).strict();
export const continueSchema = z
  .object({ task_id: taskId, prompt, images, timeout_ms, request_id })
  .strict();

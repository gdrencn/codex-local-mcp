export type Sandbox = 'read-only' | 'workspace-write';
export type TaskState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export const isTerminal = (state: TaskState): boolean => state !== 'queued' && state !== 'running';

export class TaskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface Submission {
  prompt: string;
  cwd: string;
  sandbox?: Sandbox | undefined;
  images?: string[] | undefined;
  timeout_ms?: number | undefined;
  request_id?: string | undefined;
}

export interface Task {
  id: string;
  state: TaskState;
  prompt: string;
  cwd: string;
  sandbox: Sandbox;
  images: string[];
  timeout_ms: number;
  request_id: string | null;
  fingerprint: string;
  parent_task_id: string | null;
  resume_session_id: string | null;
  session_id: string | null;
  service_url?: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  pid: number | null;
  pid_start?: string | null;
  pid_boot?: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  final_message: string | null;
  final_message_truncated: boolean;
  usage: unknown;
  error: { code: string; message: string } | null;
  event_count: number;
  logs_truncated: boolean;
}

export interface TaskEvent {
  cursor: number;
  at: string;
  type: string;
  detail: unknown;
}

export interface Reachability {
  available: boolean;
  checked_at: string;
  error?: string;
  active_base_url?: string | null;
  using_backup?: boolean;
  requires_user_input?: boolean;
  user_prompt?: string;
  next_action?: string;
  recovery_tool?: string;
  attempts?: { base_url: string; available: boolean; error?: string }[];
}

export function publicTask(task: Task) {
  const { prompt: _prompt, fingerprint: _fingerprint, ...result } = task;
  return {
    ...result,
    queue_ms:
      Date.parse(task.started_at ?? task.ended_at ?? new Date().toISOString()) -
      Date.parse(task.created_at),
    elapsed_ms: task.started_at
      ? Date.parse(task.ended_at ?? new Date().toISOString()) - Date.parse(task.started_at)
      : 0,
  };
}

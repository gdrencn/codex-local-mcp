import type { Config } from './config.js';
import type { Task } from './domain.js';

/** Native flags live here so the scheduler has no dependency on CLI syntax. */
export function workerArguments(task: Task, config: Config): string[] {
  const args = [
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '-a',
    'never',
    // Codex validates transport even for disabled entries. Supply a complete,
    // inert entry so this also works before the supervisor registers the MCP.
    '-c',
    `mcp_servers.${config.mcpServerId}={enabled=false,command="/bin/false"}`,
    '-c',
    `model_providers.lan_local.stream_idle_timeout_ms=${task.timeout_ms}`,
    '-c',
    `sandbox_mode=${JSON.stringify(task.sandbox)}`,
    'exec',
  ];
  if (task.resume_session_id) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  for (const image of task.images) args.push('--image', image);
  if (task.resume_session_id) args.push(task.resume_session_id);
  args.push('-');
  return args;
}

export function workerEnvironment(task?: Task): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Each process is a fresh worker, not an implicit continuation of its host.
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_TURN_ID;
  if (task?.service_url) {
    env.CODEX_LOCAL_BASE_URL = task.service_url;
    env.CODEX_LOCAL_BACKUP_BASE_URL = '';
    env.CODEX_LOCAL_MCP_BACKUP_BASE_URL = '';
  }
  return env;
}

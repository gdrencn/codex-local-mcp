# codex-local-mcp

Run parallel local Codex workers from any MCP client. Keep your regular Codex supervisor connected to its existing provider, and delegate bounded tasks to a LAN model through your `codex-local` launcher.

The server manages tasks and processes. Codex manages the tool loop. Your model service supplies inference; tools execute on the computer running the worker.

## Features

- Four independent workers by default, with a configurable concurrency limit and bounded queue.
- Immediate submission responses, independent status queries, cancellation, execution deadlines, and explicit session continuation.
- Separate task IDs, Codex sessions, working directories, event logs, stderr, and final results.
- Atomic task metadata, bounded logs, idempotent submission, and recovery of stored results after restart.
- Official MCP TypeScript SDK and strict TypeScript. Each conversation connects over stdio to one automatically managed local backend through a private Unix socket; no TCP listener is exposed.
- Multiple conversations share the same task history and four-worker limit. Closing one conversation does not interrupt another conversation's work.

## Requirements and installation

Linux, Node.js 22+, and a working `codex-local` executable in PATH are required. `codex-local` must accept native Codex arguments and connect to your model service using the Responses API. Tested with Codex CLI 0.167.0. The server uses the provider ID `lan_local` for worker stream timeout configuration.

```sh
git clone https://github.com/gdrencn/codex-local-mcp.git
cd codex-local-mcp
npm ci
npm run build
node dist/cli.js --help
```

If you do not already have a launcher, see [the optional shell example](examples/codex-local.sh). It requires Codex, curl, jq, and Linux coreutils, discovers the current service model ID, and supplies generic text/image model metadata. It adds no custom CLI options. Keep the example beside its `models.json` file and either use its absolute path as `CODEX_LOCAL_MCP_BINARY` or add a symlink to it in PATH.

## Connect to Codex

Choose the `/v1` endpoint used by your launcher. Replace the endpoint and checkout location below with your own:

```sh
codex mcp add codex_local \
  --env CODEX_LOCAL_MCP_BASE_URL=http://127.0.0.1:8080/v1 \
  -- node /absolute/path/codex-local-mcp/dist/cli.js
```

Equivalent user configuration:

```toml
[mcp_servers.codex_local]
command = "node"
args = ["/absolute/path/codex-local-mcp/dist/cli.js"]

[mcp_servers.codex_local.env]
CODEX_LOCAL_MCP_BASE_URL = "http://127.0.0.1:8080/v1"
```

Keep the server ID `codex_local`, or set `CODEX_LOCAL_MCP_SERVER_ID` to the actual ID you register. Workers disable a complete inert entry under that ID to prevent recursive scheduling. The server does not edit your Codex configuration or login files automatically.

Codex may request approval for tools that start or alter tasks. For a trusted local installation that should support unattended calls, explicitly configure only these tools rather than changing global approval behavior:

```toml
[mcp_servers.codex_local.tools.local_submit]
approval_mode = "approve"

[mcp_servers.codex_local.tools.local_continue]
approval_mode = "approve"

[mcp_servers.codex_local.tools.local_cancel]
approval_mode = "approve"
```

In the tested Codex version this permits the configured tools in noninteractive `never` approval mode. Worker sandbox selection still applies. Without these per-tool policies a headless call can return `MCP tool call requires approval, but approval policy is never`.

For an existing launcher, `CODEX_LOCAL_MCP_BASE_URL` controls the server's health check and must match the launcher's inference destination. The bundled example uses `CODEX_LOCAL_BASE_URL`, falling back to `CODEX_LOCAL_MCP_BASE_URL`, so one configured endpoint can serve both purposes.

## Use from another conversation

Register once in user-level Codex configuration. A newly started Codex CLI process loads it; restart existing desktop/IDE clients after changing MCP configuration and check `/mcp` or `codex mcp list` for the enabled `codex_local` entry. Local Codex configuration is not automatically available to ChatGPT web.

Then ask the main agent:

```text
Execute this task using the codex_local MCP. Check local_status first. Submit
independent subtasks concurrently, up to four workers, and use local_task to
wait for and collect results. Use separate worktrees for overlapping edits.
Review and summarize the final results yourself.
```

No per-conversation server startup command is needed. Clients with the same data directory and configuration automatically share a backend. Task IDs can be queried or continued from another conversation. A client configured differently must use a separate data directory or stop the old backend and reconnect; conflicting configurations never silently replace an existing scheduler.

## Tools

| Tool             | Arguments                                                                          | Behavior                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `local_status`   | none                                                                               | Executable/version, service reachability, concurrency limits, counts, recent task IDs.         |
| `local_submit`   | `prompt`, absolute `cwd`; optional `sandbox`, `images`, `timeout_ms`, `request_id` | Start a task or queue it and immediately return its ID.                                        |
| `local_task`     | `task_id`; optional `cursor`, `limit`, `wait_ms`                                   | State, bounded event page, final answer, usage, exit details, and pagination cursor.           |
| `local_cancel`   | `task_id`                                                                          | Cancel a queued task or terminate one worker and its descendants; return after confirmed exit. |
| `local_continue` | terminal `task_id`, `prompt`; optional `images`, `timeout_ms`, `request_id`        | New task using that task's explicit Codex session, directory, and sandbox.                     |

Example submission:

```json
{
  "prompt": "Read the parser and identify missing edge cases. Do not edit files. Cite relevant file paths.",
  "cwd": "/absolute/path/project",
  "request_id": "parser-review-1"
}
```

Use the returned `task.id` for queries. Pass each response's `next_cursor` on the next query; `limit` defaults to 50 and is at most 100. `wait_ms` can long-poll for up to 20 seconds. Errors are returned as MCP error results with a structured `error.code` and `error.message`.

Independent tasks run concurrently, including tasks waiting for inference or using tools. The model server may serialize its requests internally. The default limit of four is shared across all clients of the same backend, excluding main agents. Tasks above that limit queue. Turns continuing the same Codex session serialize without blocking unrelated sessions. For parallel modifications, provide separate worktrees or disjoint write scopes; this server does not create worktrees.

Sandbox defaults to `read-only`. Request `workspace-write` for an authorized modification task. Workers run with native approval mode `never`, disable external Apps/plugins, and pass prompts on stdin. These are worker invocation settings; your general `codex-local` command remains unchanged. `images` accepts up to 16 existing absolute local paths; the model service must support image input.

Request IDs deduplicate identical submissions, including after restart. Reusing an ID with different normalized input returns `request_conflict`. Whole agent tasks are never retried automatically, because a tool may already have changed files.

## Configuration

| Environment variable                | Default                                                                      | Meaning                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CODEX_LOCAL_MCP_BINARY`            | `codex-local`                                                                | Worker executable name or path.                                                |
| `CODEX_LOCAL_MCP_BASE_URL`          | `http://127.0.0.1:8080/v1`                                                   | Models-endpoint health check; match the launcher's destination.                |
| `CODEX_LOCAL_MCP_DATA_DIR`          | `$XDG_DATA_HOME/codex-local-mcp`, otherwise `~/.local/share/codex-local-mcp` | Shared task state and logs; one backend per directory.                         |
| `CODEX_LOCAL_MCP_MAX_CONCURRENCY`   | `4`                                                                          | Running workers, 1–64, excluding the supervisor.                               |
| `CODEX_LOCAL_MCP_MAX_QUEUE`         | `16`                                                                         | Pending queue capacity, 0–10,000.                                              |
| `CODEX_LOCAL_MCP_TIMEOUT_MS`        | `600000`                                                                     | Per-task execution deadline; queue wait is reported separately.                |
| `CODEX_LOCAL_MCP_GRACE_MS`          | `2000`                                                                       | SIGTERM-to-SIGKILL grace period.                                               |
| `CODEX_LOCAL_MCP_HEALTH_TIMEOUT_MS` | `3000`                                                                       | Total health request deadline.                                                 |
| `CODEX_LOCAL_MCP_MAX_LOG_BYTES`     | `16777216`                                                                   | Cap for each task log file; truncation is reported.                            |
| `CODEX_LOCAL_MCP_SERVER_ID`         | `codex_local`                                                                | MCP entry disabled in workers.                                                 |
| `CODEX_LOCAL_MCP_BACKEND_IDLE_MS`   | `60000`                                                                      | Backend idle shutdown interval after all clients disconnect and all work ends. |

A reachable nonempty `/models` response establishes reachability. Generation or tool failures still become failed tasks. The health request directly connects without using environment HTTP proxies. No alternative inference provider is selected on failure.

## Task lifecycle and storage

States: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `interrupted`. Success requires exit zero and a completed Codex turn without a terminal failure. Failed individual shell commands can be recovered by the worker and do not automatically fail the entire task.

Each task has `task.json`, `events.jsonl`, `stdout.jsonl`, and `stderr.log` under `<data-dir>/tasks/<task-id>/`; empty output files need not exist. Prompts and tool outputs are local task data. Event summaries and returned final answers are bounded; raw log truncation is explicit. There is no automatic retention policy or global disk quota; remove old task directories while the server is stopped if necessary.

Client EOF, SIGINT, or SIGTERM closes that client's connection. The shared backend and its tasks continue independently. When no clients or queued/running tasks remain, the backend exits after its idle interval. Cancellation targets one worker's process group and descendant snapshot, including separately grouped tool children, with identity checks before escalation. This is process lifecycle management, not a security boundary beyond Codex's sandbox.

On backend restart, terminal results are restored and unfinished tasks become `interrupted`; work is not replayed. A recorded surviving worker is terminated only when both Linux boot identity and process start ticks prove it is the old worker. Lost or unrecorded descendants cannot be guaranteed recoverable after a hard crash. Locks also verify process identity, preventing a reused PID or previous boot from blocking startup indefinitely. Malformed locks fail explicitly.

For an update or explicit shutdown, use the same data directory as the registered server:

```sh
node dist/cli.js --stop-backend
```

This stops the backend and interrupts any active jobs. Pull/build the update and reopen MCP connections afterward. Migrating from v0.1 requires closing the old stdio clients first because they directly own the data-directory lock.

## Development and verification

```sh
npm ci
npm run check
npm test
npm audit
```

Automated tests use a controlled worker and the official SDK client. They cover parallel starts, queueing, stream/argument boundaries, independent cancellation, detached descendants, timeouts, same-session continuation, recovery, bounded output, and protocol errors.

Opt-in real-service test:

```sh
CODEX_LOCAL_MCP_BASE_URL=http://127.0.0.1:8080/v1 npm run test:live
```

This exercises all five tools: parallel local file tasks, explicit session continuation, a temporary workspace edit, image input, independent cancellation, execution timeout, idempotency, and explicit errors. It creates temporary fixtures and uses persistent Codex sessions for continuation. It does not modify the main Codex configuration.

After registering the MCP and its intended tool policies, this separate opt-in check uses your actual main Codex account to delegate a file-reading task through the registered MCP:

```sh
npm run test:native
```

It verifies the native `local_status → local_submit → local_task` calls and an unpredictable worker result without reading the file directly from the main agent. See [IMPLEMENTED.md](IMPLEMENTED.md) for observed results and limits.

## Structure and provenance

`src/domain.ts` defines tasks; `config.ts` handles configuration; `health.ts` checks reachability; `store.ts` owns indexed event persistence; `manager.ts` schedules tasks; `codex.ts` owns CLI arguments; `output.ts` decodes bounded JSONL; `processes.ts` owns Linux cleanup. `contracts.ts` shares validation, `service.ts` defines the adapter boundary, `backend-client.ts` handles IPC and automatic startup, `backend-protocol.ts` identifies compatible backends, and `daemon.ts` hosts the shared scheduler. `server.ts` adapts MCP tools and `cli.ts` serves each conversation over stdio.

The implementation is original. We reviewed [denysvitali/codex-mcp](https://github.com/denysvitali/codex-mcp), particularly explicit JSONL completion/failure handling and process groups, and [ralphkrauss/agent-orchestrator](https://github.com/ralphkrauss/agent-orchestrator), particularly independent worker lifecycles, cancellation, and durable results. No application code from either project is included. Protocol support comes from the [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Original code is MIT licensed.

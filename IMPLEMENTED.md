# Implementation record

## Current version: v0.2.0 follow-up verification

The follow-up implementation and local installation were verified on 2026-11-09 (local time). The initial v0.1 records below describe the earlier standalone implementation.

### Fixed and optimized

- Replaced per-conversation scheduler ownership with a private Unix-socket backend and thin stdio clients. Independent conversations now share tasks and the four-worker limit instead of failing on the same data-directory lock.
- Added automatic backend startup, strict configuration/version matching, configurable idle shutdown, and explicit `--stop-backend`. Disconnecting one conversation does not cancel shared work.
- Fixed a startup race when reconnecting immediately after a killed backend. Stale lock detection now checks Linux boot identity and process start ticks, rather than only a potentially reused PID.
- Added recorded-worker identity checks and orphan cleanup during crash recovery. Work is marked interrupted and is not replayed.
- Fixed query cursor advancement during concurrent event arrival, preventing skipped events. Event pagination uses byte-offset indexing and binary search, with UTF-8 boundaries and recovery covered by tests.
- Coalesced simultaneous service health checks without caching completed results; counted task states in one pass and changed descendant traversal to linear-time breadth-first scanning.
- Shared validation contracts between IPC and MCP and introduced a typed task-service boundary, keeping the scheduler independent of protocol adapters.

### Automated verification

All 24 tests passed, including two simultaneous official-SDK MCP clients sharing four slots, queueing a fifth task, isolated cancellation, client disconnect/reconnect, cross-client session continuation, backend configuration conflict, hard crash with orphan cleanup, graceful restart, idle restart, long polling, offline-service behavior, request deduplication, query-race regression, indexed UTF-8 pages, process cleanup, timeout, malformed/large output, and terminal failure handling. TypeScript compilation and dependency audit passed; no known dependency vulnerabilities were reported.

### Real-service and native-client verification

The expanded `test/live.mjs` passed all seven groups through actual MCP calls: parallel local file tools (16,771 ms and 17,854 ms), explicit session continuation, workspace editing, image input, independent cancellation while another worker completed, execution timeout, and idempotency/error responses. This exercises all five tools.

`npm run test:native` also passed: a fresh main Codex process used the registered `local_status → local_submit → local_task` tools and returned the exact unpredictable file token read by its local worker. The main agent did not use a shell/file-reading tool to obtain that token. This final check used the persisted user configuration without a temporary approval override.

### Local registration and other conversations

The user-level `codex_local` stdio entry is configured for the local checkout and the user's existing launcher/service. Only this MCP entry and its three task-changing tool approval policies were added. Semantic comparison confirmed that pre-existing model/account preferences were preserved. Installation-specific paths and endpoint values remain in local user configuration, not this public repository.

Native Codex initially allowed status inspection but rejected submission in `never` approval mode. Scoped `approval_mode = "approve"` policies for this trusted local server's `local_submit`, `local_continue`, and `local_cancel` were then verified; global approval policy was not changed.

New local Codex conversations can use the registered entry after client startup/restart. README includes the user configuration, per-tool policies, a delegation prompt, update instructions, and the distinction from ChatGPT web. The runtime backend is automatic; no manual per-conversation process startup is needed.

## Phase 1: core and protocol verified

Implemented in separate modules: domain types, environment configuration, service health, persistence, scheduling, Codex argument generation, JSONL decoding, Linux process cleanup, MCP tool registration, and the stdio entry point.

The five tools are `local_status`, `local_submit`, `local_task`, `local_cancel`, and `local_continue`. Default limits are four concurrent workers and sixteen pending tasks. State and bounded logs are persisted outside the source tree. Same-session continuations serialize while unrelated sessions remain concurrent. Worker invocations disable Apps/plugins and the scheduling MCP, use explicit sandbox configuration, and pass prompts through stdin.

On 2026-11-09, `npm test` passed all 14 automated tests, including the official SDK stdio client. Verified behavior covers concurrency and queueing, independent sessions/results, literal prompt and path boundaries, recursion-disable configuration, idempotency, unavailable service handling, independent cancellation with a detached descendant, execution deadlines excluding queue wait, same-session ordering, terminal failures, startup stderr diagnostics, oversize/malformed output, event pagination, store ownership, persistence, and restart recovery. Strict TypeScript compilation and Prettier checks passed. The installed dependency set audited with zero known vulnerabilities after updating Zod to 4.6.7.

## Phase 2: live verification completed

`test/live.mjs` passed against the configured LAN service using the official SDK client and Codex CLI 0.167.0 on Linux with Node.js 22.22.1. The server was initialized over stdio and reported its default concurrency limit of four.

- Two independent workers overlapped, invoked local shell tools to read different unpredictable temporary file tokens, returned the correct token for their own directory, and exited successfully. Execution times were 33,262 ms and 30,334 ms.
- A new task explicitly resumed the first worker's session, retained its session ID, and correctly recalled the token without another tool call.
- A workspace-write task created a temporary result file with the requested exact bytes and verified the file through a local tool.
- An image task correctly identified a red square on the left and blue circle on the right of a generated image.
- The optional portable shell launcher was separately verified with a real local inference task returning `PORTABLE_LAUNCHER_OK` and completing successfully. Its syntax check passed.

Live test fixtures and MCP task data were temporary. Persistent Codex sessions were used to verify continuation. No main Codex MCP registration or login/config edit was performed.

The live run discovered that native Codex validates transport even for disabled MCP entries. Worker recursion prevention now supplies a complete inert disabled transport, rather than an invalid partial entry. This was verified by the successful live startup and tool tasks.

## Limits

The process supervisor targets Linux. Backend crashes interrupt work; recorded surviving workers are cleaned up only with matching boot/start identities, and unrecorded descendants cannot be guaranteed recoverable. Client disconnects preserve tasks in v0.2. Unfinished tasks are interrupted on backend recovery without replay. Logs are bounded per file; historical task count and total disk usage are not automatically capped. Cancellation is process lifecycle management, with Codex responsible for its sandbox. The current service passed the listed tests; these results do not certify every backend or external integration. Workers disable Apps/plugins and their scheduling MCP.

## Publication

Public repository: [gdrencn/codex-local-mcp](https://github.com/gdrencn/codex-local-mcp).

Publication includes modular source, automated tests, opt-in real-service and native-client checks, README, MIT license, pinned dependency lockfile, portable launcher example, and a GitHub Actions workflow with pinned action revisions. Source review excludes machine-specific paths, installation-specific LAN address, credentials, task logs, and dependency directories. The package dry run contained the built modules, public documentation, license, and launcher example.

The initial release did not register the MCP automatically. The authorized follow-up registered it locally as described above; the server itself does not rewrite account or connection configuration. npm registry publication has not been performed.

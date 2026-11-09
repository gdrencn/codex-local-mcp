# Implementation record

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

The process supervisor targets Linux. Jobs do not promise survival after a killed server, and unfinished tasks are interrupted on recovery without replay. Logs are bounded per file; historical task count and total disk usage are not automatically capped. Cancellation is process lifecycle management, with Codex responsible for its sandbox. The current service passed the listed tests; these results do not certify every backend or external integration. Workers disable Apps/plugins and their scheduling MCP.

## Publication

Public repository: [gdrencn/codex-local-mcp](https://github.com/gdrencn/codex-local-mcp).

Publication includes the modular source, 14 automated tests, opt-in real-service test, README, MIT license, pinned dependency lockfile, portable launcher example, and a GitHub Actions workflow with pinned action revisions. Staged-source review found no machine-specific paths, installation-specific LAN address, credentials, task logs, or dependency directories. The package dry run contained the built modules, public documentation, license, and launcher example.

Main Codex connection registration and npm registry publication are outside this stage. Follow the README to connect the checked-out build; the implementation does not edit account or connection configuration automatically.

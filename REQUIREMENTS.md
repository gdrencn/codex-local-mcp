# Requirements

## Scope

Implement a modular local stdio MCP server named `codex-local-mcp`, verify it, and publish it as a public GitHub repository under the authenticated account. The server delegates to the existing `codex-local` executable. It does not implement model inference or replace Codex's tool loop. Registering it in the user's main Codex configuration is outside this implementation stage; provide ready-to-use configuration instructions.

## Architecture and behavior

1. Use TypeScript, Node.js 22+, and the official MCP SDK. Pin dependencies and commit the package lockfile. Separate configuration, domain types, persistence, scheduling, process management, Codex argument generation, health checks, and protocol adapters.
2. Expose five tools: `local_status`, `local_submit`, `local_task`, `local_cancel`, and `local_continue`.
3. Default to four independent running worker processes, excluding the supervisor. Allow configuration of this limit and a pending queue size, default 16. Queue only excess work. Keep queries, cancellation, and submissions responsive while workers run. Serialize continuations of the same Codex session without blocking unrelated sessions.
4. Give each task its own UUID, process, working directory, session ID, events, stdout, stderr, result, deadline, and cancellation state. Persist metadata atomically outside the repository. Paginate bounded event summaries. Bound on-disk logs and mark truncation explicitly.
5. Submit prompts through stdin using `spawn` with `shell: false`. Default to read-only sandboxing; accept explicit workspace-write tasks. Disable Apps/plugins in workers, set a stream idle timeout matching the task deadline, and disable the scheduling MCP server in workers. Do not add flags to the general `codex-local` launcher.
6. Accept existing absolute image paths through native Codex image flags. Use explicit session IDs and recorded working directories for continuation. Keep resumable sessions persistent; never select `--last`.
7. Support idempotent submission through optional request IDs. Return the existing task for the same request and reject conflicting reuse. Validate the working directory and images before execution. Do not retry whole agent tasks automatically or fall back to the supervisor's provider.
8. Check the configurable LAN models endpoint with a bounded timeout before admitting new work; treat it as reachability, not proof of inference readiness. Idempotent retries and existing task queries remain usable when the service is down. Ignore environment proxies for this direct LAN health request.
9. States are queued, running, succeeded, failed, cancelled, timed_out, and interrupted. Success requires process exit zero and a completed Codex turn with no terminal failure. Keep item-level command failures distinct from turn failures.
10. Start execution deadlines when workers start; report queue time separately. On cancellation, timeout, or shutdown, terminate the target worker and its descendants, escalating after a grace period. Release the slot only after confirmed exit. Cancellation must not affect another worker. Target Linux process management initially.
11. On restart, restore completed results and mark prior unfinished tasks interrupted without replaying them. Allow only one server owner per data directory. Graceful shutdown terminates its own workers; surviving a killed parent or disconnected client is not promised.
12. Make the public repository portable: no machine-specific absolute paths, private account tokens, saved task logs, inference endpoint addresses specific to this installation, or vendored third-party application code. Document environment-based configuration, installation, MCP connection, examples, limits, and provenance. Use MIT for original code and retain dependency licenses through normal package metadata.

## Acceptance

- Type checking and build succeed.
- Controlled-worker tests verify four running jobs plus queued work, prompt/argument boundaries, per-task outputs, idempotency, same-session serialization, independent cancellation, timeout, descendant cleanup, queue timing, malformed/large output, false-success rejection, recovery, and data-directory ownership.
- An official SDK client initializes the stdio server, lists all five tools, submits and queries a job, and observes valid structured responses and errors with clean protocol stdout.
- Live MCP tests verify two overlapping local file-tool tasks, a temporary workspace edit with validation, image input, and explicit session continuation. Record service-dependent limits honestly.
- Main Codex config/authentication remain unchanged.
- After verification, update `IMPLEMENTED.md`, review tracked files, create the public `codex-local-mcp` repository, push the reviewed commit, and verify remote visibility and commit identity.

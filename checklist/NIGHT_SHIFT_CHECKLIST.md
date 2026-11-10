# Night-Shift production checklist

Self-score after the hardening pass (honest): **11 / 14** covered in this reference repo at demo depth. Items marked demo are intentionally simplified.

## Traces and logs

- [x] Every log line includes `task_id` (and `trace_id` when present) - **demo**
- [x] Propagate W3C `traceparent` from the request into the task row / worker logs - **demo**
- [x] Structured logs only (JSON)
- [x] Checkpoint events are searchable (processed / total)

## Task authorization

- [x] Task IDs are unguessable (UUID)
- [x] `tasks/get`, `tasks/update`, `tasks/cancel` (or shims) check owner - **demo header auth**
- [x] Do not expose `tasks/list`
- [x] Approval decisions require an approver allowlist - **demo**

## Metrics

- [x] Basic counters via `/metrics` (created/completed/failed/dead_lettered/cancelled/retries) - **demo**
- [ ] Queue lag histogram (not implemented)
- [ ] Approval wait time distribution (not implemented)

## Durability and chaos

- [x] Kill worker mid-run (`SIGKILL` / `taskkill /F`); resume from checkpoint - day2
- [ ] Network blip to Postgres during write (not automated)
- [x] `SKIP LOCKED` claim path
- [x] TTL sweeper + retention DELETE for terminal tasks
- [x] Lease heartbeat renewal independent of checkpoints

## Idempotency

- [x] Every side-effecting write has an idempotency key
- [x] Audit row written only after approval; same transaction as effect when writing
- [x] Concurrent create with one key returns one task (tested)

## Approval / human-in-the-loop

- [x] `input_required` before side effects
- [x] Approval TTL default 6h (configurable; demos use short TTL)
- [x] Deny and expiry paths tested
- [x] Resume does not re-ask for an already-approved ticket

## Cancellation

- [x] Cancel acknowledged; cooperative while working
- [x] Cancelled responses include last progress
- [x] Cancel after terminal status is a no-op

## Retries / DLQ

- [x] Exponential backoff + jitter
- [x] Max attempts then `dead_letter` table + `statusMessage: dead_lettered`

## Eval cases (minimum)

- [x] Crash / resume preserves checkpoint and completes
- [x] Idempotent retry → one audit row per ticket
- [x] Approval expiry → `failed`
- [x] Cancel mid-run → `cancelled`
- [x] Cancel after complete → still `completed`
- [x] Concurrent idempotency key → one task
- [x] Malformed / foreign task id → `-32602`

## MCP Tasks SDK gap

- [x] Document native `tasks/*` (Node) vs tool shim (Python)
- [x] Re-verified: released `mcp` package has no Tasks server module
- [x] Capability gate: no `resultType: "task"` without client Tasks declaration

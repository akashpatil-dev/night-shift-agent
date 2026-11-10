# Night-Shift production checklist

Use this when graduating the demo patterns into a real service.

## Traces and logs

- [ ] Every log line / span includes `task_id`
- [ ] Propagate W3C `traceparent` from the MCP request into the worker
- [ ] Structured logs only (JSON); no secrets in fields
- [ ] Checkpoint events are searchable (processed / total)

## Task authorization

- [ ] Task IDs are unguessable (UUID/ULID)
- [ ] `tasks/get`, `tasks/update`, `tasks/cancel` (or shims) check caller authz
- [ ] Do not expose `tasks/list` unless you can scope it safely
- [ ] Approval decisions require the same principal (or an explicit approver role)

## Metrics

- [ ] Queue lag (time in `queued`)
- [ ] Active `working` / `input_required` gauges
- [ ] Attempt count histogram; retry rate
- [ ] Approval wait time; expiry / deny rates
- [ ] Side-effect conflict rate (`ON CONFLICT DO NOTHING` hits)

## Durability and chaos

- [ ] Kill worker mid-run; confirm resume from last checkpoint
- [ ] Network blip to Postgres during write; confirm transaction rollback + retry
- [ ] Dual workers; confirm `SKIP LOCKED` prevents double processing
- [ ] TTL sweeper runs and is monitored
- [ ] Lease expiry reclaims stuck `working` tasks

## Idempotency

- [ ] Every side-effecting write has an idempotency key
- [ ] Audit / outbox row is written in the **same transaction** as the effect
- [ ] Replay / retry eval case asserts a single external effect

## Approval / human-in-the-loop

- [ ] `input_required` payload is explicit and versioned
- [ ] Approval TTL is enforced server-side
- [ ] Deny and expiry paths are tested
- [ ] Resume does not re-ask for an already-approved ticket

## Cancellation

- [ ] `tasks/cancel` is cooperative and acknowledged immediately
- [ ] Mid-run cancel stops before the next side effect
- [ ] Cancel after terminal status is a no-op (no error storm)

## Eval cases (minimum)

- [ ] Crash / resume preserves checkpoint and completes
- [ ] Idempotent retry → one audit row per ticket
- [ ] Approval expiry → `failed` with `approval_expired`
- [ ] Cancel mid-run → `cancelled`
- [ ] Cancel after complete → still `completed`

## MCP Tasks SDK gap

- [ ] Document whether you use native `tasks/*` or a tool shim
- [ ] Revisit when the official Python SDK ships SEP-2663
- [ ] Capability negotiation: never return `CreateTaskResult` to clients that did not advertise `io.modelcontextprotocol/tasks`

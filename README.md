# Night-Shift Agent

A small, runnable reference implementation for the blog series **Grace and the Night-Shift Agent** - building MCP agents that keep running after the request ends.

One MCP task server accepts long-running jobs, returns a task handle immediately, and survives worker crashes, retries, human approval, and cancellation. Matching **Node.js (TypeScript)** and **Python** implementations share the same Postgres schema and behavior.

## Quickstart

```bash
docker compose up -d
```

Wait until Postgres is healthy (`docker compose ps`), then pick a language.

### Node.js

```bash
cd node
npm install
npm run migrate
npm run server          # terminal 1 - http://127.0.0.1:3100/mcp
npm run worker          # terminal 2 (optional; demos can drive the worker in-process)
npm run demo:day0       # terminal 3
npm test                # local tests (no CI)
```

### Python

```bash
cd python
python -m pip install -e ".[dev]"
night-shift migrate
night-shift server          # terminal 1 - http://127.0.0.1:3200/mcp
night-shift worker          # terminal 2 (optional)
night-shift demo day0
pytest                      # local tests (no CI)
```

Run Node and Python test suites **one at a time** - they share the same local Postgres and truncate tables between cases.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://nightshift:nightshift@127.0.0.1:5432/nightshift` | Postgres |
| `PORT` | `3100` / `3200` | HTTP port (Node / Python) |
| `DEFAULT_OWNER` | `demo-user` | Task owner when no `x-owner-id` header |
| `APPROVER_IDS` | `demo-user,demo-approver` | Identities allowed to approve/deny |
| `APPROVAL_TTL_SECONDS` | `21600` (6 hours) | Approval window; demos may set `60` |
| `RETRY_BASE_MS` | `2000` | Exponential backoff base |
| `RETRY_MAX_ATTEMPTS` | `5` | Then dead-letter; never retry forever |
| `LEASE_SECONDS` | `30` | Worker lock lease |
| `LEASE_HEARTBEAT_MS` | `10000` | Renew lease on a timer (not only at checkpoints) |
| `TTL_RETENTION_MS` | 24h | Delete terminal tasks after retention |
| `SYNC_MAX_TICKETS` | `20` | Max sync triage when client lacks Tasks capability |
| `CHECKPOINT_EVERY` | `50` | Checkpoint interval |

Identity: send `x-owner-id` (or `Authorization: Bearer <id>`). Trace: send W3C `traceparent` (or a generated id is stored on the task).

## Behavior highlights

- **Retries + DLQ**: on worker failure, exponential backoff with jitter; after max attempts the job is inserted into `dead_letter` and the task becomes `failed` with `statusMessage: "dead_lettered"`.
- **Approval**: default **6 hours**; pause happens **before** any `audit_writes` row; deny writes nothing.
- **Ownership**: `tasks/get|update|cancel` only for the owner; non-owners get `-32602` ("Invalid params"). Approve/deny also requires an approver id.
- **Idempotency**: `INSERT ... ON CONFLICT DO NOTHING` then `SELECT` for concurrent `idempotency_key` creates.
- **Capability**: `resultType: "task"` only when the client declares Tasks (`x-mcp-tasks: 1` or `_meta` extensions). Otherwise sync (small cap) or `-32021`.
- **Metrics**: `GET /metrics` (Prometheus text) - created/completed/failed/dead_lettered/cancelled/retries.
- **Cancellation**: response includes last `progress` (processed/total).

## Architecture

```mermaid
flowchart LR
  Client[MCP_Client_or_demo] --> Server[MCP_HTTP_Server]
  Server --> Store[(Postgres_tasks)]
  Server --> Queue[(Postgres_queue_SKIP_LOCKED)]
  Worker[Worker_process] --> Queue
  Worker --> Store
  Worker --> Audit[(audit_writes)]
  Worker --> DLQ[(dead_letter)]
  Worker -->|input_required| Store
  Client -->|tasks_get_or_shim| Server
  Client -->|tasks_update_approve| Server
  Client -->|tasks_cancel| Server
```

## MCP Tasks (SEP-2663) and SDK gaps

| Runtime | Surface |
|---|---|
| **Node** | HTTP JSON-RPC with native-shaped methods `tasks/get`, `tasks/update`, `tasks/cancel`, plus tool `triage_tickets` returning `resultType: "task"` when the client declares Tasks. |
| **Python** | The released official `mcp` package still has **no** Tasks server module (verified: no `mcp.server.tasks`). This repo uses a **tool-based shim** (`get_task`, `update_task`, `cancel_task`). HTTP also accepts `tasks/*` aliases for demos - that is not SDK support. |

## Demos

See [demos/README.md](demos/README.md).

## Series posts

- Day 0 - the fragile version that fails at ticket 1,400, next to the fixed version.
- Day 2 - kill the worker and watch it resume.
- Day 3 - retry without writing anything twice.
- Day 4 - pause for human approval.
- Day 5 - cancel a job.

## Production checklist

See [checklist/NIGHT_SHIFT_CHECKLIST.md](checklist/NIGHT_SHIFT_CHECKLIST.md).

## License

[MIT](LICENSE)

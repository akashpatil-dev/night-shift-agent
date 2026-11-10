# Series demos

Each day has a small script. Start Postgres, migrate, run a worker (or let the demo drive `worker_loop` in-process), and start the MCP HTTP server when the demo calls it.

## Prerequisites

```bash
docker compose up -d
```

### Node

```bash
cd node
npm install
npm run migrate
npm run server   # terminal 1 - required for demos that use the HTTP client
# demos day2–day5 also drive the worker in-process
npm run demo:day0
npm run demo:day2
npm run demo:day3
npm run demo:day4
npm run demo:day5
```

### Python

```bash
cd python
uv sync --extra dev
uv run night-shift migrate
uv run night-shift server   # terminal 1
uv run night-shift demo day0
uv run night-shift demo day2
uv run night-shift demo day3
uv run night-shift demo day4
uv run night-shift demo day5
```

| Demo | Shows |
|---|---|
| day0 | Fragile blocking crash vs queued immediate handle |
| day2 | Kill mid-run; resume from checkpoint |
| day3 | Forced retry; no duplicate audit writes |
| day4 | Approval pause and resume |
| day5 | Cancel mid-run; cancel after completion |

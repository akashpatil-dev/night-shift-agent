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

| Demo | Series post |
|---|---|
| day0 | [Your agent needs a job queue](https://patilsperspectives.substack.com/p/day-0-your-agent-needs-a-job-queue) |
| day2 | [Kill the worker](https://patilsperspectives.substack.com/p/day-2-kill-the-worker-checkpoints) |
| day3 | [Retries without duplicates](https://patilsperspectives.substack.com/p/day-3-retries-without-duplicate-side) |
| day4 | [Human approval](https://patilsperspectives.substack.com/p/day-4-human-approval-without-a-stuck) |
| day5 | [Cancellation](https://patilsperspectives.substack.com/p/day-5-cancellation-is-not) |

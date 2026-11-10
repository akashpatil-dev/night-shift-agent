import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OWNER } from "../src/config.js";
import { pool, withTransaction } from "../src/db.js";
import {
  applyApproval,
  countAuditWrites,
  createTask,
  expireApprovalsAndTtl,
  getTask,
  getTaskForOwner,
  requestCancel,
  scheduleRetryOrDeadLetter,
  updateTaskFields,
  writeTicketIdempotent,
} from "../src/store.js";
import { makeTicket } from "../src/triage.js";
import { workerLoop } from "../src/worker.js";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";

async function resetDb() {
  await pool.query("TRUNCATE audit_writes, dead_letter, tasks CASCADE");
}

let server: Server;

before(async () => {
  const schema = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../sql/schema.sql"),
    "utf8",
  );
  await pool.query(schema);
  process.env.APPROVAL_TTL_SECONDS = "60";
  server = startServer(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("night-shift-agent node", () => {
  it("resumes from checkpoint after crash", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 120,
      owner: DEFAULT_OWNER,
    });
    await workerLoop({
      once: true,
      workerId: "t-crash-a",
      crashAfterTicket: 55,
      taskId: task.id,
    });
    const mid = await getTask(pool, task.id);
    assert.ok(mid);
    assert.equal(mid.checkpoint.processed, 55);

    await workerLoop({ once: true, workerId: "t-crash-b", taskId: task.id });
    const done = await getTask(pool, task.id);
    assert.equal(done?.status, "completed");
    assert.equal(await countAuditWrites(pool, task.id), 120);
  });

  it("idempotent retry does not duplicate audit writes", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 10, owner: DEFAULT_OWNER });
    await withTransaction(async (client) => {
      const first = await writeTicketIdempotent(client, {
        taskId: task.id,
        ticketId: 3,
        payload: { ticket: makeTicket(3) },
      });
      const second = await writeTicketIdempotent(client, {
        taskId: task.id,
        ticketId: 3,
        payload: { ticket: makeTicket(3), retry: true },
      });
      assert.equal(first.inserted, true);
      assert.equal(second.inserted, false);
    });
    assert.equal(await countAuditWrites(pool, task.id), 1);
  });

  it("concurrent idempotency key returns one task", async () => {
    await resetDb();
    const key = `race-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createTask(pool, {
          totalTickets: 5,
          idempotencyKey: key,
          owner: DEFAULT_OWNER,
        }),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 1);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE idempotency_key = $1`,
      [key],
    );
    assert.equal(count.rows[0].n, 1);
  });

  it("approval expiry fails the task", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 5,
      approvalThreshold: 80,
      owner: DEFAULT_OWNER,
    });
    await workerLoop({ once: true, workerId: "t-appr", taskId: task.id });
    const paused = await getTask(pool, task.id);
    assert.equal(paused?.status, "input_required");
    await updateTaskFields(pool, task.id, {
      approval: {
        ...paused!.approval!,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    await expireApprovalsAndTtl(pool);
    const expired = await getTask(pool, task.id);
    assert.equal(expired?.status, "failed");
  });

  it("approval happens before audit write; deny writes nothing", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 5,
      approvalThreshold: 80,
      owner: DEFAULT_OWNER,
    });
    await workerLoop({ once: true, workerId: "t-before", taskId: task.id });
    const paused = await getTask(pool, task.id);
    assert.equal(paused?.status, "input_required");
    assert.equal(await countAuditWrites(pool, task.id), 0);
    await applyApproval(
      pool,
      task.id,
      paused!.approval!.requestId,
      "deny",
      DEFAULT_OWNER,
    );
    assert.equal(await countAuditWrites(pool, task.id), 0);
  });

  it("owner isolation hides foreign tasks", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 3,
      owner: "alice",
    });
    const foreign = await getTaskForOwner(pool, task.id, "bob");
    assert.equal(foreign, null);
    const own = await getTaskForOwner(pool, task.id, "alice");
    assert.ok(own);
  });

  it("retries then dead-letters", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 10,
      owner: DEFAULT_OWNER,
    });
    let current = task;
    for (let i = 0; i < 5; i++) {
      const next = await scheduleRetryOrDeadLetter(pool, current, "boom");
      assert.ok(next);
      current = next;
    }
    assert.equal(current.status, "failed");
    assert.equal(current.status_message, "dead_lettered");
    const dlq = await pool.query(
      `SELECT COUNT(*)::int AS n FROM dead_letter WHERE task_id = $1`,
      [task.id],
    );
    assert.equal(dlq.rows[0].n, 1);
  });

  it("cooperative cancellation mid-run", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 200, owner: DEFAULT_OWNER });
    await workerLoop({
      once: true,
      workerId: "t-cancel-a",
      crashAfterTicket: 40,
      taskId: task.id,
    });
    await requestCancel(pool, task.id, DEFAULT_OWNER);
    await workerLoop({ once: true, workerId: "t-cancel-b", taskId: task.id });
    const done = await getTask(pool, task.id);
    assert.equal(done?.status, "cancelled");
    assert.ok(done!.checkpoint.processed >= 0);
  });

  it("cancel after completion is a no-op", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 15, owner: DEFAULT_OWNER });
    await workerLoop({ once: true, workerId: "t-done", taskId: task.id });
    const after = await requestCancel(pool, task.id, DEFAULT_OWNER);
    assert.equal(after?.status, "completed");
  });

  it("JSON-RPC rejects malformed and foreign task ids with -32602", async () => {
    await resetDb();
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const port = addr.port;
    const bad = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-id": DEFAULT_OWNER,
        "x-mcp-tasks": "1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { taskId: "not-a-uuid" },
      }),
    }).then((r) => r.json());
    assert.equal(bad.error.code, -32602);

    const task = await createTask(pool, { totalTickets: 1, owner: "alice" });
    const missing = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-id": "bob",
        "x-mcp-tasks": "1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { taskId: task.id },
      }),
    }).then((r) => r.json());
    assert.equal(missing.error.code, -32602);
  });
});

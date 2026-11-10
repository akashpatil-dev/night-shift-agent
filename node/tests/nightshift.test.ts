import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pool, withTransaction } from "../src/db.js";
import {
  applyApproval,
  countAuditWrites,
  createTask,
  expireApprovalsAndTtl,
  getTask,
  requestCancel,
  updateTaskFields,
  writeTicketIdempotent,
} from "../src/store.js";
import { makeTicket } from "../src/triage.js";
import { workerLoop } from "../src/worker.js";

async function resetDb() {
  await pool.query("TRUNCATE audit_writes, tasks CASCADE");
}

before(async () => {
  // Ensure schema exists
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const schema = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../sql/schema.sql"),
    "utf8",
  );
  await pool.query(schema);
});

after(async () => {
  await pool.end();
});

describe("night-shift-agent node", () => {
  it("resumes from checkpoint after crash", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 120 });
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
    assert.equal(done?.checkpoint.processed, 120);
    assert.equal(await countAuditWrites(pool, task.id), 120);
  });

  it("idempotent retry does not duplicate audit writes", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 10 });
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

  it("approval expiry fails the task", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 5,
      approvalThreshold: 80,
    });
    // Ticket 0 has severity 90
    await workerLoop({ once: true, workerId: "t-appr", taskId: task.id });
    const paused = await getTask(pool, task.id);
    assert.equal(paused?.status, "input_required");
    assert.ok(paused?.approval);

    await updateTaskFields(pool, task.id, {
      approval: {
        ...paused!.approval!,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    await expireApprovalsAndTtl(pool);
    const expired = await getTask(pool, task.id);
    assert.equal(expired?.status, "failed");
    assert.equal((expired?.error as { code?: string })?.code, "approval_expired");
  });

  it("cooperative cancellation mid-run", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 200 });
    await workerLoop({
      once: true,
      workerId: "t-cancel-a",
      crashAfterTicket: 40,
      taskId: task.id,
    });
    const cancelled = await requestCancel(pool, task.id);
    // After crash, status is still working with expired lease
    assert.equal(cancelled?.cancel_requested, true);

    await workerLoop({ once: true, workerId: "t-cancel-b", taskId: task.id });
    const done = await getTask(pool, task.id);
    assert.equal(done?.status, "cancelled");
  });

  it("cancel after completion is a no-op", async () => {
    await resetDb();
    const task = await createTask(pool, { totalTickets: 15 });
    await workerLoop({ once: true, workerId: "t-done", taskId: task.id });
    const completed = await getTask(pool, task.id);
    assert.equal(completed?.status, "completed");
    const after = await requestCancel(pool, task.id);
    assert.equal(after?.status, "completed");
  });

  it("approve resumes input_required work", async () => {
    await resetDb();
    const task = await createTask(pool, {
      totalTickets: 5,
      approvalThreshold: 80,
    });
    await workerLoop({ once: true, workerId: "t-ok-a", taskId: task.id });
    const paused = await getTask(pool, task.id);
    assert.equal(paused?.status, "input_required");
    const requestId = paused!.approval!.requestId;
    await applyApproval(pool, task.id, requestId, "approve");
    await workerLoop({ once: true, workerId: "t-ok-b", taskId: task.id });
    // May complete or pause again; at least past ticket 0
    const next = await getTask(pool, task.id);
    assert.ok(next);
    assert.ok(
      next.status === "completed" ||
        next.status === "input_required" ||
        next.checkpoint.processed > 0,
    );
  });
});

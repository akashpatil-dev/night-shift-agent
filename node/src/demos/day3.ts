import { McpHttpClient } from "../client.js";
import { pool, withTransaction } from "../db.js";
import { countAuditWrites, getTask, writeTicketIdempotent } from "../store.js";
import { makeTicket } from "../triage.js";
import { workerLoop } from "../worker.js";

async function main() {
  console.log("=== Day 3: retry with no duplicate writes ===\n");
  const client = new McpHttpClient();

  const created = await client.triageTickets({
    count: 40,
    idempotencyKey: `day3-${Date.now()}`,
  });
  const taskId = created.taskId;

  await workerLoop({
    once: true,
    workerId: "day3-a",
    crashAfterTicket: 20,
    taskId,
  });
  const mid = await getTask(pool, taskId);
  const auditBefore = await countAuditWrites(pool, taskId);
  console.log(
    `after crash: processed=${mid?.checkpoint.processed} audit_rows=${auditBefore}`,
  );

  const ticketId = Math.max(0, (mid?.checkpoint.processed ?? 1) - 1);
  await withTransaction(async (clientDb) => {
    const again = await writeTicketIdempotent(clientDb, {
      taskId,
      ticketId,
      payload: { action: "triage", ticket: makeTicket(ticketId), retry: true },
    });
    console.log(`forced retry write ticket ${ticketId}: inserted=${again.inserted}`);
  });

  const auditAfterRetry = await countAuditWrites(pool, taskId);
  console.log(
    `audit_rows after forced retry: ${auditAfterRetry} (unchanged=${auditAfterRetry === auditBefore})`,
  );

  await workerLoop({ once: true, workerId: "day3-b", taskId });
  const done = await client.getTask(taskId);
  const auditFinal = await countAuditWrites(pool, taskId);
  console.log(`final status=${done.status} audit_rows=${auditFinal}`);
  console.log(`expected audit_rows == total tickets (40): ${auditFinal === 40}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

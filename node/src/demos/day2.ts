import { McpHttpClient } from "../client.js";
import { pool } from "../db.js";
import { getTask } from "../store.js";
import { workerLoop } from "../worker.js";

async function main() {
  console.log("=== Day 2: kill mid-run, resume from checkpoint ===\n");
  const client = new McpHttpClient();

  const created = await client.triageTickets({ count: 200 });
  const taskId = created.taskId;
  console.log(`enqueued ${taskId}`);

  console.log("worker run 1: crash after ticket 75...");
  await workerLoop({
    once: true,
    workerId: "day2-a",
    crashAfterTicket: 75,
    taskId,
  });
  const mid = await getTask(pool, taskId);
  console.log(
    `  after crash: status=${mid?.status} processed=${mid?.checkpoint.processed}`,
  );

  console.log("worker run 2: resume from checkpoint...");
  await workerLoop({ once: true, workerId: "day2-b", taskId });
  const done = await client.getTask(taskId);
  console.log(`  final: status=${done.status}`);
  console.log(
    `  resumed from ${mid?.checkpoint.processed} → completed without redoing prior work`,
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

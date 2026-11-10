import { McpHttpClient } from "../client.js";
import { pool } from "../db.js";
import { getTask } from "../store.js";
import { workerLoop } from "../worker.js";

async function main() {
  console.log("=== Day 5: cancel mid-run and after completion ===\n");
  const client = new McpHttpClient();

  const a = await client.triageTickets({ count: 500 });
  console.log(`task A ${a.taskId}: start then cancel`);
  await workerLoop({
    once: true,
    workerId: "day5-a",
    crashAfterTicket: 60,
    taskId: a.taskId,
  });
  await client.cancelTask(a.taskId);
  await workerLoop({ once: true, workerId: "day5-b", taskId: a.taskId });
  const finalA = await getTask(pool, a.taskId);
  console.log(`  task A status=${finalA?.status} (expected cancelled)`);

  const b = await client.triageTickets({ count: 30 });
  await workerLoop({ once: true, workerId: "day5-c", taskId: b.taskId });
  const completed = await client.getTask(b.taskId);
  console.log(`task B completed status=${completed.status}`);
  await client.cancelTask(b.taskId);
  const after = await client.getTask(b.taskId);
  console.log(
    `  cancel after completion: status still ${after.status} (cooperative no-op on terminal)`,
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

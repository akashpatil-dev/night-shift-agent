import { McpHttpClient } from "../client.js";
import { pool } from "../db.js";
import { workerLoop } from "../worker.js";

async function main() {
  process.env.APPROVAL_TTL_SECONDS = process.env.APPROVAL_TTL_SECONDS ?? "60";
  console.log("=== Day 4: approval pause and resume ===\n");
  const client = new McpHttpClient();

  const created = await client.triageTickets({
    count: 40,
    approvalThreshold: 80,
  });
  const taskId = created.taskId;
  console.log(`enqueued ${taskId} with approvalThreshold=80`);

  await workerLoop({ once: true, workerId: "day4-a", taskId });
  const paused = await client.getTask(taskId);
  console.log(`status=${paused.status}`);
  const inputRequests = paused.inputRequests as
    | Record<string, { message?: string }>
    | undefined;
  const requestId = inputRequests ? Object.keys(inputRequests)[0] : undefined;
  console.log(`approval request: ${requestId}`);
  console.log(`message: ${requestId ? inputRequests?.[requestId]?.message : "n/a"}`);

  if (!requestId) {
    throw new Error("Expected input_required with an approval request");
  }

  console.log("approving...");
  await client.updateTask(taskId, requestId, "approve");
  await workerLoop({ once: true, workerId: "day4-b", taskId });

  for (let i = 0; i < 20; i++) {
    const task = await client.getTask(taskId);
    if (
      task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "failed"
    ) {
      console.log(`final status=${task.status}`);
      break;
    }
    if (task.status === "input_required") {
      const reqs = task.inputRequests as Record<string, unknown>;
      const rid = Object.keys(reqs)[0];
      console.log(`another approval ${rid} - approving`);
      await client.updateTask(taskId, rid, "approve");
    }
    await workerLoop({ once: true, workerId: `day4-r${i}`, taskId });
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

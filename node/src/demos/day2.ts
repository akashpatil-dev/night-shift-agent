import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpHttpClient } from "../client.js";
import { pool } from "../db.js";
import { countAuditWrites, getTask } from "../store.js";
import { workerLoop } from "../worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function killHard(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  console.log("=== Day 2: kill -9 worker mid-run, resume from checkpoint ===\n");
  const client = new McpHttpClient();
  const created = await client.triageTickets({ count: 200 });
  const taskId = created.taskId;
  console.log(`enqueued ${taskId}`);

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/worker.ts"],
    {
      cwd: root,
      env: { ...process.env, TASK_ID: taskId },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  for (;;) {
    const t = await getTask(pool, taskId);
    if (t && t.checkpoint.processed >= 50) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const mid = await getTask(pool, taskId);
  const auditMid = await countAuditWrites(pool, taskId);
  console.log(
    `before kill: processed=${mid?.checkpoint.processed} audit_rows=${auditMid}`,
  );

  console.log(`killing worker pid=${child.pid} (SIGKILL / taskkill /F)...`);
  if (child.pid) killHard(child.pid);
  await new Promise((r) => setTimeout(r, 400));

  // Expire the dead worker's lease so a new worker can reclaim.
  await pool.query(
    `UPDATE tasks
     SET locked_until = now() - interval '1 second',
         status = 'queued',
         status_message = 'reclaimed_after_kill',
         updated_at = now()
     WHERE id = $1 AND status = 'working'`,
    [taskId],
  );

  await workerLoop({ once: true, workerId: "day2-resume", taskId });

  const done = await client.getTask(taskId);
  const auditFinal = await countAuditWrites(pool, taskId);
  console.log(`final: status=${done.status} audit_rows=${auditFinal}`);
  console.log(
    `resumed from ${mid?.checkpoint.processed}; no duplicate writes=${auditFinal === 200}`,
  );

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

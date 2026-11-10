import { LEASE_SECONDS } from "./config.js";
import type { DbClient } from "./db.js";
import { mapRow } from "./store.js";
import type { TaskRow } from "./types.js";

/** Claim next runnable task with SKIP LOCKED. Honors next_run_at. */
export async function claimNextTask(
  db: DbClient,
  workerId: string,
  taskId?: string,
): Promise<TaskRow | null> {
  const result = taskId
    ? await db.query(
        `WITH candidate AS (
           SELECT id
           FROM tasks
           WHERE id = $3
             AND (
               status = 'queued'
               OR (status = 'working' AND (locked_until IS NULL OR locked_until < now()))
             )
             AND (next_run_at IS NULL OR next_run_at <= now())
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE tasks t
         SET status = 'working',
             attempts = t.attempts + 1,
             locked_by = $1,
             locked_until = now() + ($2::text || ' seconds')::interval,
             status_message = 'working',
             updated_at = now()
         FROM candidate
         WHERE t.id = candidate.id
         RETURNING t.*`,
        [workerId, LEASE_SECONDS, taskId],
      )
    : await db.query(
        `WITH candidate AS (
           SELECT id
           FROM tasks
           WHERE (
             status = 'queued'
             OR (status = 'working' AND (locked_until IS NULL OR locked_until < now()))
           )
           AND (next_run_at IS NULL OR next_run_at <= now())
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE tasks t
         SET status = 'working',
             attempts = t.attempts + 1,
             locked_by = $1,
             locked_until = now() + ($2::text || ' seconds')::interval,
             status_message = 'working',
             updated_at = now()
         FROM candidate
         WHERE t.id = candidate.id
         RETURNING t.*`,
        [workerId, LEASE_SECONDS],
      );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function renewLease(
  db: DbClient,
  taskId: string,
  workerId: string,
): Promise<void> {
  await db.query(
    `UPDATE tasks
     SET locked_until = now() + ($3::text || ' seconds')::interval,
         updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'working'`,
    [taskId, workerId, LEASE_SECONDS],
  );
}

import { LEASE_SECONDS } from "./config.js";
import type { DbClient } from "./db.js";
import type { TaskRow } from "./types.js";
import { getTask } from "./store.js";

function mapRow(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    status: row.status as TaskRow["status"],
    checkpoint: row.checkpoint as TaskRow["checkpoint"],
    attempts: Number(row.attempts),
    idempotency_key: (row.idempotency_key as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
    ttl_ms: (row.ttl_ms as string | number | null) ?? null,
    expires_at: row.expires_at ? new Date(row.expires_at as string) : null,
    total_tickets: Number(row.total_tickets),
    approval_threshold:
      row.approval_threshold === null || row.approval_threshold === undefined
        ? null
        : Number(row.approval_threshold),
    cancel_requested: Boolean(row.cancel_requested),
    approval: (row.approval as TaskRow["approval"]) ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    poll_interval_ms: Number(row.poll_interval_ms ?? 500),
    locked_by: (row.locked_by as string | null) ?? null,
    locked_until: row.locked_until ? new Date(row.locked_until as string) : null,
    status_message: (row.status_message as string | null) ?? null,
  };
}

/** Claim next runnable task with SKIP LOCKED. Reclaims expired leases. */
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

export async function releaseToQueued(db: DbClient, taskId: string): Promise<TaskRow | null> {
  const result = await db.query(
    `UPDATE tasks
     SET status = 'queued',
         locked_by = NULL,
         locked_until = NULL,
         status_message = 'queued',
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [taskId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function refreshTask(db: DbClient, taskId: string): Promise<TaskRow | null> {
  return getTask(db, taskId);
}

import type { DbClient } from "./db.js";
import { inc } from "./metrics.js";
import { RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, TTL_RETENTION_MS } from "./config.js";
import type { ApprovalState, Checkpoint, StoreStatus, TaskRow } from "./types.js";

export function mapRow(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    status: row.status as StoreStatus,
    checkpoint: row.checkpoint as Checkpoint,
    attempts: Number(row.attempts ?? 0),
    attempt_count: Number(row.attempt_count ?? row.attempts ?? 0),
    next_run_at: row.next_run_at ? new Date(row.next_run_at as string) : null,
    last_error: (row.last_error as string | null) ?? null,
    idempotency_key: (row.idempotency_key as string | null) ?? null,
    owner: String(row.owner ?? "demo-user"),
    trace_id: (row.trace_id as string | null) ?? null,
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
    approval: (row.approval as ApprovalState | null) ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    poll_interval_ms: Number(row.poll_interval_ms ?? 500),
    locked_by: (row.locked_by as string | null) ?? null,
    locked_until: row.locked_until ? new Date(row.locked_until as string) : null,
    status_message: (row.status_message as string | null) ?? null,
  };
}

/** Race-safe create: INSERT ON CONFLICT DO NOTHING then SELECT. */
export async function createTask(
  db: DbClient,
  opts: {
    totalTickets: number;
    approvalThreshold?: number | null;
    idempotencyKey?: string | null;
    ttlMs?: number | null;
    owner: string;
    traceId?: string | null;
  },
): Promise<TaskRow> {
  const ttlMs = opts.ttlMs ?? null;
  const key = opts.idempotencyKey ?? null;

  if (key) {
    await db.query(
      `INSERT INTO tasks (
         status, total_tickets, approval_threshold, idempotency_key,
         ttl_ms, expires_at, status_message, checkpoint, owner, trace_id
       ) VALUES (
         'queued', $1, $2, $3, $4,
         CASE WHEN $4::bigint IS NULL THEN NULL
              ELSE now() + ($4::text || ' milliseconds')::interval END,
         'queued', '{"processed":0,"next_ticket":0}'::jsonb, $5, $6
       )
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        opts.totalTickets,
        opts.approvalThreshold ?? null,
        key,
        ttlMs,
        opts.owner,
        opts.traceId ?? null,
      ],
    );
    const existing = await db.query(
      `SELECT * FROM tasks WHERE idempotency_key = $1`,
      [key],
    );
    const row = mapRow(existing.rows[0]);
    // Only count as created when this insert won (attempt_count 0 and fresh).
    // Heuristic: if created within last 2s, count once from caller if needed.
    return row;
  }

  const result = await db.query(
    `INSERT INTO tasks (
       status, total_tickets, approval_threshold, idempotency_key,
       ttl_ms, expires_at, status_message, checkpoint, owner, trace_id
     ) VALUES (
       'queued', $1, $2, NULL, $3,
       CASE WHEN $3::bigint IS NULL THEN NULL
            ELSE now() + ($3::text || ' milliseconds')::interval END,
       'queued', '{"processed":0,"next_ticket":0}'::jsonb, $4, $5
     )
     RETURNING *`,
    [
      opts.totalTickets,
      opts.approvalThreshold ?? null,
      ttlMs,
      opts.owner,
      opts.traceId ?? null,
    ],
  );
  inc("tasks_created");
  return mapRow(result.rows[0]);
}

export async function getTask(db: DbClient, taskId: string): Promise<TaskRow | null> {
  const result = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getTaskForOwner(
  db: DbClient,
  taskId: string,
  owner: string,
): Promise<TaskRow | null> {
  const result = await db.query(
    `SELECT * FROM tasks WHERE id = $1 AND owner = $2`,
    [taskId, owner],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateTaskFields(
  db: DbClient,
  taskId: string,
  fields: Partial<{
    status: StoreStatus;
    checkpoint: Checkpoint;
    attempts: number;
    attempt_count: number;
    next_run_at: Date | null;
    last_error: string | null;
    cancel_requested: boolean;
    approval: ApprovalState | null;
    result: unknown;
    error: unknown;
    status_message: string | null;
    locked_by: string | null;
    locked_until: Date | null;
    owner: string;
    trace_id: string | null;
  }>,
): Promise<TaskRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  let i = 1;

  const map: Record<string, unknown> = { ...fields };

  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    if (key === "checkpoint" || key === "approval" || key === "result" || key === "error") {
      sets.push(`${key} = $${i}::jsonb`);
      values.push(JSON.stringify(value));
    } else {
      sets.push(`${key} = $${i}`);
      values.push(value);
    }
    i += 1;
  }

  values.push(taskId);
  const result = await db.query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function requestCancel(
  db: DbClient,
  taskId: string,
  owner: string,
): Promise<TaskRow | null> {
  const task = await getTaskForOwner(db, taskId, owner);
  if (!task) return null;

  if (["completed", "failed", "cancelled"].includes(task.status)) {
    return task;
  }

  if (task.status === "working") {
    return updateTaskFields(db, taskId, {
      cancel_requested: true,
      status_message: "cancel_requested",
    });
  }

  const updated = await updateTaskFields(db, taskId, {
    cancel_requested: true,
    status: "cancelled",
    status_message: "cancelled",
    locked_by: null,
    locked_until: null,
  });
  if (updated?.status === "cancelled") inc("tasks_cancelled");
  return updated;
}

export async function applyApproval(
  db: DbClient,
  taskId: string,
  requestId: string,
  decision: "approve" | "deny",
  owner: string,
): Promise<TaskRow | null> {
  const task = await getTaskForOwner(db, taskId, owner);
  if (!task) return null;
  if (task.status !== "input_required" || !task.approval) {
    return task;
  }
  if (task.approval.requestId !== requestId) {
    throw Object.assign(new Error("Unknown approval requestId"), { code: -32602 });
  }
  if (new Date(task.approval.expiresAt).getTime() < Date.now()) {
    return updateTaskFields(db, taskId, {
      status: "failed",
      error: { code: "approval_expired", message: "Approval window expired" },
      status_message: "approval_expired",
      locked_by: null,
      locked_until: null,
    });
  }

  const approval: ApprovalState = {
    ...task.approval,
    decision,
    decidedAt: new Date().toISOString(),
  };

  if (decision === "deny") {
    const updated = await updateTaskFields(db, taskId, {
      status: "cancelled",
      approval,
      status_message: "approval_denied",
      locked_by: null,
      locked_until: null,
    });
    inc("tasks_cancelled");
    return updated;
  }

  return updateTaskFields(db, taskId, {
    status: "queued",
    approval,
    status_message: "approved_resuming",
    locked_by: null,
    locked_until: null,
    next_run_at: null,
  });
}

export function backoffMs(attemptCount: number): number {
  const exp = Math.min(attemptCount, 8);
  const base = RETRY_BASE_MS * 2 ** Math.max(0, exp - 1);
  const jitter = Math.floor(Math.random() * RETRY_BASE_MS);
  return base + jitter;
}

export async function scheduleRetryOrDeadLetter(
  db: DbClient,
  task: TaskRow,
  errMsg: string,
): Promise<TaskRow | null> {
  const nextAttempt = task.attempt_count + 1;
  if (nextAttempt >= RETRY_MAX_ATTEMPTS) {
    await db.query(
      `INSERT INTO dead_letter (task_id, owner, payload, last_error, attempt_count, trace_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        task.id,
        task.owner,
        JSON.stringify({
          checkpoint: task.checkpoint,
          total_tickets: task.total_tickets,
        }),
        errMsg,
        nextAttempt,
        task.trace_id,
      ],
    );
    inc("tasks_dead_lettered");
    inc("tasks_failed");
    return updateTaskFields(db, task.id, {
      status: "failed",
      attempt_count: nextAttempt,
      attempts: nextAttempt,
      last_error: errMsg,
      error: { code: "dead_lettered", message: errMsg },
      status_message: "dead_lettered",
      locked_by: null,
      locked_until: null,
      next_run_at: null,
    });
  }

  const delay = backoffMs(nextAttempt);
  inc("retries");
  return updateTaskFields(db, task.id, {
    status: "queued",
    attempt_count: nextAttempt,
    attempts: nextAttempt,
    last_error: errMsg,
    status_message: "retry_scheduled",
    locked_by: null,
    locked_until: null,
    next_run_at: new Date(Date.now() + delay),
  });
}

export async function expireApprovalsAndTtl(db: DbClient): Promise<number> {
  const approval = await db.query(
    `UPDATE tasks
     SET status = 'failed',
         error = jsonb_build_object('code', 'approval_expired', 'message', 'Approval window expired'),
         status_message = 'approval_expired',
         locked_by = NULL,
         locked_until = NULL,
         updated_at = now()
     WHERE status = 'input_required'
       AND approval IS NOT NULL
       AND (approval->>'expiresAt')::timestamptz < now()`,
  );

  const ttlFail = await db.query(
    `UPDATE tasks
     SET status = 'failed',
         error = jsonb_build_object('code', 'ttl_expired', 'message', 'Task TTL elapsed'),
         status_message = 'ttl_expired',
         locked_by = NULL,
         locked_until = NULL,
         updated_at = now()
     WHERE status IN ('queued', 'working', 'input_required')
       AND expires_at IS NOT NULL
       AND expires_at < now()`,
  );

  // Delete expired terminal tasks past retention window
  const deleted = await db.query(
    `DELETE FROM tasks
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND updated_at < now() - ($1::text || ' milliseconds')::interval
       AND (expires_at IS NULL OR expires_at < now())`,
    [TTL_RETENTION_MS],
  );

  return (
    (approval.rowCount ?? 0) + (ttlFail.rowCount ?? 0) + (deleted.rowCount ?? 0)
  );
}

export async function countAuditWrites(db: DbClient, taskId: string): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS n FROM audit_writes WHERE task_id = $1`,
    [taskId],
  );
  return Number(result.rows[0].n);
}

export async function writeTicketIdempotent(
  db: DbClient,
  opts: {
    taskId: string;
    ticketId: number;
    payload: Record<string, unknown>;
  },
): Promise<{ inserted: boolean }> {
  const key = `triage:${opts.taskId}:${opts.ticketId}`;
  const result = await db.query(
    `INSERT INTO audit_writes (idempotency_key, task_id, ticket_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [key, opts.taskId, opts.ticketId, JSON.stringify(opts.payload)],
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

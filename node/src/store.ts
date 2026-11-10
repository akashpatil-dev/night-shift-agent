import type { DbClient } from "./db.js";
import type { ApprovalState, Checkpoint, StoreStatus, TaskRow } from "./types.js";

function mapRow(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    status: row.status as StoreStatus,
    checkpoint: row.checkpoint as Checkpoint,
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
    approval: (row.approval as ApprovalState | null) ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    poll_interval_ms: Number(row.poll_interval_ms ?? 500),
    locked_by: (row.locked_by as string | null) ?? null,
    locked_until: row.locked_until ? new Date(row.locked_until as string) : null,
    status_message: (row.status_message as string | null) ?? null,
  };
}

export async function createTask(
  db: DbClient,
  opts: {
    totalTickets: number;
    approvalThreshold?: number | null;
    idempotencyKey?: string | null;
    ttlMs?: number | null;
  },
): Promise<TaskRow> {
  if (opts.idempotencyKey) {
    const existing = await db.query(
      `SELECT * FROM tasks WHERE idempotency_key = $1`,
      [opts.idempotencyKey],
    );
    if (existing.rows[0]) return mapRow(existing.rows[0]);
  }

  const ttlMs = opts.ttlMs ?? null;
  const result = await db.query(
    `INSERT INTO tasks (
       status, total_tickets, approval_threshold, idempotency_key,
       ttl_ms, expires_at, status_message, checkpoint
     ) VALUES (
       'queued', $1, $2, $3, $4,
       CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() + ($4::text || ' milliseconds')::interval END,
       'queued', '{"processed":0,"next_ticket":0}'::jsonb
     )
     RETURNING *`,
    [
      opts.totalTickets,
      opts.approvalThreshold ?? null,
      opts.idempotencyKey ?? null,
      ttlMs,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function getTask(db: DbClient, taskId: string): Promise<TaskRow | null> {
  const result = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateTaskFields(
  db: DbClient,
  taskId: string,
  fields: Partial<{
    status: StoreStatus;
    checkpoint: Checkpoint;
    attempts: number;
    cancel_requested: boolean;
    approval: ApprovalState | null;
    result: unknown;
    error: unknown;
    status_message: string | null;
    locked_by: string | null;
    locked_until: Date | null;
  }>,
): Promise<TaskRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  let i = 1;

  const map: Record<string, unknown> = {
    status: fields.status,
    checkpoint: fields.checkpoint,
    attempts: fields.attempts,
    cancel_requested: fields.cancel_requested,
    approval: fields.approval,
    result: fields.result,
    error: fields.error,
    status_message: fields.status_message,
    locked_by: fields.locked_by,
    locked_until: fields.locked_until,
  };

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

export async function requestCancel(db: DbClient, taskId: string): Promise<TaskRow | null> {
  const task = await getTask(db, taskId);
  if (!task) return null;

  if (["completed", "failed", "cancelled"].includes(task.status)) {
    return task;
  }

  // Cooperative while working; immediate when idle/paused/queued.
  if (task.status === "working") {
    return updateTaskFields(db, taskId, {
      cancel_requested: true,
      status_message: "cancel_requested",
    });
  }

  return updateTaskFields(db, taskId, {
    cancel_requested: true,
    status: "cancelled",
    status_message: "cancelled",
    locked_by: null,
    locked_until: null,
  });
}

export async function applyApproval(
  db: DbClient,
  taskId: string,
  requestId: string,
  decision: "approve" | "deny",
): Promise<TaskRow | null> {
  const task = await getTask(db, taskId);
  if (!task) return null;
  if (task.status !== "input_required" || !task.approval) {
    return task;
  }
  if (task.approval.requestId !== requestId) {
    throw new Error("Unknown approval requestId");
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
    return updateTaskFields(db, taskId, {
      status: "cancelled",
      approval,
      status_message: "approval_denied",
      locked_by: null,
      locked_until: null,
    });
  }

  return updateTaskFields(db, taskId, {
    status: "queued",
    approval,
    status_message: "approved_resuming",
    locked_by: null,
    locked_until: null,
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

  const ttl = await db.query(
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

  return (approval.rowCount ?? 0) + (ttl.rowCount ?? 0);
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

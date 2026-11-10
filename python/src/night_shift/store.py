from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, TTL_RETENTION_MS
from .metrics import inc
from .types import ApprovalState, Checkpoint, TaskRow


def map_row(row: dict[str, Any]) -> TaskRow:
    return TaskRow(
        id=str(row["id"]),
        status=row["status"],
        checkpoint=Checkpoint.from_obj(row["checkpoint"]),
        attempts=int(row.get("attempts") or 0),
        attempt_count=int(row.get("attempt_count") or row.get("attempts") or 0),
        next_run_at=row.get("next_run_at"),
        last_error=row.get("last_error"),
        idempotency_key=row.get("idempotency_key"),
        owner=str(row.get("owner") or "demo-user"),
        trace_id=row.get("trace_id"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        ttl_ms=int(row["ttl_ms"]) if row.get("ttl_ms") is not None else None,
        expires_at=row.get("expires_at"),
        total_tickets=int(row["total_tickets"]),
        approval_threshold=(
            int(row["approval_threshold"])
            if row.get("approval_threshold") is not None
            else None
        ),
        cancel_requested=bool(row["cancel_requested"]),
        approval=ApprovalState.from_obj(row.get("approval")),
        result=row.get("result"),
        error=row.get("error"),
        poll_interval_ms=int(row.get("poll_interval_ms") or 500),
        locked_by=row.get("locked_by"),
        locked_until=row.get("locked_until"),
        status_message=row.get("status_message"),
    )


def create_task(
    conn: psycopg.Connection,
    *,
    total_tickets: int,
    owner: str,
    approval_threshold: int | None = None,
    idempotency_key: str | None = None,
    ttl_ms: int | None = None,
    trace_id: str | None = None,
) -> TaskRow:
    if idempotency_key:
        conn.execute(
            """
            INSERT INTO tasks (
              status, total_tickets, approval_threshold, idempotency_key,
              ttl_ms, expires_at, status_message, checkpoint, owner, trace_id
            ) VALUES (
              'queued', %s, %s, %s, %s,
              CASE WHEN %s::bigint IS NULL THEN NULL
                   ELSE now() + (%s::text || ' milliseconds')::interval END,
              'queued', '{"processed":0,"next_ticket":0}'::jsonb, %s, %s
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            """,
            (
                total_tickets,
                approval_threshold,
                idempotency_key,
                ttl_ms,
                ttl_ms,
                ttl_ms,
                owner,
                trace_id,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM tasks WHERE idempotency_key = %s",
            (idempotency_key,),
        ).fetchone()
        assert row
        return map_row(row)

    row = conn.execute(
        """
        INSERT INTO tasks (
          status, total_tickets, approval_threshold, idempotency_key,
          ttl_ms, expires_at, status_message, checkpoint, owner, trace_id
        ) VALUES (
          'queued', %s, %s, NULL, %s,
          CASE WHEN %s::bigint IS NULL THEN NULL
               ELSE now() + (%s::text || ' milliseconds')::interval END,
          'queued', '{"processed":0,"next_ticket":0}'::jsonb, %s, %s
        )
        RETURNING *
        """,
        (
            total_tickets,
            approval_threshold,
            ttl_ms,
            ttl_ms,
            ttl_ms,
            owner,
            trace_id,
        ),
    ).fetchone()
    conn.commit()
    inc("tasks_created")
    assert row
    return map_row(row)


def get_task(conn: psycopg.Connection, task_id: str) -> TaskRow | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = %s", (task_id,)).fetchone()
    return map_row(row) if row else None


def get_task_for_owner(
    conn: psycopg.Connection, task_id: str, owner: str
) -> TaskRow | None:
    row = conn.execute(
        "SELECT * FROM tasks WHERE id = %s AND owner = %s",
        (task_id, owner),
    ).fetchone()
    return map_row(row) if row else None


def update_task_fields(
    conn: psycopg.Connection,
    task_id: str,
    **fields: Any,
) -> TaskRow | None:
    sets = ["updated_at = now()"]
    values: list[Any] = []
    json_keys = {"checkpoint", "approval", "result", "error"}
    for key, value in fields.items():
        if key in json_keys:
            sets.append(f"{key} = %s::jsonb")
            if hasattr(value, "to_dict"):
                values.append(Jsonb(value.to_dict()))
            else:
                values.append(Jsonb(value))
        else:
            sets.append(f"{key} = %s")
            values.append(value)
    values.append(task_id)
    row = conn.execute(
        f"UPDATE tasks SET {', '.join(sets)} WHERE id = %s RETURNING *",
        values,
    ).fetchone()
    conn.commit()
    return map_row(row) if row else None


def request_cancel(
    conn: psycopg.Connection, task_id: str, owner: str
) -> TaskRow | None:
    task = get_task_for_owner(conn, task_id, owner)
    if not task:
        return None
    if task.status in ("completed", "failed", "cancelled"):
        return task
    if task.status == "working":
        return update_task_fields(
            conn,
            task_id,
            cancel_requested=True,
            status_message="cancel_requested",
        )
    updated = update_task_fields(
        conn,
        task_id,
        cancel_requested=True,
        status="cancelled",
        status_message="cancelled",
        locked_by=None,
        locked_until=None,
    )
    if updated and updated.status == "cancelled":
        inc("tasks_cancelled")
    return updated


def apply_approval(
    conn: psycopg.Connection,
    task_id: str,
    request_id: str,
    decision: str,
    owner: str,
) -> TaskRow | None:
    task = get_task_for_owner(conn, task_id, owner)
    if not task:
        return None
    if task.status != "input_required" or not task.approval:
        return task
    if task.approval.requestId != request_id:
        raise ValueError("Unknown approval requestId")
    expires = datetime.fromisoformat(task.approval.expiresAt.replace("Z", "+00:00"))
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        return update_task_fields(
            conn,
            task_id,
            status="failed",
            error={"code": "approval_expired", "message": "Approval window expired"},
            status_message="approval_expired",
            locked_by=None,
            locked_until=None,
        )

    approval = ApprovalState(
        requestId=task.approval.requestId,
        message=task.approval.message,
        ticketId=task.approval.ticketId,
        expiresAt=task.approval.expiresAt,
        decision=decision,
        decidedAt=datetime.now(timezone.utc).isoformat(),
    )
    if decision == "deny":
        updated = update_task_fields(
            conn,
            task_id,
            status="cancelled",
            approval=approval,
            status_message="approval_denied",
            locked_by=None,
            locked_until=None,
        )
        inc("tasks_cancelled")
        return updated
    return update_task_fields(
        conn,
        task_id,
        status="queued",
        approval=approval,
        status_message="approved_resuming",
        locked_by=None,
        locked_until=None,
        next_run_at=None,
    )


def backoff_ms(attempt_count: int) -> int:
    exp = min(attempt_count, 8)
    base = RETRY_BASE_MS * (2 ** max(0, exp - 1))
    jitter = random.randint(0, RETRY_BASE_MS)
    return base + jitter


def schedule_retry_or_dead_letter(
    conn: psycopg.Connection, task: TaskRow, err_msg: str
) -> TaskRow | None:
    next_attempt = task.attempt_count + 1
    if next_attempt >= RETRY_MAX_ATTEMPTS:
        conn.execute(
            """
            INSERT INTO dead_letter (task_id, owner, payload, last_error, attempt_count, trace_id)
            VALUES (%s, %s, %s::jsonb, %s, %s, %s)
            """,
            (
                task.id,
                task.owner,
                json.dumps(
                    {
                        "checkpoint": task.checkpoint.to_dict(),
                        "total_tickets": task.total_tickets,
                    }
                ),
                err_msg,
                next_attempt,
                task.trace_id,
            ),
        )
        conn.commit()
        inc("tasks_dead_lettered")
        inc("tasks_failed")
        return update_task_fields(
            conn,
            task.id,
            status="failed",
            attempt_count=next_attempt,
            attempts=next_attempt,
            last_error=err_msg,
            error={"code": "dead_lettered", "message": err_msg},
            status_message="dead_lettered",
            locked_by=None,
            locked_until=None,
            next_run_at=None,
        )

    delay = backoff_ms(next_attempt)
    inc("retries")
    return update_task_fields(
        conn,
        task.id,
        status="queued",
        attempt_count=next_attempt,
        attempts=next_attempt,
        last_error=err_msg,
        status_message="retry_scheduled",
        locked_by=None,
        locked_until=None,
        next_run_at=datetime.now(timezone.utc) + timedelta(milliseconds=delay),
    )


def expire_approvals_and_ttl(conn: psycopg.Connection) -> int:
    a = conn.execute(
        """
        UPDATE tasks
        SET status = 'failed',
            error = jsonb_build_object('code', 'approval_expired', 'message', 'Approval window expired'),
            status_message = 'approval_expired',
            locked_by = NULL,
            locked_until = NULL,
            updated_at = now()
        WHERE status = 'input_required'
          AND approval IS NOT NULL
          AND (approval->>'expiresAt')::timestamptz < now()
        """
    )
    b = conn.execute(
        """
        UPDATE tasks
        SET status = 'failed',
            error = jsonb_build_object('code', 'ttl_expired', 'message', 'Task TTL elapsed'),
            status_message = 'ttl_expired',
            locked_by = NULL,
            locked_until = NULL,
            updated_at = now()
        WHERE status IN ('queued', 'working', 'input_required')
          AND expires_at IS NOT NULL
          AND expires_at < now()
        """
    )
    c = conn.execute(
        """
        DELETE FROM tasks
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND updated_at < now() - (%s::text || ' milliseconds')::interval
          AND (expires_at IS NULL OR expires_at < now())
        """,
        (TTL_RETENTION_MS,),
    )
    conn.commit()
    return (a.rowcount or 0) + (b.rowcount or 0) + (c.rowcount or 0)


def count_audit_writes(conn: psycopg.Connection, task_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*)::int AS n FROM audit_writes WHERE task_id = %s",
        (task_id,),
    ).fetchone()
    return int(row["n"]) if row else 0


def write_ticket_idempotent(
    conn: psycopg.Connection,
    *,
    task_id: str,
    ticket_id: int,
    payload: dict[str, Any],
    commit: bool = False,
) -> bool:
    key = f"triage:{task_id}:{ticket_id}"
    row = conn.execute(
        """
        INSERT INTO audit_writes (idempotency_key, task_id, ticket_id, payload)
        VALUES (%s, %s, %s, %s::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
        """,
        (key, task_id, ticket_id, json.dumps(payload)),
    ).fetchone()
    if commit:
        conn.commit()
    return row is not None

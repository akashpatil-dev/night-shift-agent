from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .types import ApprovalState, Checkpoint, StoreStatus, TaskRow


def _map_row(row: dict[str, Any]) -> TaskRow:
    return TaskRow(
        id=str(row["id"]),
        status=row["status"],
        checkpoint=Checkpoint.from_obj(row["checkpoint"]),
        attempts=int(row["attempts"]),
        idempotency_key=row.get("idempotency_key"),
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
    approval_threshold: int | None = None,
    idempotency_key: str | None = None,
    ttl_ms: int | None = None,
) -> TaskRow:
    if idempotency_key:
        row = conn.execute(
            "SELECT * FROM tasks WHERE idempotency_key = %s",
            (idempotency_key,),
        ).fetchone()
        if row:
            return _map_row(row)

    row = conn.execute(
        """
        INSERT INTO tasks (
          status, total_tickets, approval_threshold, idempotency_key,
          ttl_ms, expires_at, status_message, checkpoint
        ) VALUES (
          'queued', %s, %s, %s, %s,
          CASE WHEN %s::bigint IS NULL THEN NULL
               ELSE now() + (%s::text || ' milliseconds')::interval END,
          'queued', '{"processed":0,"next_ticket":0}'::jsonb
        )
        RETURNING *
        """,
        (
            total_tickets,
            approval_threshold,
            idempotency_key,
            ttl_ms,
            ttl_ms,
            ttl_ms,
        ),
    ).fetchone()
    conn.commit()
    assert row
    return _map_row(row)


def get_task(conn: psycopg.Connection, task_id: str) -> TaskRow | None:
    row = conn.execute("SELECT * FROM tasks WHERE id = %s", (task_id,)).fetchone()
    return _map_row(row) if row else None


def update_task_fields(
    conn: psycopg.Connection,
    task_id: str,
    **fields: Any,
) -> TaskRow | None:
    sets = ["updated_at = now()"]
    values: list[Any] = []
    json_keys = {"checkpoint", "approval", "result", "error"}
    for key, value in fields.items():
        if value is None and key in {
            "locked_by",
            "locked_until",
            "status_message",
            "approval",
            "result",
            "error",
        }:
            sets.append(f"{key} = %s")
            values.append(None)
            continue
        if key in json_keys:
            sets.append(f"{key} = %s::jsonb")
            if hasattr(value, "to_dict"):
                values.append(Jsonb(value.to_dict()))
            elif isinstance(value, dict) or isinstance(value, list):
                values.append(Jsonb(value))
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
    return _map_row(row) if row else None


def request_cancel(conn: psycopg.Connection, task_id: str) -> TaskRow | None:
    task = get_task(conn, task_id)
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
    return update_task_fields(
        conn,
        task_id,
        cancel_requested=True,
        status="cancelled",
        status_message="cancelled",
        locked_by=None,
        locked_until=None,
    )


def apply_approval(
    conn: psycopg.Connection,
    task_id: str,
    request_id: str,
    decision: str,
) -> TaskRow | None:
    task = get_task(conn, task_id)
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
        return update_task_fields(
            conn,
            task_id,
            status="cancelled",
            approval=approval,
            status_message="approval_denied",
            locked_by=None,
            locked_until=None,
        )
    return update_task_fields(
        conn,
        task_id,
        status="queued",
        approval=approval,
        status_message="approved_resuming",
        locked_by=None,
        locked_until=None,
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
    conn.commit()
    return (a.rowcount or 0) + (b.rowcount or 0)


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

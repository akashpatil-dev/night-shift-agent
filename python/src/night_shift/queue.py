from __future__ import annotations

import psycopg

from .config import LEASE_SECONDS
from .store import map_row
from .types import TaskRow


def claim_next_task(
    conn: psycopg.Connection,
    worker_id: str,
    task_id: str | None = None,
) -> TaskRow | None:
    if task_id:
        row = conn.execute(
            """
            WITH candidate AS (
              SELECT id
              FROM tasks
              WHERE id = %s
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
                locked_by = %s,
                locked_until = now() + (%s::text || ' seconds')::interval,
                status_message = 'working',
                updated_at = now()
            FROM candidate
            WHERE t.id = candidate.id
            RETURNING t.*
            """,
            (task_id, worker_id, LEASE_SECONDS),
        ).fetchone()
    else:
        row = conn.execute(
            """
            WITH candidate AS (
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
                locked_by = %s,
                locked_until = now() + (%s::text || ' seconds')::interval,
                status_message = 'working',
                updated_at = now()
            FROM candidate
            WHERE t.id = candidate.id
            RETURNING t.*
            """,
            (worker_id, LEASE_SECONDS),
        ).fetchone()
    conn.commit()
    return map_row(row) if row else None


def renew_lease(conn: psycopg.Connection, task_id: str, worker_id: str) -> None:
    conn.execute(
        """
        UPDATE tasks
        SET locked_until = now() + (%s::text || ' seconds')::interval,
            updated_at = now()
        WHERE id = %s AND locked_by = %s AND status = 'working'
        """,
        (LEASE_SECONDS, task_id, worker_id),
    )
    conn.commit()

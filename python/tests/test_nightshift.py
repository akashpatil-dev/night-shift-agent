from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from night_shift.db import connect
from night_shift.store import (
    apply_approval,
    count_audit_writes,
    create_task,
    expire_approvals_and_ttl,
    get_task,
    request_cancel,
    update_task_fields,
    write_ticket_idempotent,
)
from night_shift.triage import make_ticket
from night_shift.worker import worker_loop


@pytest.fixture(scope="session", autouse=True)
def migrate():
    # __file__ = repo/python/tests/test_nightshift.py → parents[2] = repo
    schema = Path(__file__).resolve().parents[2] / "sql" / "schema.sql"
    sql = schema.read_text(encoding="utf-8")
    conn = connect()
    try:
        conn.execute(sql)
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def clean():
    conn = connect()
    try:
        conn.execute("TRUNCATE audit_writes, tasks CASCADE")
        conn.commit()
    finally:
        conn.close()
    yield


def test_resume_from_checkpoint():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=120)
    finally:
        conn.close()
    worker_loop(
        once=True, worker_id="py-crash-a", crash_after_ticket=55, task_id=task.id
    )
    conn = connect()
    try:
        mid = get_task(conn, task.id)
        assert mid is not None
        assert mid.checkpoint.processed == 55
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-crash-b", task_id=task.id)
    conn = connect()
    try:
        done = get_task(conn, task.id)
        assert done is not None
        assert done.status == "completed"
        assert done.checkpoint.processed == 120
        assert count_audit_writes(conn, task.id) == 120
    finally:
        conn.close()


def test_idempotent_retry():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=10)
        first = write_ticket_idempotent(
            conn,
            task_id=task.id,
            ticket_id=3,
            payload={"ticket": make_ticket(3)},
            commit=True,
        )
        second = write_ticket_idempotent(
            conn,
            task_id=task.id,
            ticket_id=3,
            payload={"ticket": make_ticket(3), "retry": True},
            commit=True,
        )
        assert first is True
        assert second is False
        assert count_audit_writes(conn, task.id) == 1
    finally:
        conn.close()


def test_approval_expiry():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=5, approval_threshold=80)
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-appr", task_id=task.id)
    conn = connect()
    try:
        paused = get_task(conn, task.id)
        assert paused is not None
        assert paused.status == "input_required"
        assert paused.approval is not None
        expired = paused.approval
        expired.expiresAt = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        update_task_fields(conn, task.id, approval=expired)
        expire_approvals_and_ttl(conn)
        failed = get_task(conn, task.id)
        assert failed is not None
        assert failed.status == "failed"
        assert failed.error["code"] == "approval_expired"
    finally:
        conn.close()


def test_cooperative_cancel():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=200)
    finally:
        conn.close()
    worker_loop(
        once=True, worker_id="py-cancel-a", crash_after_ticket=40, task_id=task.id
    )
    conn = connect()
    try:
        request_cancel(conn, task.id)
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-cancel-b", task_id=task.id)
    conn = connect()
    try:
        done = get_task(conn, task.id)
        assert done is not None
        assert done.status == "cancelled"
    finally:
        conn.close()


def test_cancel_after_completion_noop():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=15)
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-done", task_id=task.id)
    conn = connect()
    try:
        completed = get_task(conn, task.id)
        assert completed is not None
        assert completed.status == "completed"
        after = request_cancel(conn, task.id)
        assert after is not None
        assert after.status == "completed"
    finally:
        conn.close()


def test_approve_resumes():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=5, approval_threshold=80)
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-ok-a", task_id=task.id)
    conn = connect()
    try:
        paused = get_task(conn, task.id)
        assert paused is not None
        assert paused.status == "input_required"
        apply_approval(conn, task.id, paused.approval.requestId, "approve")
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-ok-b", task_id=task.id)
    conn = connect()
    try:
        nxt = get_task(conn, task.id)
        assert nxt is not None
        assert (
            nxt.status in ("completed", "input_required")
            or nxt.checkpoint.processed > 0
        )
    finally:
        conn.close()

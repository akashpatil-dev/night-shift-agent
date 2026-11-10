from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

os.environ.setdefault("APPROVAL_TTL_SECONDS", "60")

from night_shift.config import DEFAULT_OWNER
from night_shift.db import connect
from night_shift.server import start_server
from night_shift.store import (
    apply_approval,
    count_audit_writes,
    create_task,
    expire_approvals_and_ttl,
    get_task,
    get_task_for_owner,
    request_cancel,
    schedule_retry_or_dead_letter,
    update_task_fields,
    write_ticket_idempotent,
)
from night_shift.triage import make_ticket
from night_shift.worker import worker_loop


@pytest.fixture(scope="session", autouse=True)
def migrate_and_server():
    schema = Path(__file__).resolve().parents[2] / "sql" / "schema.sql"
    conn = connect()
    try:
        conn.execute(schema.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()
    server = start_server(host="127.0.0.1", port=0)
    import threading

    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield server
    server.shutdown()


@pytest.fixture(autouse=True)
def clean():
    conn = connect()
    try:
        conn.execute("TRUNCATE audit_writes, dead_letter, tasks CASCADE")
        conn.commit()
    finally:
        conn.close()
    yield


def test_resume_from_checkpoint():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=120, owner=DEFAULT_OWNER)
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
        assert count_audit_writes(conn, task.id) == 120
    finally:
        conn.close()


def test_idempotent_retry():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=10, owner=DEFAULT_OWNER)
        assert write_ticket_idempotent(
            conn, task_id=task.id, ticket_id=3, payload={"ticket": make_ticket(3)}, commit=True
        )
        assert not write_ticket_idempotent(
            conn,
            task_id=task.id,
            ticket_id=3,
            payload={"ticket": make_ticket(3), "retry": True},
            commit=True,
        )
        assert count_audit_writes(conn, task.id) == 1
    finally:
        conn.close()


def test_concurrent_idempotency():
    key = f"race-py-{os.getpid()}"

    def one():
        c = connect()
        try:
            return create_task(
                c, total_tickets=5, idempotency_key=key, owner=DEFAULT_OWNER
            ).id
        finally:
            c.close()

    with ThreadPoolExecutor(max_workers=6) as pool:
        ids = list(pool.map(lambda _: one(), range(6)))
    assert len(set(ids)) == 1
    conn = connect()
    try:
        n = conn.execute(
            "SELECT COUNT(*)::int AS n FROM tasks WHERE idempotency_key = %s", (key,)
        ).fetchone()["n"]
        assert n == 1
    finally:
        conn.close()


def test_approval_before_write_and_deny():
    conn = connect()
    try:
        task = create_task(
            conn, total_tickets=5, approval_threshold=80, owner=DEFAULT_OWNER
        )
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-before", task_id=task.id)
    conn = connect()
    try:
        paused = get_task(conn, task.id)
        assert paused is not None
        assert paused.status == "input_required"
        assert count_audit_writes(conn, task.id) == 0
        apply_approval(
            conn, task.id, paused.approval.requestId, "deny", DEFAULT_OWNER
        )
        assert count_audit_writes(conn, task.id) == 0
    finally:
        conn.close()


def test_owner_isolation():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=3, owner="alice")
        assert get_task_for_owner(conn, task.id, "bob") is None
        assert get_task_for_owner(conn, task.id, "alice") is not None
    finally:
        conn.close()


def test_retry_dead_letter():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=10, owner=DEFAULT_OWNER)
        current = task
        for _ in range(5):
            current = schedule_retry_or_dead_letter(conn, current, "boom")
            assert current is not None
        assert current.status == "failed"
        assert current.status_message == "dead_lettered"
        n = conn.execute(
            "SELECT COUNT(*)::int AS n FROM dead_letter WHERE task_id = %s",
            (task.id,),
        ).fetchone()["n"]
        assert n == 1
    finally:
        conn.close()


def test_rpc_invalid_task_id(migrate_and_server):
    port = migrate_and_server.server_address[1]

    def rpc(params, owner="demo-user"):
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tasks/get",
            "params": params,
        }
        req = Request(
            f"http://127.0.0.1:{port}/mcp",
            data=json.dumps(body).encode(),
            headers={
                "content-type": "application/json",
                "x-owner-id": owner,
                "x-mcp-tasks": "1",
            },
            method="POST",
        )
        with urlopen(req) as resp:
            return json.loads(resp.read().decode())

    bad = rpc({"taskId": "not-a-uuid"})
    assert bad["error"]["code"] == -32602

    conn = connect()
    try:
        task = create_task(conn, total_tickets=1, owner="alice")
    finally:
        conn.close()
    missing = rpc({"taskId": task.id}, owner="bob")
    assert missing["error"]["code"] == -32602


def test_cooperative_cancel():
    conn = connect()
    try:
        task = create_task(conn, total_tickets=200, owner=DEFAULT_OWNER)
    finally:
        conn.close()
    worker_loop(
        once=True, worker_id="py-cancel-a", crash_after_ticket=40, task_id=task.id
    )
    conn = connect()
    try:
        request_cancel(conn, task.id, DEFAULT_OWNER)
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-cancel-b", task_id=task.id)
    conn = connect()
    try:
        done = get_task(conn, task.id)
        assert done is not None
        assert done.status == "cancelled"
        assert "processed" in done.checkpoint.to_dict()
    finally:
        conn.close()


def test_approval_expiry():
    conn = connect()
    try:
        task = create_task(
            conn, total_tickets=5, approval_threshold=80, owner=DEFAULT_OWNER
        )
    finally:
        conn.close()
    worker_loop(once=True, worker_id="py-appr", task_id=task.id)
    conn = connect()
    try:
        paused = get_task(conn, task.id)
        assert paused is not None
        expired = paused.approval
        expired.expiresAt = (
            datetime.now(timezone.utc) - timedelta(seconds=1)
        ).isoformat()
        update_task_fields(conn, task.id, approval=expired)
        expire_approvals_and_ttl(conn)
        failed = get_task(conn, task.id)
        assert failed is not None
        assert failed.status == "failed"
    finally:
        conn.close()

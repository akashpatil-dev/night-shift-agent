from __future__ import annotations

import time

from night_shift.client import McpHttpClient
from night_shift.db import connect
from night_shift.store import count_audit_writes, get_task, write_ticket_idempotent
from night_shift.triage import make_ticket
from night_shift.worker import worker_loop


def main() -> None:
    print("=== Day 3: retry with no duplicate writes ===\n")
    client = McpHttpClient()
    created = client.triage_tickets(count=40, idempotencyKey=f"day3-py-{int(time.time())}")
    task_id = created["taskId"]

    worker_loop(
        once=True, worker_id="day3-a", crash_after_ticket=20, task_id=task_id
    )
    conn = connect()
    try:
        mid = get_task(conn, task_id)
        audit_before = count_audit_writes(conn, task_id)
        print(
            f"after crash: processed={mid.checkpoint.processed if mid else None} "
            f"audit_rows={audit_before}"
        )
        ticket_id = max(0, (mid.checkpoint.processed if mid else 1) - 1)
        inserted = write_ticket_idempotent(
            conn,
            task_id=task_id,
            ticket_id=ticket_id,
            payload={
                "action": "triage",
                "ticket": make_ticket(ticket_id),
                "retry": True,
            },
            commit=True,
        )
        print(f"forced retry write ticket {ticket_id}: inserted={inserted}")
        audit_after = count_audit_writes(conn, task_id)
        print(
            f"audit_rows after forced retry: {audit_after} "
            f"(unchanged={audit_after == audit_before})"
        )
    finally:
        conn.close()

    worker_loop(once=True, worker_id="day3-b", task_id=task_id)
    done = client.get_task(task_id)
    conn = connect()
    try:
        audit_final = count_audit_writes(conn, task_id)
    finally:
        conn.close()
    print(f"final status={done['status']} audit_rows={audit_final}")
    print(f"expected audit_rows == 40: {audit_final == 40}")


if __name__ == "__main__":
    main()

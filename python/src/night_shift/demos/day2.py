from __future__ import annotations

from night_shift.client import McpHttpClient
from night_shift.db import connect
from night_shift.store import get_task
from night_shift.worker import worker_loop


def main() -> None:
    print("=== Day 2: kill mid-run, resume from checkpoint ===\n")
    client = McpHttpClient()
    created = client.triage_tickets(count=200)
    task_id = created["taskId"]
    print(f"enqueued {task_id}")

    print("worker run 1: crash after ticket 75...")
    worker_loop(
        once=True, worker_id="day2-a", crash_after_ticket=75, task_id=task_id
    )
    conn = connect()
    try:
        mid = get_task(conn, task_id)
        print(
            f"  after crash: status={mid.status if mid else None} "
            f"processed={mid.checkpoint.processed if mid else None}"
        )
    finally:
        conn.close()

    print("worker run 2: resume from checkpoint...")
    worker_loop(once=True, worker_id="day2-b", task_id=task_id)
    done = client.get_task(task_id)
    print(f"  final: status={done['status']}")


if __name__ == "__main__":
    main()

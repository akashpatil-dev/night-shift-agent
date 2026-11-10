from __future__ import annotations

from night_shift.client import McpHttpClient
from night_shift.db import connect
from night_shift.store import get_task
from night_shift.worker import worker_loop


def main() -> None:
    print("=== Day 5: cancel mid-run and after completion ===\n")
    client = McpHttpClient()

    a = client.triage_tickets(count=500)
    print(f"task A {a['taskId']}: start then cancel")
    worker_loop(
        once=True, worker_id="day5-a", crash_after_ticket=60, task_id=a["taskId"]
    )
    client.cancel_task(a["taskId"])
    worker_loop(once=True, worker_id="day5-b", task_id=a["taskId"])
    conn = connect()
    try:
        final_a = get_task(conn, a["taskId"])
        print(
            f"  task A status={final_a.status if final_a else None} (expected cancelled)"
        )
    finally:
        conn.close()

    b = client.triage_tickets(count=30)
    worker_loop(once=True, worker_id="day5-c", task_id=b["taskId"])
    completed = client.get_task(b["taskId"])
    print(f"task B completed status={completed['status']}")
    client.cancel_task(b["taskId"])
    after = client.get_task(b["taskId"])
    print(
        f"  cancel after completion: status still {after['status']} "
        "(cooperative no-op on terminal)"
    )


if __name__ == "__main__":
    main()

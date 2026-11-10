from __future__ import annotations

from night_shift.client import McpHttpClient
from night_shift.worker import worker_loop


def main() -> None:
    import os

    os.environ.setdefault("APPROVAL_TTL_SECONDS", "60")
    print("=== Day 4: approval pause and resume ===\n")
    client = McpHttpClient()
    created = client.triage_tickets(count=40, approvalThreshold=80)
    task_id = created["taskId"]
    print(f"enqueued {task_id} with approvalThreshold=80")

    worker_loop(once=True, worker_id="day4-a", task_id=task_id)
    paused = client.get_task(task_id)
    print(f"status={paused['status']}")
    reqs = paused.get("inputRequests") or {}
    request_id = next(iter(reqs), None)
    print(f"approval request: {request_id}")
    if not request_id:
        raise RuntimeError("Expected input_required with an approval request")

    print("approving...")
    client.update_task(task_id, request_id, "approve")
    worker_loop(once=True, worker_id="day4-b", task_id=task_id)

    for i in range(20):
        task = client.get_task(task_id)
        if task["status"] in ("completed", "cancelled", "failed"):
            print(f"final status={task['status']}")
            break
        if task["status"] == "input_required":
            rid = next(iter(task.get("inputRequests") or {}))
            print(f"another approval {rid} - approving")
            client.update_task(task_id, rid, "approve")
        worker_loop(once=True, worker_id=f"day4-r{i}", task_id=task_id)


if __name__ == "__main__":
    main()

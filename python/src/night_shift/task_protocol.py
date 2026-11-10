from __future__ import annotations

from typing import Any

from .types import TaskRow, WireStatus


def to_wire_status(status: str) -> WireStatus:
    if status == "queued":
        return "working"
    return status  # type: ignore[return-value]


def to_task_response(task: TaskRow) -> dict[str, Any]:
    status = to_wire_status(task.status)
    base: dict[str, Any] = {
        "resultType": "complete",
        "taskId": task.id,
        "status": status,
        "statusMessage": "queued" if task.status == "queued" else task.status_message,
        "createdAt": task.created_at.isoformat(),
        "lastUpdatedAt": task.updated_at.isoformat(),
        "ttlMs": task.ttl_ms,
        "pollIntervalMs": task.poll_interval_ms,
    }
    if status == "working":
        base["progress"] = {
            "processed": task.checkpoint.processed,
            "total": task.total_tickets,
            "nextTicket": task.checkpoint.next_ticket,
        }
    elif status == "input_required" and task.approval:
        base["inputRequests"] = {
            task.approval.requestId: {
                "type": "approval",
                "message": task.approval.message,
                "ticketId": task.approval.ticketId,
                "expiresAt": task.approval.expiresAt,
            }
        }
    elif status == "completed":
        base["result"] = task.result
    elif status == "failed":
        base["error"] = task.error
    return base


def create_task_result(task: TaskRow) -> dict[str, Any]:
    return {
        "resultType": "task",
        "taskId": task.id,
        "status": to_wire_status(task.status),
        "statusMessage": "queued" if task.status == "queued" else task.status_message,
        "createdAt": task.created_at.isoformat(),
        "lastUpdatedAt": task.updated_at.isoformat(),
        "ttlMs": task.ttl_ms,
        "pollIntervalMs": task.poll_interval_ms,
    }

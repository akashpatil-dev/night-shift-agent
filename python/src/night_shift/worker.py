from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from .config import APPROVAL_TTL_MS, CHECKPOINT_EVERY, LEASE_HEARTBEAT_MS, TICKET_DELAY_MS
from .db import connect
from .logging_util import log
from .metrics import inc
from .queue import claim_next_task, renew_lease
from .store import (
    expire_approvals_and_ttl,
    get_task,
    schedule_retry_or_dead_letter,
    update_task_fields,
    write_ticket_idempotent,
)
from .triage import make_ticket, needs_approval
from .types import ApprovalState, Checkpoint, TaskRow


def process_ticket(conn, task: TaskRow, ticket_id: int) -> tuple[bool, ApprovalState | None]:
    ticket = make_ticket(ticket_id)

    # Approval BEFORE any side-effect write
    if needs_approval(ticket["severity"], task.approval_threshold):
        already = (
            task.approval
            and task.approval.ticketId == ticket_id
            and task.approval.decision == "approve"
        )
        if not already:
            approval = ApprovalState(
                requestId=str(uuid.uuid4()),
                message=f"Approve triage of high-severity ticket #{ticket_id}?",
                ticketId=ticket_id,
                expiresAt=(
                    datetime.now(timezone.utc)
                    + timedelta(milliseconds=APPROVAL_TTL_MS)
                ).isoformat(),
            )
            update_task_fields(
                conn,
                task.id,
                status="input_required",
                approval=approval,
                status_message="awaiting_approval",
                locked_by=None,
                locked_until=None,
                checkpoint=Checkpoint(processed=ticket_id, next_ticket=ticket_id),
            )
            return True, approval

    with conn.transaction():
        write_ticket_idempotent(
            conn,
            task_id=task.id,
            ticket_id=ticket_id,
            payload={"action": "triage", "ticket": ticket},
            commit=False,
        )
    return False, None


def run_task(
    conn,
    task: TaskRow,
    worker_id: str,
    *,
    crash_after_ticket: int | None = None,
) -> str:
    if crash_after_ticket is None and os.environ.get("CRASH_AFTER_TICKET"):
        crash_after_ticket = int(os.environ["CRASH_AFTER_TICKET"])

    current = task
    ticket_id = current.checkpoint.next_ticket
    stop_hb = threading.Event()

    def heartbeat() -> None:
        while not stop_hb.wait(LEASE_HEARTBEAT_MS / 1000.0):
            try:
                renew_lease(conn, current.id, worker_id)
            except Exception:  # noqa: BLE001
                pass

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()

    try:
        log.info(
            "task_started",
            task_id=current.id,
            trace_id=current.trace_id,
            attempt=current.attempt_count,
            next_ticket=ticket_id,
        )

        while ticket_id < current.total_tickets:
            fresh = get_task(conn, current.id)
            if not fresh:
                return "cancelled"
            current = fresh

            if current.cancel_requested:
                update_task_fields(
                    conn,
                    current.id,
                    status="cancelled",
                    status_message="cancelled",
                    locked_by=None,
                    locked_until=None,
                    checkpoint=Checkpoint(processed=ticket_id, next_ticket=ticket_id),
                )
                inc("tasks_cancelled")
                log.info(
                    "task_cancelled",
                    task_id=current.id,
                    trace_id=current.trace_id,
                    ticket=ticket_id,
                )
                return "cancelled"

            if current.status == "input_required":
                return "paused"

            paused, approval = process_ticket(conn, current, ticket_id)
            if paused:
                log.info(
                    "task_input_required",
                    task_id=current.id,
                    trace_id=current.trace_id,
                    ticket=ticket_id,
                    request_id=approval.requestId if approval else None,
                )
                return "paused"

            ticket_id += 1
            checkpoint = Checkpoint(processed=ticket_id, next_ticket=ticket_id)

            if ticket_id % CHECKPOINT_EVERY == 0 or ticket_id >= current.total_tickets:
                update_task_fields(conn, current.id, checkpoint=checkpoint)
                log.info(
                    "checkpoint",
                    task_id=current.id,
                    trace_id=current.trace_id,
                    processed=checkpoint.processed,
                    total=current.total_tickets,
                )

            if crash_after_ticket is not None and ticket_id >= crash_after_ticket:
                update_task_fields(
                    conn,
                    current.id,
                    checkpoint=checkpoint,
                    locked_until=datetime(1970, 1, 1, tzinfo=timezone.utc),
                    status_message="crashed",
                )
                log.warn(
                    "simulated_crash",
                    task_id=current.id,
                    trace_id=current.trace_id,
                    ticket=ticket_id,
                )
                return "crashed"

            if TICKET_DELAY_MS > 0:
                time.sleep(TICKET_DELAY_MS / 1000.0)

        update_task_fields(
            conn,
            current.id,
            status="completed",
            checkpoint=Checkpoint(
                processed=current.total_tickets, next_ticket=current.total_tickets
            ),
            result={
                "triaged": current.total_tickets,
                "message": f"Triaged {current.total_tickets} tickets",
            },
            status_message="completed",
            locked_by=None,
            locked_until=None,
        )
        inc("tasks_completed")
        log.info("task_completed", task_id=current.id, trace_id=current.trace_id)
        return "completed"
    finally:
        stop_hb.set()


def worker_loop(
    *,
    worker_id: str | None = None,
    once: bool = False,
    idle_ms: int = 250,
    crash_after_ticket: int | None = None,
    task_id: str | None = None,
) -> None:
    worker_id = worker_id or f"worker-{os.getpid()}"
    log.info("worker_started", worker_id=worker_id)
    conn = connect()
    try:
        while True:
            expire_approvals_and_ttl(conn)
            task = claim_next_task(conn, worker_id, task_id)
            if not task:
                if once:
                    return
                time.sleep(idle_ms / 1000.0)
                continue
            try:
                run_task(
                    conn,
                    task,
                    worker_id,
                    crash_after_ticket=crash_after_ticket,
                )
            except Exception as err:  # noqa: BLE001
                log.error(
                    "task_failed",
                    task_id=task.id,
                    trace_id=task.trace_id,
                    error=str(err),
                )
                schedule_retry_or_dead_letter(conn, task, str(err))
            if once:
                return
    finally:
        conn.close()


if __name__ == "__main__":
    worker_loop(
        task_id=os.environ.get("TASK_ID") or None,
        crash_after_ticket=(
            int(os.environ["CRASH_AFTER_TICKET"])
            if os.environ.get("CRASH_AFTER_TICKET")
            else None
        ),
    )

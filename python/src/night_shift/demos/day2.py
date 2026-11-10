from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

from night_shift.client import McpHttpClient
from night_shift.db import connect
from night_shift.store import count_audit_writes, get_task
from night_shift.worker import worker_loop


def main() -> None:
    print("=== Day 2: kill -9 worker mid-run, resume from checkpoint ===\n")
    client = McpHttpClient()
    created = client.triage_tickets(count=200)
    task_id = created["taskId"]
    print(f"enqueued {task_id}")

    env = {**os.environ, "TASK_ID": task_id}
    env.pop("CRASH_AFTER_TICKET", None)
    child = subprocess.Popen(
        [sys.executable, "-m", "night_shift.worker"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    while True:
        conn = connect()
        try:
            t = get_task(conn, task_id)
            if t and t.checkpoint.processed >= 50:
                mid = t
                audit_mid = count_audit_writes(conn, task_id)
                break
        finally:
            conn.close()
        time.sleep(0.05)

    print(f"before kill: processed={mid.checkpoint.processed} audit_rows={audit_mid}")
    print(f"killing worker pid={child.pid} (SIGKILL)...")
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(child.pid)], check=False)
    else:
        os.kill(child.pid, signal.SIGKILL)
    time.sleep(0.4)

    conn = connect()
    try:
        conn.execute(
            """
            UPDATE tasks
            SET locked_until = now() - interval '1 second',
                status = 'queued',
                status_message = 'reclaimed_after_kill',
                updated_at = now()
            WHERE id = %s AND status = 'working'
            """,
            (task_id,),
        )
        conn.commit()
    finally:
        conn.close()

    worker_loop(once=True, worker_id="day2-resume", task_id=task_id)
    done = client.get_task(task_id)
    conn = connect()
    try:
        audit_final = count_audit_writes(conn, task_id)
    finally:
        conn.close()
    print(f"final: status={done['status']} audit_rows={audit_final}")
    print(
        f"resumed from {mid.checkpoint.processed}; "
        f"no duplicate writes={audit_final == 200}"
    )


if __name__ == "__main__":
    main()

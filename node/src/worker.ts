import { randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  CHECKPOINT_EVERY,
  TICKET_DELAY_MS,
} from "./config.js";
import { pool, withTransaction } from "./db.js";
import { log } from "./logging.js";
import { claimNextTask, renewLease } from "./queue.js";
import {
  expireApprovalsAndTtl,
  getTask,
  updateTaskFields,
  writeTicketIdempotent,
} from "./store.js";
import { makeTicket, needsApproval } from "./triage.js";
import type { ApprovalState, TaskRow } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function processTicket(
  task: TaskRow,
  ticketId: number,
): Promise<{ paused: boolean; approval?: ApprovalState }> {
  const ticket = makeTicket(ticketId);

  await withTransaction(async (client) => {
    await writeTicketIdempotent(client, {
      taskId: task.id,
      ticketId,
      payload: { action: "triage", ticket },
    });
  });

  if (needsApproval(ticket.severity, task.approval_threshold)) {
    const already =
      task.approval?.ticketId === ticketId && task.approval.decision === "approve";
    if (!already) {
      const approval: ApprovalState = {
        requestId: randomUUID(),
        message: `Approve triage of high-severity ticket #${ticketId}?`,
        ticketId,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      };
      await updateTaskFields(pool, task.id, {
        status: "input_required",
        approval,
        status_message: "awaiting_approval",
        locked_by: null,
        locked_until: null,
        checkpoint: {
          processed: ticketId,
          next_ticket: ticketId,
        },
      });
      return { paused: true, approval };
    }
  }

  return { paused: false };
}

export type RunTaskOptions = {
  /** Simulate a crash after writing this many tickets in this run (absolute next_ticket). */
  crashAfterTicket?: number;
};

/** Process a single claimed task until pause, cancel, crash, or completion. */
export async function runTask(
  task: TaskRow,
  workerId: string,
  opts: RunTaskOptions = {},
): Promise<"completed" | "paused" | "cancelled" | "crashed"> {
  let current = task;
  let ticketId = current.checkpoint.next_ticket;
  const crashAfter =
    opts.crashAfterTicket ??
    (process.env.CRASH_AFTER_TICKET
      ? Number(process.env.CRASH_AFTER_TICKET)
      : undefined);

  log.info("task_started", {
    task_id: current.id,
    attempt: current.attempts,
    next_ticket: ticketId,
  });

  while (ticketId < current.total_tickets) {
    const fresh = await getTask(pool, current.id);
    if (!fresh) return "cancelled";
    current = fresh;

    if (current.cancel_requested) {
      await updateTaskFields(pool, current.id, {
        status: "cancelled",
        status_message: "cancelled",
        locked_by: null,
        locked_until: null,
        checkpoint: { processed: ticketId, next_ticket: ticketId },
      });
      log.info("task_cancelled", { task_id: current.id, ticket: ticketId });
      return "cancelled";
    }

    if (current.status === "input_required") {
      log.info("task_waiting_approval", { task_id: current.id });
      return "paused";
    }

    const step = await processTicket(current, ticketId);
    if (step.paused) {
      log.info("task_input_required", {
        task_id: current.id,
        ticket: ticketId,
        request_id: step.approval?.requestId,
      });
      return "paused";
    }

    ticketId += 1;
    const checkpoint = { processed: ticketId, next_ticket: ticketId };

    if (ticketId % CHECKPOINT_EVERY === 0 || ticketId >= current.total_tickets) {
      await updateTaskFields(pool, current.id, { checkpoint });
      await renewLease(pool, current.id, workerId);
      log.info("checkpoint", {
        task_id: current.id,
        processed: checkpoint.processed,
        total: current.total_tickets,
      });
    }

    if (crashAfter !== undefined && ticketId >= crashAfter) {
      // Leave status=working with an expired-looking lease so another worker can reclaim.
      await updateTaskFields(pool, current.id, {
        checkpoint,
        locked_until: new Date(0),
        status_message: "crashed",
      });
      log.warn("simulated_crash", { task_id: current.id, ticket: ticketId });
      return "crashed";
    }

    if (TICKET_DELAY_MS > 0) await sleep(TICKET_DELAY_MS);
  }

  await updateTaskFields(pool, current.id, {
    status: "completed",
    checkpoint: {
      processed: current.total_tickets,
      next_ticket: current.total_tickets,
    },
    result: {
      triaged: current.total_tickets,
      message: `Triaged ${current.total_tickets} tickets`,
    },
    status_message: "completed",
    locked_by: null,
    locked_until: null,
  });
  log.info("task_completed", { task_id: current.id });
  return "completed";
}

export async function workerLoop(opts?: {
  workerId?: string;
  once?: boolean;
  idleMs?: number;
  crashAfterTicket?: number;
  /** When set, only claim this task (demos/tests). */
  taskId?: string;
}): Promise<void> {
  const workerId = opts?.workerId ?? `worker-${process.pid}`;
  const idleMs = opts?.idleMs ?? 250;

  log.info("worker_started", { worker_id: workerId });

  for (;;) {
    await expireApprovalsAndTtl(pool);
    const task = await claimNextTask(pool, workerId, opts?.taskId);
    if (!task) {
      if (opts?.once) return;
      await sleep(idleMs);
      continue;
    }
    try {
      await runTask(task, workerId, { crashAfterTicket: opts?.crashAfterTicket });
    } catch (err) {
      log.error("task_failed", {
        task_id: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await updateTaskFields(pool, task.id, {
        status: "failed",
        error: {
          code: "worker_error",
          message: err instanceof Error ? err.message : String(err),
        },
        status_message: "failed",
        locked_by: null,
        locked_until: null,
      });
    }
    if (opts?.once) return;
  }
}

const isMain = process.argv[1]?.includes("worker");
if (isMain) {
  workerLoop().catch((err) => {
    log.error("worker_crash", { error: String(err) });
    process.exit(1);
  });
}

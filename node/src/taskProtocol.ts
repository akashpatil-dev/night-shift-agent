import type { TaskRow, WireStatus } from "./types.js";

/** Map internal store status to SEP-2663 wire status. */
export function toWireStatus(status: TaskRow["status"]): WireStatus {
  if (status === "queued") return "working";
  return status;
}

export function toTaskResponse(task: TaskRow) {
  const status = toWireStatus(task.status);
  const ttlMs =
    task.ttl_ms === null || task.ttl_ms === undefined ? null : Number(task.ttl_ms);

  const base = {
    resultType: "complete" as const,
    taskId: task.id,
    status,
    statusMessage:
      task.status === "queued"
        ? "queued"
        : task.status_message ?? undefined,
    createdAt: task.created_at.toISOString(),
    lastUpdatedAt: task.updated_at.toISOString(),
    ttlMs,
    pollIntervalMs: task.poll_interval_ms,
  };

  if (status === "working") {
    return {
      ...base,
      progress: {
        processed: task.checkpoint.processed,
        total: task.total_tickets,
        nextTicket: task.checkpoint.next_ticket,
      },
    };
  }

  if (status === "input_required" && task.approval) {
    return {
      ...base,
      inputRequests: {
        [task.approval.requestId]: {
          type: "approval",
          message: task.approval.message,
          ticketId: task.approval.ticketId,
          expiresAt: task.approval.expiresAt,
        },
      },
    };
  }

  if (status === "completed") {
    return { ...base, result: task.result };
  }

  if (status === "failed") {
    return { ...base, error: task.error };
  }

  return base;
}

export function createTaskResult(task: TaskRow) {
  return {
    resultType: "task" as const,
    taskId: task.id,
    status: toWireStatus(task.status),
    statusMessage: task.status === "queued" ? "queued" : task.status_message ?? undefined,
    createdAt: task.created_at.toISOString(),
    lastUpdatedAt: task.updated_at.toISOString(),
    ttlMs: task.ttl_ms === null || task.ttl_ms === undefined ? null : Number(task.ttl_ms),
    pollIntervalMs: task.poll_interval_ms,
  };
}

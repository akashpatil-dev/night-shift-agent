import { HOST, PORT } from "./config.js";

export type RpcResponse = {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpHttpClient {
  constructor(private baseUrl = `http://${HOST}:${PORT}/mcp`) {}

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    const body = (await res.json()) as RpcResponse;
    if (body.error) {
      throw new Error(`${body.error.code}: ${body.error.message}`);
    }
    return body.result;
  }

  triageTickets(args: {
    count: number;
    approvalThreshold?: number;
    idempotencyKey?: string;
    ttlMs?: number;
  }) {
    return this.call("tools/call", {
      name: "triage_tickets",
      arguments: args,
    }) as Promise<{ taskId: string; status: string }>;
  }

  getTask(taskId: string) {
    return this.call("tasks/get", { taskId }) as Promise<Record<string, unknown>>;
  }

  updateTask(
    taskId: string,
    requestId: string,
    decision: "approve" | "deny",
  ) {
    return this.call("tasks/update", {
      taskId,
      inputResponses: { [requestId]: { decision } },
    }) as Promise<Record<string, unknown>>;
  }

  cancelTask(taskId: string) {
    return this.call("tasks/cancel", { taskId });
  }

  async waitForStatus(
    taskId: string,
    statuses: string[],
    opts?: { timeoutMs?: number; pollMs?: number },
  ) {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const pollMs = opts?.pollMs ?? 100;
    const start = Date.now();
    for (;;) {
      const task = await this.getTask(taskId);
      const status = String(task.status);
      const message = String(task.statusMessage ?? "");
      if (statuses.includes(status) || statuses.includes(message)) {
        return task;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout waiting for ${statuses.join("|")} (last=${status}/${message})`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

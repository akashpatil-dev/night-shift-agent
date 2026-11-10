import { DEFAULT_OWNER, HOST, PORT } from "./config.js";

export type RpcResponse = {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpHttpClient {
  constructor(
    private baseUrl = `http://${HOST}:${PORT}/mcp`,
    private owner = DEFAULT_OWNER,
    private tasksCapable = true,
  ) {}

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const withMeta =
      method === "tools/call" && this.tasksCapable
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: { "io.modelcontextprotocol/tasks": {} },
              },
            },
          }
        : params;

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-id": this.owner,
        "x-mcp-tasks": this.tasksCapable ? "1" : "0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params: withMeta,
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

  updateTask(taskId: string, requestId: string, decision: "approve" | "deny") {
    return this.call("tasks/update", {
      taskId,
      inputResponses: { [requestId]: { decision } },
    }) as Promise<Record<string, unknown>>;
  }

  cancelTask(taskId: string) {
    return this.call("tasks/cancel", { taskId });
  }
}

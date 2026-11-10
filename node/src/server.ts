import { createServer } from "node:http";
import { z } from "zod";
import { DEFAULT_TTL_MS, HOST, PORT } from "./config.js";
import { pool } from "./db.js";
import { log } from "./logging.js";
import {
  applyApproval,
  createTask,
  expireApprovalsAndTtl,
  getTask,
  requestCancel,
} from "./store.js";
import { createTaskResult, toTaskResponse } from "./taskProtocol.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const triageSchema = z.object({
  count: z.number().int().positive().max(100_000),
  approvalThreshold: z.number().int().min(0).max(100).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  ttlMs: z.number().int().positive().optional(),
});

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handleToolsCall(params: Record<string, unknown>) {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  if (name === "triage_tickets") {
    const parsed = triageSchema.parse(args);
    const task = await createTask(pool, {
      totalTickets: parsed.count,
      approvalThreshold: parsed.approvalThreshold,
      idempotencyKey: parsed.idempotencyKey,
      ttlMs: parsed.ttlMs ?? DEFAULT_TTL_MS,
    });
    return createTaskResult(task);
  }

  if (name === "get_task") {
    const taskId = String(args.taskId ?? "");
    const task = await getTask(pool, taskId);
    if (!task) throw Object.assign(new Error("Unknown task"), { code: -32001 });
    return toTaskResponse(task);
  }

  if (name === "update_task") {
    const taskId = String(args.taskId ?? "");
    const requestId = String(args.requestId ?? "");
    const decision = String(args.decision ?? "");
    if (decision !== "approve" && decision !== "deny") {
      throw new Error("decision must be approve or deny");
    }
    const task = await applyApproval(pool, taskId, requestId, decision);
    if (!task) throw Object.assign(new Error("Unknown task"), { code: -32001 });
    return toTaskResponse(task);
  }

  if (name === "cancel_task") {
    const taskId = String(args.taskId ?? "");
    const task = await requestCancel(pool, taskId);
    if (!task) throw Object.assign(new Error("Unknown task"), { code: -32001 });
    return { resultType: "complete", acknowledged: true, taskId };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}

async function handleRpc(body: JsonRpcRequest) {
  const method = body.method ?? "";
  const params = body.params ?? {};
  const id = body.id;

  try {
    if (method === "initialize" || method === "server/discover") {
      return rpcResult(id, {
        protocolVersion: "2026-07-28",
        capabilities: {
          tools: {},
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        serverInfo: { name: "night-shift-agent-node", version: "0.1.0" },
      });
    }

    if (method === "tools/list") {
      return rpcResult(id, {
        tools: [
          {
            name: "triage_tickets",
            description:
              "Enqueue triage of N fake support tickets and return a task handle immediately.",
            inputSchema: {
              type: "object",
              properties: {
                count: { type: "number" },
                approvalThreshold: { type: "number" },
                idempotencyKey: { type: "string" },
              },
              required: ["count"],
            },
          },
          {
            name: "get_task",
            description: "Tool shim for tasks/get (also available as tasks/get).",
            inputSchema: {
              type: "object",
              properties: { taskId: { type: "string" } },
              required: ["taskId"],
            },
          },
          {
            name: "update_task",
            description: "Tool shim for tasks/update (approve/deny).",
            inputSchema: {
              type: "object",
              properties: {
                taskId: { type: "string" },
                requestId: { type: "string" },
                decision: { type: "string", enum: ["approve", "deny"] },
              },
              required: ["taskId", "requestId", "decision"],
            },
          },
          {
            name: "cancel_task",
            description: "Tool shim for tasks/cancel.",
            inputSchema: {
              type: "object",
              properties: { taskId: { type: "string" } },
              required: ["taskId"],
            },
          },
        ],
      });
    }

    if (method === "tools/call") {
      const result = await handleToolsCall(params);
      return rpcResult(id, result);
    }

    // SEP-2663 native methods
    if (method === "tasks/get") {
      const taskId = String(params.taskId ?? "");
      const task = await getTask(pool, taskId);
      if (!task) return rpcError(id, -32001, "Unknown task");
      return rpcResult(id, toTaskResponse(task));
    }

    if (method === "tasks/update") {
      const taskId = String(params.taskId ?? "");
      const inputResponses = (params.inputResponses ?? {}) as Record<
        string,
        { decision?: string }
      >;
      const entries = Object.entries(inputResponses);
      if (entries.length === 0) {
        return rpcError(id, -32602, "inputResponses required");
      }
      const [requestId, response] = entries[0];
      const decision = response.decision;
      if (decision !== "approve" && decision !== "deny") {
        return rpcError(id, -32602, "decision must be approve or deny");
      }
      const task = await applyApproval(pool, taskId, requestId, decision);
      if (!task) return rpcError(id, -32001, "Unknown task");
      return rpcResult(id, toTaskResponse(task));
    }

    if (method === "tasks/cancel") {
      const taskId = String(params.taskId ?? "");
      const task = await requestCancel(pool, taskId);
      if (!task) return rpcError(id, -32001, "Unknown task");
      return rpcResult(id, { resultType: "complete" });
    }

    if (method === "ping") {
      return rpcResult(id, {});
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const code = (err as { code?: number }).code ?? -32000;
    return rpcError(id, code, err instanceof Error ? err.message : String(err));
  }
}

export function startServer(port = PORT, host = HOST) {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && (req.url === "/mcp" || req.url === "/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: JsonRpcRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
        return;
      }
      await expireApprovalsAndTtl(pool);
      const response = await handleRpc(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404).end("Not found");
  });

  server.listen(port, host, () => {
    log.info("server_listening", { host, port, endpoint: `http://${host}:${port}/mcp` });
  });

  return server;
}

const isMain = process.argv[1]?.includes("server");
if (isMain) {
  startServer();
}

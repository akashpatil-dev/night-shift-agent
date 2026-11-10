import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import {
  clientDeclaresTasks,
  isApprover,
  isUuid,
  ownerFromHeaders,
  resolveTraceId,
} from "./auth.js";
import { DEFAULT_TTL_MS, HOST, PORT, SYNC_MAX_TICKETS } from "./config.js";
import { pool } from "./db.js";
import { log } from "./logging.js";
import { inc, prometheusText } from "./metrics.js";
import {
  applyApproval,
  createTask,
  expireApprovalsAndTtl,
  getTaskForOwner,
  requestCancel,
} from "./store.js";
import { createTaskResult, toTaskResponse, updateAck } from "./taskProtocol.js";
import { workerLoop } from "./worker.js";

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

function parseTaskId(raw: unknown): { ok: true; id: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "taskId is required" };
  }
  if (!isUuid(raw)) {
    return { ok: false, message: "taskId must be a UUID" };
  }
  return { ok: true, id: raw };
}

function headersOf(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return req.headers as Record<string, string | string[] | undefined>;
}

async function handleToolsCall(
  params: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  tasksCapable: boolean,
) {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const owner = ownerFromHeaders(headers);
  const traceId = resolveTraceId(headers, (params._meta as Record<string, unknown>) ?? {});

  if (name === "triage_tickets") {
    const parsed = triageSchema.parse(args);
    if (!tasksCapable) {
      if (parsed.count > SYNC_MAX_TICKETS) {
        throw Object.assign(
          new Error(
            "Client did not declare io.modelcontextprotocol/tasks; use tool shims get_task/update_task/cancel_task after enabling Tasks, or reduce count for sync mode",
          ),
          {
            code: -32021,
            data: {
              requiredCapabilities: {
                extensions: { "io.modelcontextprotocol/tasks": {} },
              },
            },
          },
        );
      }
      const task = await createTask(pool, {
        totalTickets: parsed.count,
        approvalThreshold: parsed.approvalThreshold,
        idempotencyKey: parsed.idempotencyKey,
        ttlMs: parsed.ttlMs ?? DEFAULT_TTL_MS,
        owner,
        traceId,
      });
      if (!parsed.idempotencyKey) inc("tasks_created");
      await workerLoop({ once: true, taskId: task.id, workerId: `sync-${process.pid}` });
      const done = await getTaskForOwner(pool, task.id, owner);
      return {
        resultType: "complete",
        content: [
          {
            type: "text",
            text: JSON.stringify(done?.result ?? { taskId: task.id }),
          },
        ],
      };
    }

    const before = parsed.idempotencyKey
      ? await pool.query(`SELECT id FROM tasks WHERE idempotency_key = $1`, [
          parsed.idempotencyKey,
        ])
      : null;
    const task = await createTask(pool, {
      totalTickets: parsed.count,
      approvalThreshold: parsed.approvalThreshold,
      idempotencyKey: parsed.idempotencyKey,
      ttlMs: parsed.ttlMs ?? DEFAULT_TTL_MS,
      owner,
      traceId,
    });
    if (!before?.rows[0]) inc("tasks_created");
    return createTaskResult(task);
  }

  if (name === "get_task") {
    const parsed = parseTaskId(args.taskId);
    if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: -32602 });
    const task = await getTaskForOwner(pool, parsed.id, owner);
    if (!task) throw Object.assign(new Error("Invalid params"), { code: -32602 });
    return toTaskResponse(task);
  }

  if (name === "update_task") {
    if (!isApprover(owner)) {
      throw Object.assign(new Error("Invalid params"), { code: -32602 });
    }
    const parsed = parseTaskId(args.taskId);
    if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: -32602 });
    const decision = String(args.decision ?? "");
    if (decision !== "approve" && decision !== "deny") {
      throw Object.assign(new Error("decision must be approve or deny"), { code: -32602 });
    }
    const task = await applyApproval(
      pool,
      parsed.id,
      String(args.requestId ?? ""),
      decision,
      owner,
    );
    if (!task) throw Object.assign(new Error("Invalid params"), { code: -32602 });
    return updateAck(task);
  }

  if (name === "cancel_task") {
    const parsed = parseTaskId(args.taskId);
    if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: -32602 });
    const task = await requestCancel(pool, parsed.id, owner);
    if (!task) throw Object.assign(new Error("Invalid params"), { code: -32602 });
    return { resultType: "complete", acknowledged: true, taskId: task.id };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
}

async function handleRpc(
  body: JsonRpcRequest,
  headers: Record<string, string | string[] | undefined>,
) {
  const method = body.method ?? "";
  const params = body.params ?? {};
  const id = body.id;
  const owner = ownerFromHeaders(headers);
  const tasksCapable = clientDeclaresTasks(params, headers);

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
            description: "Tool shim for tasks/get.",
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
      const result = await handleToolsCall(params, headers, tasksCapable);
      return rpcResult(id, result);
    }

    if (method === "tasks/get") {
      const parsed = parseTaskId(params.taskId);
      if (!parsed.ok) return rpcError(id, -32602, parsed.message);
      const task = await getTaskForOwner(pool, parsed.id, owner);
      if (!task) return rpcError(id, -32602, "Invalid params");
      return rpcResult(id, toTaskResponse(task));
    }

    if (method === "tasks/update") {
      if (!isApprover(owner)) return rpcError(id, -32602, "Invalid params");
      const parsed = parseTaskId(params.taskId);
      if (!parsed.ok) return rpcError(id, -32602, parsed.message);
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
      const task = await applyApproval(pool, parsed.id, requestId, decision, owner);
      if (!task) return rpcError(id, -32602, "Invalid params");
      return rpcResult(id, updateAck(task));
    }

    if (method === "tasks/cancel") {
      const parsed = parseTaskId(params.taskId);
      if (!parsed.ok) return rpcError(id, -32602, parsed.message);
      const task = await requestCancel(pool, parsed.id, owner);
      if (!task) return rpcError(id, -32602, "Invalid params");
      return rpcResult(id, { resultType: "complete" });
    }

    if (method === "ping") return rpcResult(id, {});

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const code = (err as { code?: number }).code ?? -32000;
    const data = (err as { data?: unknown }).data;
    const message = err instanceof Error ? err.message : String(err);
    // Never leak Postgres codes
    if (/22P02|invalid input syntax/i.test(message)) {
      return rpcError(id, -32602, "Invalid params");
    }
    return rpcError(id, code, message, data);
  }
}

export function startServer(port = PORT, host = HOST): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(prometheusText());
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
      const response = await handleRpc(body, headersOf(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404).end("Not found");
  });

  server.listen(port, host, () => {
    log.info("server_listening", {
      host,
      port,
      endpoint: `http://${host}:${port}/mcp`,
    });
  });

  return server;
}

const isMain = process.argv[1]?.includes("server");
if (isMain) {
  startServer();
}

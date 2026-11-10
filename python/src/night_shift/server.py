from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .config import DEFAULT_TTL_MS, HOST, PORT
from .db import connect
from .logging_util import log
from .store import (
    apply_approval,
    create_task,
    expire_approvals_and_ttl,
    get_task,
    request_cancel,
)
from .task_protocol import create_task_result, to_task_response

"""
MCP Tasks gap (Python):
The official `mcp` SDK does not yet implement SEP-2663 (`tasks/get`,
`tasks/update`, `tasks/cancel`). This server exposes equivalent **tools**
(`get_task`, `update_task`, `cancel_task`) returning the same JSON shapes.
For demo parity we also accept the native method names over this HTTP
JSON-RPC surface - that is a local shim, not SDK support.
"""


def _rpc_result(id_: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _rpc_error(id_: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id_, "error": err}


def handle_tools_call(conn, params: dict[str, Any]) -> Any:
    name = str(params.get("name") or "")
    args = params.get("arguments") or {}

    if name == "triage_tickets":
        task = create_task(
            conn,
            total_tickets=int(args["count"]),
            approval_threshold=args.get("approvalThreshold"),
            idempotency_key=args.get("idempotencyKey"),
            ttl_ms=int(args.get("ttlMs") or DEFAULT_TTL_MS),
        )
        return create_task_result(task)

    if name == "get_task":
        task = get_task(conn, str(args["taskId"]))
        if not task:
            raise KeyError("Unknown task")
        return to_task_response(task)

    if name == "update_task":
        decision = str(args.get("decision") or "")
        if decision not in ("approve", "deny"):
            raise ValueError("decision must be approve or deny")
        task = apply_approval(
            conn, str(args["taskId"]), str(args["requestId"]), decision
        )
        if not task:
            raise KeyError("Unknown task")
        return to_task_response(task)

    if name == "cancel_task":
        task = request_cancel(conn, str(args["taskId"]))
        if not task:
            raise KeyError("Unknown task")
        return {"resultType": "complete", "acknowledged": True, "taskId": task.id}

    raise LookupError(f"Unknown tool: {name}")


def handle_rpc(body: dict[str, Any]) -> dict[str, Any]:
    method = body.get("method") or ""
    params = body.get("params") or {}
    id_ = body.get("id")
    conn = connect()
    try:
        expire_approvals_and_ttl(conn)

        if method in ("initialize", "server/discover"):
            return _rpc_result(
                id_,
                {
                    "protocolVersion": "2026-07-28",
                    "capabilities": {
                        "tools": {},
                        # Advertised for demos; official SDK Tasks support is absent.
                        "extensions": {"io.modelcontextprotocol/tasks": {}},
                    },
                    "serverInfo": {
                        "name": "night-shift-agent-python",
                        "version": "0.1.0",
                        "tasksShim": True,
                    },
                },
            )

        if method == "tools/list":
            return _rpc_result(
                id_,
                {
                    "tools": [
                        {
                            "name": "triage_tickets",
                            "description": "Enqueue triage of N fake tickets; returns task handle.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "count": {"type": "number"},
                                    "approvalThreshold": {"type": "number"},
                                    "idempotencyKey": {"type": "string"},
                                },
                                "required": ["count"],
                            },
                        },
                        {
                            "name": "get_task",
                            "description": "SEP-2663 tasks/get shim (official Python SDK lacks Tasks).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"taskId": {"type": "string"}},
                                "required": ["taskId"],
                            },
                        },
                        {
                            "name": "update_task",
                            "description": "SEP-2663 tasks/update shim (approve/deny).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "taskId": {"type": "string"},
                                    "requestId": {"type": "string"},
                                    "decision": {
                                        "type": "string",
                                        "enum": ["approve", "deny"],
                                    },
                                },
                                "required": ["taskId", "requestId", "decision"],
                            },
                        },
                        {
                            "name": "cancel_task",
                            "description": "SEP-2663 tasks/cancel shim.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"taskId": {"type": "string"}},
                                "required": ["taskId"],
                            },
                        },
                    ]
                },
            )

        if method == "tools/call":
            return _rpc_result(id_, handle_tools_call(conn, params))

        # Local HTTP aliases matching SEP-2663 method names (not SDK-native).
        if method == "tasks/get":
            task = get_task(conn, str(params.get("taskId") or ""))
            if not task:
                return _rpc_error(id_, -32001, "Unknown task")
            return _rpc_result(id_, to_task_response(task))

        if method == "tasks/update":
            task_id = str(params.get("taskId") or "")
            responses = params.get("inputResponses") or {}
            if not responses:
                return _rpc_error(id_, -32602, "inputResponses required")
            request_id, response = next(iter(responses.items()))
            decision = response.get("decision")
            if decision not in ("approve", "deny"):
                return _rpc_error(id_, -32602, "decision must be approve or deny")
            task = apply_approval(conn, task_id, request_id, decision)
            if not task:
                return _rpc_error(id_, -32001, "Unknown task")
            return _rpc_result(id_, to_task_response(task))

        if method == "tasks/cancel":
            task = request_cancel(conn, str(params.get("taskId") or ""))
            if not task:
                return _rpc_error(id_, -32001, "Unknown task")
            return _rpc_result(id_, {"resultType": "complete"})

        if method == "ping":
            return _rpc_result(id_, {})

        return _rpc_error(id_, -32601, f"Method not found: {method}")
    except KeyError as err:
        return _rpc_error(id_, -32001, str(err))
    except Exception as err:  # noqa: BLE001
        return _rpc_error(id_, -32000, str(err))
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            self._json(200, {"ok": True})
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/mcp", "/"):
            self.send_error(404)
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, _rpc_error(None, -32700, "Parse error"))
            return
        self._json(200, handle_rpc(body))

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start_server(host: str = HOST, port: int = PORT) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    log.info("server_listening", host=host, port=port, endpoint=f"http://{host}:{port}/mcp")
    return server


def main() -> None:
    server = start_server()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

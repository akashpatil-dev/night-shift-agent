from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .auth import (
    client_declares_tasks,
    is_approver,
    is_uuid,
    owner_from_headers,
    resolve_trace_id,
)
from .config import DEFAULT_TTL_MS, HOST, PORT, SYNC_MAX_TICKETS
from .db import connect
from .logging_util import log
from .metrics import inc, prometheus_text
from .store import (
    apply_approval,
    create_task,
    expire_approvals_and_ttl,
    get_task_for_owner,
    request_cancel,
)
from .task_protocol import create_task_result, to_task_response, update_ack
from .worker import worker_loop

"""
MCP Tasks note (Python): released `mcp` package still has no Tasks module
(verified: no mcp.server.tasks). This server uses tool shims; HTTP also
accepts tasks/* aliases for demo parity.
"""


def _rpc_result(id_: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _rpc_error(id_: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id_, "error": err}


def _parse_task_id(raw: Any) -> tuple[str | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, "taskId is required"
    if not is_uuid(raw):
        return None, "taskId must be a UUID"
    return raw, None


def handle_tools_call(
    conn,
    params: dict[str, Any],
    headers: dict[str, str],
    tasks_capable: bool,
) -> Any:
    name = str(params.get("name") or "")
    args = params.get("arguments") or {}
    owner = owner_from_headers(headers)
    trace_id = resolve_trace_id(headers, params.get("_meta") or {})

    if name == "triage_tickets":
        count = int(args["count"])
        if not tasks_capable:
            if count > SYNC_MAX_TICKETS:
                raise PermissionError(
                    "Client did not declare io.modelcontextprotocol/tasks; "
                    "enable Tasks or reduce count for sync mode"
                )
            task = create_task(
                conn,
                total_tickets=count,
                approval_threshold=args.get("approvalThreshold"),
                idempotency_key=args.get("idempotencyKey"),
                ttl_ms=int(args.get("ttlMs") or DEFAULT_TTL_MS),
                owner=owner,
                trace_id=trace_id,
            )
            worker_loop(once=True, task_id=task.id, worker_id=f"sync-{os_getpid()}")
            done = get_task_for_owner(conn, task.id, owner)
            return {
                "resultType": "complete",
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(done.result if done else {"taskId": task.id}),
                    }
                ],
            }

        key = args.get("idempotencyKey")
        existed = None
        if key:
            existed = conn.execute(
                "SELECT id FROM tasks WHERE idempotency_key = %s", (key,)
            ).fetchone()
        task = create_task(
            conn,
            total_tickets=count,
            approval_threshold=args.get("approvalThreshold"),
            idempotency_key=key,
            ttl_ms=int(args.get("ttlMs") or DEFAULT_TTL_MS),
            owner=owner,
            trace_id=trace_id,
        )
        if not existed:
            inc("tasks_created")
        return create_task_result(task)

    if name == "get_task":
        tid, err = _parse_task_id(args.get("taskId"))
        if err:
            raise ValueError(err)
        task = get_task_for_owner(conn, tid, owner)  # type: ignore[arg-type]
        if not task:
            raise KeyError("Invalid params")
        return to_task_response(task)

    if name == "update_task":
        if not is_approver(owner):
            raise KeyError("Invalid params")
        tid, err = _parse_task_id(args.get("taskId"))
        if err:
            raise ValueError(err)
        decision = str(args.get("decision") or "")
        if decision not in ("approve", "deny"):
            raise ValueError("decision must be approve or deny")
        task = apply_approval(
            conn, tid, str(args.get("requestId") or ""), decision, owner  # type: ignore[arg-type]
        )
        if not task:
            raise KeyError("Invalid params")
        return update_ack(task)

    if name == "cancel_task":
        tid, err = _parse_task_id(args.get("taskId"))
        if err:
            raise ValueError(err)
        task = request_cancel(conn, tid, owner)  # type: ignore[arg-type]
        if not task:
            raise KeyError("Invalid params")
        return {"resultType": "complete", "acknowledged": True, "taskId": task.id}

    raise LookupError(f"Unknown tool: {name}")


def os_getpid() -> int:
    import os

    return os.getpid()


def handle_rpc(body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    method = body.get("method") or ""
    params = body.get("params") or {}
    id_ = body.get("id")
    owner = owner_from_headers(headers)
    tasks_capable = client_declares_tasks(params, headers)
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
                            "description": "Enqueue triage; returns task handle when Tasks declared.",
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
                            "description": "SEP-2663 tasks/get shim (official mcp SDK has no Tasks yet).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"taskId": {"type": "string"}},
                                "required": ["taskId"],
                            },
                        },
                        {
                            "name": "update_task",
                            "description": "SEP-2663 tasks/update shim.",
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
            try:
                return _rpc_result(
                    id_, handle_tools_call(conn, params, headers, tasks_capable)
                )
            except PermissionError as err:
                return _rpc_error(
                    id_,
                    -32021,
                    str(err),
                    {
                        "requiredCapabilities": {
                            "extensions": {"io.modelcontextprotocol/tasks": {}}
                        }
                    },
                )

        if method == "tasks/get":
            tid, err = _parse_task_id(params.get("taskId"))
            if err:
                return _rpc_error(id_, -32602, err)
            task = get_task_for_owner(conn, tid, owner)  # type: ignore[arg-type]
            if not task:
                return _rpc_error(id_, -32602, "Invalid params")
            return _rpc_result(id_, to_task_response(task))

        if method == "tasks/update":
            if not is_approver(owner):
                return _rpc_error(id_, -32602, "Invalid params")
            tid, err = _parse_task_id(params.get("taskId"))
            if err:
                return _rpc_error(id_, -32602, err)
            responses = params.get("inputResponses") or {}
            if not responses:
                return _rpc_error(id_, -32602, "inputResponses required")
            request_id, response = next(iter(responses.items()))
            decision = response.get("decision")
            if decision not in ("approve", "deny"):
                return _rpc_error(id_, -32602, "decision must be approve or deny")
            task = apply_approval(conn, tid, request_id, decision, owner)  # type: ignore[arg-type]
            if not task:
                return _rpc_error(id_, -32602, "Invalid params")
            return _rpc_result(id_, update_ack(task))

        if method == "tasks/cancel":
            tid, err = _parse_task_id(params.get("taskId"))
            if err:
                return _rpc_error(id_, -32602, err)
            task = request_cancel(conn, tid, owner)  # type: ignore[arg-type]
            if not task:
                return _rpc_error(id_, -32602, "Invalid params")
            return _rpc_result(id_, {"resultType": "complete"})

        if method == "ping":
            return _rpc_result(id_, {})

        return _rpc_error(id_, -32601, f"Method not found: {method}")
    except KeyError:
        return _rpc_error(id_, -32602, "Invalid params")
    except ValueError as err:
        return _rpc_error(id_, -32602, str(err))
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        if "22P02" in msg or "invalid input syntax" in msg.lower():
            return _rpc_error(id_, -32602, "Invalid params")
        return _rpc_error(id_, -32000, msg)
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True})
            return
        if path == "/metrics":
            data = prometheus_text().encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "text/plain; version=0.0.4")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
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
        headers = {k: v for k, v in self.headers.items()}
        self._json(200, handle_rpc(body, headers))

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start_server(host: str = HOST, port: int = PORT) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    log.info(
        "server_listening",
        host=host,
        port=port,
        endpoint=f"http://{host}:{port}/mcp",
    )
    return server


def main() -> None:
    server = start_server()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

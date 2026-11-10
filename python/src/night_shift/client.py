from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from .config import DEFAULT_OWNER, HOST, PORT


class McpHttpClient:
    def __init__(
        self,
        base_url: str | None = None,
        owner: str = DEFAULT_OWNER,
        tasks_capable: bool = True,
    ) -> None:
        self.base_url = base_url or f"http://{HOST}:{PORT}/mcp"
        self.owner = owner
        self.tasks_capable = tasks_capable

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        params = dict(params or {})
        if method == "tools/call" and self.tasks_capable:
            params["_meta"] = {
                "io.modelcontextprotocol/clientCapabilities": {
                    "extensions": {"io.modelcontextprotocol/tasks": {}}
                }
            }
        payload = {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000),
            "method": method,
            "params": params,
        }
        req = urllib.request.Request(
            self.base_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "x-owner-id": self.owner,
                "x-mcp-tasks": "1" if self.tasks_capable else "0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if body.get("error"):
            err = body["error"]
            raise RuntimeError(f"{err.get('code')}: {err.get('message')}")
        return body.get("result")

    def triage_tickets(self, **args: Any) -> dict[str, Any]:
        return self.call("tools/call", {"name": "triage_tickets", "arguments": args})

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self.call(
            "tools/call", {"name": "get_task", "arguments": {"taskId": task_id}}
        )

    def update_task(self, task_id: str, request_id: str, decision: str) -> dict[str, Any]:
        return self.call(
            "tools/call",
            {
                "name": "update_task",
                "arguments": {
                    "taskId": task_id,
                    "requestId": request_id,
                    "decision": decision,
                },
            },
        )

    def cancel_task(self, task_id: str) -> Any:
        return self.call(
            "tools/call", {"name": "cancel_task", "arguments": {"taskId": task_id}}
        )

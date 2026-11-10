from __future__ import annotations

import re
import secrets
from typing import Any

from .config import APPROVER_IDS, DEFAULT_OWNER

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def is_uuid(value: str) -> bool:
    return bool(UUID_RE.match(value))


def owner_from_headers(headers: dict[str, str]) -> str:
    lower = {k.lower(): v for k, v in headers.items()}
    raw = (
        lower.get("x-owner-id")
        or lower.get("x-user-id")
        or _bearer(lower.get("authorization"))
        or DEFAULT_OWNER
    )
    return (raw or DEFAULT_OWNER).strip() or DEFAULT_OWNER


def is_approver(owner_id: str) -> bool:
    return owner_id in APPROVER_IDS


def _bearer(auth: str | None) -> str | None:
    if not auth:
        return None
    m = re.match(r"^Bearer\s+(.+)$", auth, re.I)
    return m.group(1) if m else None


def resolve_trace_id(headers: dict[str, str], body_meta: dict[str, Any] | None = None) -> str:
    lower = {k.lower(): v for k, v in headers.items()}
    tp = lower.get("traceparent")
    if tp:
        parts = tp.split("-")
        if len(parts) >= 2 and parts[1]:
            return parts[1]
    meta = body_meta or {}
    for key in ("traceId", "trace_id"):
        if isinstance(meta.get(key), str) and meta[key]:
            return str(meta[key])
    return secrets.token_hex(16)


def client_declares_tasks(params: dict[str, Any], headers: dict[str, str]) -> bool:
    lower = {k.lower(): v for k, v in headers.items()}
    if lower.get("x-mcp-tasks") == "1":
        return True
    meta = params.get("_meta") or {}
    caps = (
        meta.get("io.modelcontextprotocol/clientCapabilities")
        or meta.get("clientCapabilities")
        or {}
    )
    extensions = caps.get("extensions") or {}
    return "io.modelcontextprotocol/tasks" in extensions

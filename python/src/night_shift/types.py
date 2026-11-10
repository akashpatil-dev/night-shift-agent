from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

StoreStatus = Literal[
    "queued",
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
]

WireStatus = Literal[
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
]


@dataclass
class Checkpoint:
    processed: int
    next_ticket: int

    @classmethod
    def from_obj(cls, obj: Any) -> "Checkpoint":
        if isinstance(obj, str):
            import json

            obj = json.loads(obj)
        return cls(
            processed=int(obj.get("processed", 0)),
            next_ticket=int(obj.get("next_ticket", 0)),
        )

    def to_dict(self) -> dict[str, int]:
        return {"processed": self.processed, "next_ticket": self.next_ticket}


@dataclass
class ApprovalState:
    requestId: str
    message: str
    ticketId: int
    expiresAt: str
    decision: str | None = None
    decidedAt: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "requestId": self.requestId,
            "message": self.message,
            "ticketId": self.ticketId,
            "expiresAt": self.expiresAt,
        }
        if self.decision:
            d["decision"] = self.decision
        if self.decidedAt:
            d["decidedAt"] = self.decidedAt
        return d

    @classmethod
    def from_obj(cls, obj: Any) -> "ApprovalState | None":
        if not obj:
            return None
        if isinstance(obj, str):
            import json

            obj = json.loads(obj)
        return cls(
            requestId=str(obj["requestId"]),
            message=str(obj["message"]),
            ticketId=int(obj["ticketId"]),
            expiresAt=str(obj["expiresAt"]),
            decision=obj.get("decision"),
            decidedAt=obj.get("decidedAt"),
        )


@dataclass
class TaskRow:
    id: str
    status: StoreStatus
    checkpoint: Checkpoint
    attempts: int
    attempt_count: int
    next_run_at: datetime | None
    last_error: str | None
    idempotency_key: str | None
    owner: str
    trace_id: str | None
    created_at: datetime
    updated_at: datetime
    ttl_ms: int | None
    expires_at: datetime | None
    total_tickets: int
    approval_threshold: int | None
    cancel_requested: bool
    approval: ApprovalState | None
    result: Any
    error: Any
    poll_interval_ms: int
    locked_by: str | None
    locked_until: datetime | None
    status_message: str | None

from __future__ import annotations

from typing import Any


def make_ticket(ticket_id: int) -> dict[str, Any]:
    severity = 90 if ticket_id % 17 == 0 else 60 if ticket_id % 5 == 0 else 20
    return {
        "id": ticket_id,
        "subject": f"Fake ticket #{ticket_id}",
        "severity": severity,
        "customer": f"customer-{ticket_id % 100}",
    }


def needs_approval(ticket_severity: int, threshold: int | None) -> bool:
    if threshold is None:
        return False
    return ticket_severity >= threshold

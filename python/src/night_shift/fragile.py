from __future__ import annotations

from .config import FRAGILE_FAIL_AT
from .triage import make_ticket


def fragile_triage_tickets(count: int) -> dict[str, int]:
    processed = 0
    for i in range(count):
        make_ticket(i)
        processed += 1
        if processed == FRAGILE_FAIL_AT:
            raise RuntimeError(
                f"Fragile worker crashed at ticket {FRAGILE_FAIL_AT} with no checkpoint"
            )
    return {"triaged": processed}

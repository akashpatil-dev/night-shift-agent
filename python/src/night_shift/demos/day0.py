from __future__ import annotations

from night_shift.client import McpHttpClient
from night_shift.config import FRAGILE_FAIL_AT
from night_shift.fragile import fragile_triage_tickets


def main() -> None:
    print("=== Day 0: fragile vs queued ===\n")
    print(f"Fragile path (fails at ticket {FRAGILE_FAIL_AT})...")
    try:
        fragile_triage_tickets(2000)
    except Exception as err:  # noqa: BLE001
        print(f"  FAILED as expected: {err}")

    print("\nQueued path (returns handle immediately)...")
    client = McpHttpClient()
    created = client.triage_tickets(count=200)
    print(f"  taskId={created['taskId']} status={created['status']}")
    print("  (worker will finish in the background - no client timeout)")


if __name__ == "__main__":
    main()

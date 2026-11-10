import os

CHECKPOINT_EVERY = int(os.environ.get("CHECKPOINT_EVERY", "50"))
FRAGILE_FAIL_AT = int(os.environ.get("FRAGILE_FAIL_AT", "1400"))
LEASE_SECONDS = int(os.environ.get("LEASE_SECONDS", "30"))
DEFAULT_TTL_MS = int(os.environ.get("DEFAULT_TTL_MS", str(60 * 60 * 1000)))
APPROVAL_TTL_MS = int(os.environ.get("APPROVAL_TTL_MS", "60000"))
TICKET_DELAY_MS = int(os.environ.get("TICKET_DELAY_MS", "5"))
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://nightshift:nightshift@127.0.0.1:5432/nightshift",
)
PORT = int(os.environ.get("PORT", "3200"))
HOST = os.environ.get("HOST", "127.0.0.1")

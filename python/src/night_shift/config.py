import os

CHECKPOINT_EVERY = int(os.environ.get("CHECKPOINT_EVERY", "50"))
FRAGILE_FAIL_AT = int(os.environ.get("FRAGILE_FAIL_AT", "1400"))
LEASE_SECONDS = int(os.environ.get("LEASE_SECONDS", "30"))
LEASE_HEARTBEAT_MS = int(os.environ.get("LEASE_HEARTBEAT_MS", "10000"))
DEFAULT_TTL_MS = int(os.environ.get("DEFAULT_TTL_MS", str(60 * 60 * 1000)))
if os.environ.get("APPROVAL_TTL_SECONDS"):
    APPROVAL_TTL_SECONDS = int(os.environ["APPROVAL_TTL_SECONDS"])
elif os.environ.get("APPROVAL_TTL_MS"):
    APPROVAL_TTL_SECONDS = int(os.environ["APPROVAL_TTL_MS"]) // 1000
else:
    APPROVAL_TTL_SECONDS = 6 * 60 * 60
APPROVAL_TTL_MS = APPROVAL_TTL_SECONDS * 1000
TICKET_DELAY_MS = int(os.environ.get("TICKET_DELAY_MS", "5"))
RETRY_BASE_MS = int(os.environ.get("RETRY_BASE_MS", "2000"))
RETRY_MAX_ATTEMPTS = int(os.environ.get("RETRY_MAX_ATTEMPTS", "5"))
TTL_RETENTION_MS = int(os.environ.get("TTL_RETENTION_MS", str(24 * 60 * 60 * 1000)))
SYNC_MAX_TICKETS = int(os.environ.get("SYNC_MAX_TICKETS", "20"))
DEFAULT_OWNER = os.environ.get("DEFAULT_OWNER", "demo-user")
APPROVER_IDS = [
    s.strip()
    for s in os.environ.get("APPROVER_IDS", "demo-user,demo-approver").split(",")
    if s.strip()
]
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://nightshift:nightshift@127.0.0.1:5432/nightshift",
)
PORT = int(os.environ.get("PORT", "3200"))
HOST = os.environ.get("HOST", "127.0.0.1")

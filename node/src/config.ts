export const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY ?? 50);
export const FRAGILE_FAIL_AT = Number(process.env.FRAGILE_FAIL_AT ?? 1400);
export const LEASE_SECONDS = Number(process.env.LEASE_SECONDS ?? 30);
export const LEASE_HEARTBEAT_MS = Number(process.env.LEASE_HEARTBEAT_MS ?? 10_000);
export const DEFAULT_TTL_MS = Number(process.env.DEFAULT_TTL_MS ?? 60 * 60 * 1000);
/** Approval window; default 6 hours. Demos may set APPROVAL_TTL_SECONDS=60. */
export const APPROVAL_TTL_SECONDS = Number(
  process.env.APPROVAL_TTL_SECONDS ??
    (process.env.APPROVAL_TTL_MS
      ? String(Number(process.env.APPROVAL_TTL_MS) / 1000)
      : String(6 * 60 * 60)),
);
export const APPROVAL_TTL_MS = APPROVAL_TTL_SECONDS * 1000;
export const TICKET_DELAY_MS = Number(process.env.TICKET_DELAY_MS ?? 5);
export const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 2000);
export const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 5);
export const TTL_RETENTION_MS = Number(
  process.env.TTL_RETENTION_MS ?? 24 * 60 * 60 * 1000,
);
export const SYNC_MAX_TICKETS = Number(process.env.SYNC_MAX_TICKETS ?? 20);
export const DEFAULT_OWNER = process.env.DEFAULT_OWNER ?? "demo-user";
/** Comma-separated identities allowed to approve/deny. */
export const APPROVER_IDS = (process.env.APPROVER_IDS ?? "demo-user,demo-approver")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://nightshift:nightshift@127.0.0.1:5432/nightshift";
export const PORT = Number(process.env.PORT ?? 3100);
export const HOST = process.env.HOST ?? "127.0.0.1";

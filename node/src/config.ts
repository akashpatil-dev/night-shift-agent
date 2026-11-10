export const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY ?? 50);
export const FRAGILE_FAIL_AT = Number(process.env.FRAGILE_FAIL_AT ?? 1400);
export const LEASE_SECONDS = Number(process.env.LEASE_SECONDS ?? 30);
export const DEFAULT_TTL_MS = Number(process.env.DEFAULT_TTL_MS ?? 60 * 60 * 1000);
export const APPROVAL_TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 60_000);
export const TICKET_DELAY_MS = Number(process.env.TICKET_DELAY_MS ?? 5);
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://nightshift:nightshift@127.0.0.1:5432/nightshift";
export const PORT = Number(process.env.PORT ?? 3100);
export const HOST = process.env.HOST ?? "127.0.0.1";

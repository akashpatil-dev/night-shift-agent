import { randomBytes } from "node:crypto";
import { APPROVER_IDS, DEFAULT_OWNER } from "./config.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function ownerFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw =
    header(headers, "x-owner-id") ||
    header(headers, "x-user-id") ||
    bearer(headers) ||
    DEFAULT_OWNER;
  return raw.trim() || DEFAULT_OWNER;
}

export function isApprover(ownerId: string): boolean {
  return APPROVER_IDS.includes(ownerId);
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function bearer(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const auth = header(headers, "authorization");
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m?.[1];
}

/** Extract W3C traceparent or generate a simple trace id. */
export function resolveTraceId(
  headers: Record<string, string | string[] | undefined>,
  bodyMeta?: Record<string, unknown>,
): string {
  const tp = header(headers, "traceparent");
  if (tp) {
    const parts = tp.split("-");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  const metaTrace = bodyMeta?.traceId ?? bodyMeta?.trace_id;
  if (typeof metaTrace === "string" && metaTrace.length > 0) return metaTrace;
  return randomBytes(16).toString("hex");
}

export function clientDeclaresTasks(
  params: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (header(headers, "x-mcp-tasks") === "1") return true;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const caps =
    (meta["io.modelcontextprotocol/clientCapabilities"] as Record<string, unknown>) ??
    (meta.clientCapabilities as Record<string, unknown>) ??
    {};
  const extensions = (caps.extensions as Record<string, unknown>) ?? {};
  return Object.prototype.hasOwnProperty.call(
    extensions,
    "io.modelcontextprotocol/tasks",
  );
}

export type StoreStatus =
  | "queued"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export type WireStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface Checkpoint {
  processed: number;
  next_ticket: number;
}

export interface ApprovalState {
  requestId: string;
  message: string;
  ticketId: number;
  expiresAt: string;
  decision?: "approve" | "deny";
  decidedAt?: string;
}

export interface TaskRow {
  id: string;
  status: StoreStatus;
  checkpoint: Checkpoint;
  attempts: number;
  attempt_count: number;
  next_run_at: Date | null;
  last_error: string | null;
  idempotency_key: string | null;
  owner: string;
  trace_id: string | null;
  created_at: Date;
  updated_at: Date;
  ttl_ms: string | number | null;
  expires_at: Date | null;
  total_tickets: number;
  approval_threshold: number | null;
  cancel_requested: boolean;
  approval: ApprovalState | null;
  result: unknown;
  error: unknown;
  poll_interval_ms: number;
  locked_by: string | null;
  locked_until: Date | null;
  status_message: string | null;
}

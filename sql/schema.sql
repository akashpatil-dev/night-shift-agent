-- Night-Shift Agent shared schema (Postgres)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM (
    'queued',
    'working',
    'input_required',
    'completed',
    'failed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status             task_status NOT NULL DEFAULT 'queued',
  checkpoint         JSONB NOT NULL DEFAULT '{"processed":0,"next_ticket":0}'::jsonb,
  attempts           INTEGER NOT NULL DEFAULT 0,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_run_at        TIMESTAMPTZ,
  last_error         TEXT,
  idempotency_key    TEXT UNIQUE,
  owner              TEXT NOT NULL DEFAULT 'demo-user',
  trace_id           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_ms             BIGINT,
  expires_at         TIMESTAMPTZ,
  total_tickets      INTEGER NOT NULL DEFAULT 0,
  approval_threshold INTEGER,
  cancel_requested   BOOLEAN NOT NULL DEFAULT FALSE,
  approval           JSONB,
  result             JSONB,
  error              JSONB,
  poll_interval_ms   INTEGER NOT NULL DEFAULT 500,
  locked_by          TEXT,
  locked_until       TIMESTAMPTZ,
  status_message     TEXT
);

-- Additive migrations for existing volumes
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'demo-user';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_status_queued
  ON tasks (status, created_at)
  WHERE status IN ('queued', 'working');

CREATE INDEX IF NOT EXISTS idx_tasks_next_run
  ON tasks (next_run_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_tasks_expires_at
  ON tasks (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_writes (
  idempotency_key TEXT PRIMARY KEY,
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_writes_task
  ON audit_writes (task_id);

CREATE TABLE IF NOT EXISTS dead_letter (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL,
  owner         TEXT,
  payload       JSONB NOT NULL,
  last_error    TEXT,
  attempt_count INTEGER NOT NULL,
  trace_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_task ON dead_letter (task_id);

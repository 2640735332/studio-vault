-- ingest_jobs state machine + audit_events (before/after audit trail, partitioned by created_at).
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  kind text NOT NULL,
  source_path text NOT NULL,
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  report_id uuid,
  bytes_total bigint NOT NULL DEFAULT 0,
  files_total integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_jobs_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT ingest_jobs_idempotency_key UNIQUE (project_id, source_path, content_sha256, kind)
);

CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id uuid NOT NULL,
  project_id text,
  actor text NOT NULL,
  action text NOT NULL,
  entity text,
  entity_id text,
  outcome text NOT NULL DEFAULT 'ok',
  status_code integer,
  before jsonb,
  after jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  remote_addr text,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS audit_events_default PARTITION OF audit_events DEFAULT;

CREATE INDEX IF NOT EXISTS audit_events_project_created_idx ON audit_events (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor, created_at DESC);

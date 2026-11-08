-- reports (evidence artifacts) + sha256 blob registry + N:N report_links.
-- Blob bodies live in object storage (MinIO) keyed by sha256; the DB stores metadata/refcount only.
CREATE TABLE IF NOT EXISTS reports (
  id uuid NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL DEFAULT 'report',
  title text,
  storage_tier text NOT NULL DEFAULT 'hot',
  restore_status text NOT NULL DEFAULT 'none',
  author text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS reports_default PARTITION OF reports DEFAULT;

CREATE INDEX IF NOT EXISTS reports_project_created_idx ON reports (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 text PRIMARY KEY,
  size_bytes bigint NOT NULL DEFAULT 0,
  bucket text NOT NULL DEFAULT 'vault',
  object_key text NOT NULL,
  refcount integer NOT NULL DEFAULT 0,
  storage_tier text NOT NULL DEFAULT 'hot',
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_files (
  report_id uuid NOT NULL,
  path text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, path)
);

CREATE INDEX IF NOT EXISTS report_files_sha256_idx ON report_files (sha256);

CREATE TABLE IF NOT EXISTS report_links (
  report_id uuid NOT NULL,
  bug_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'evidence',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, bug_id, role)
);

CREATE INDEX IF NOT EXISTS report_links_bug_idx ON report_links (bug_id);

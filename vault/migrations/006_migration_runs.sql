-- Import/cutover bookkeeping: one row per import run, one row per imported package.
-- Enables断点续传 audit, rollback by run, and the legacy_id <-> internal UUID mapping export.
CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  kind text NOT NULL DEFAULT 'bug-package-import',
  source text NOT NULL,
  mode text NOT NULL DEFAULT 'execute',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS migration_runs_project_started_idx ON migration_runs (project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS migration_items (
  run_id uuid NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL,
  entity_id text NOT NULL,
  source_path text NOT NULL,
  content_sha256 text NOT NULL,
  legacy_id text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, kind, entity_id)
);

CREATE INDEX IF NOT EXISTS migration_items_source_idx ON migration_items (project_id, source_path);
CREATE INDEX IF NOT EXISTS migration_items_legacy_idx ON migration_items (project_id, legacy_id);

-- bugs: partitioned by created_at (month chunks); internal UUID identity + 8-digit legacy id index.
-- (project_id, legacy_id) composite uniqueness lives in bug_legacy_index (TECH §3.3 / AC-23/AC-24).
CREATE TABLE IF NOT EXISTS bugs (
  id uuid NOT NULL,
  project_id text NOT NULL,
  legacy_id text,
  title text,
  status text NOT NULL DEFAULT 'new',
  severity text NOT NULL DEFAULT 'medium',
  assignee text,
  fingerprint text,
  cluster_id text,
  resolution text,
  closed_at timestamptz,
  author text NOT NULL,
  updated_by text,
  repo text,
  branch text,
  worktree text,
  commit_sha text,
  source_track text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS bugs_default PARTITION OF bugs DEFAULT;

CREATE INDEX IF NOT EXISTS bugs_project_created_idx ON bugs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bugs_project_legacy_idx ON bugs (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bugs_project_status_idx ON bugs (project_id, status);

CREATE TABLE IF NOT EXISTS bug_legacy_index (
  project_id text NOT NULL,
  legacy_id text NOT NULL,
  bug_id uuid NOT NULL,
  bug_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, legacy_id)
);

CREATE INDEX IF NOT EXISTS bug_legacy_index_bug_idx ON bug_legacy_index (bug_id);

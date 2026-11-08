-- test-runs: two-layer model (run + steps), partitioned by started_at.
CREATE TABLE IF NOT EXISTS test_runs (
  id uuid NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL DEFAULT 'e2e',
  status text NOT NULL DEFAULT 'running',
  author text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE IF NOT EXISTS test_runs_default PARTITION OF test_runs DEFAULT;

CREATE INDEX IF NOT EXISTS test_runs_project_started_idx ON test_runs (project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS test_run_steps (
  run_id uuid NOT NULL,
  step_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id)
);

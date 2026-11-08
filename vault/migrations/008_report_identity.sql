-- Optional create-only report identity across time partitions. Existing reports stay readable.
CREATE TABLE IF NOT EXISTS report_identity_index (
  report_id uuid PRIMARY KEY,
  project_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

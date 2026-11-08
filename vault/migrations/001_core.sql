-- Vault core: migrations ledger, projects registry, token table with project scope.
-- Owner: specs/specViewer-001/track-017-studioVaultSplit (TASK-09/11) + BRIEF v3.35 §5.4.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  execution_ms integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- token scope: a token maps to one or more projects (BRIEF Q-21 / AC-12 / AC-29).
CREATE TABLE IF NOT EXISTS tokens (
  id text PRIMARY KEY,
  label text NOT NULL,
  token_hash text NOT NULL,
  projects jsonb NOT NULL DEFAULT '[]'::jsonb,
  role text NOT NULL DEFAULT 'writer',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tokens_role_check CHECK (role IN ('admin', 'writer', 'reader'))
);

CREATE INDEX IF NOT EXISTS tokens_token_hash_idx ON tokens (token_hash);

-- Projects are NOT seeded by migrations: the registry is populated by the bootstrap path
-- (VAULT_DEV_SEED=1 for development, 'vault-token.mjs create --ensure-project' for a real
-- deployment). Keeping migrations pure schema makes logical snapshots restorable into a
-- freshly migrated database without conflicting bootstrap rows (restore drill, AC-13).

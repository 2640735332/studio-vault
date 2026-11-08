-- 007: triage priority on bugs (task-42 direct-report). Additive, nullable; old rows keep NULL.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS priority text;
ALTER TABLE bugs DROP CONSTRAINT IF EXISTS bugs_priority_check;
ALTER TABLE bugs ADD CONSTRAINT bugs_priority_check CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3'));

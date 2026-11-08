# Import and cutover runbook

This runbook describes how to move an existing archive of report packages
(bug folders with screenshots, logs and metadata) into Vault with verifiable
gates, a grey rollout and a tested rollback path.

It applies to any archive that is laid out as package directories per bug
report. The import tooling is idempotent and resumable, and every run gets a
run id so that it can be rolled back precisely.

## 0. Roles, window and prerequisites

| Item | Value |
|---|---|
| Freeze window | Stop all writers to the source archive 30 minutes before the migration starts. |
| Roles | One migration operator; one reviewer responsible for the gates; the rollback decision is made by the reviewer. |
| Read-only fallback | Keep the old read-only source available for at least one release cycle after cutover. |
| Point of no return | The start of the freeze window. Decide before it that the import will run. |
| Prerequisites | `VAULT_DB=pg` reachable; object storage writable; `node scripts/vault-migrate.mjs --status` shows `pending=0`; a Vault writer/admin token is available in the environment. |
| Evidence | Write every command output to an evidence directory outside the repository (`<evidence-dir>`). |

## 1. Freeze the source

1. Tell all writers to stop writing to the source archive. Record the freeze
   start time.
2. Take a snapshot reading of the source (packages / files / bytes / unique
   legacy ids):

   ```bash
   node scripts/vault-import.mjs --dry-run --report <evidence-dir>/cutover-dry-run.json
   ```

3. Record the source commit (if the archive is versioned) and the snapshot
   commit of any shared metadata.
4. **Fail closed:** if the dry run reports unscanned directories
   (`skippedSources`) or the source changed between two dry runs, stop,
   resume writes and schedule a new window.

## 2. Import

```bash
node scripts/vault-import.mjs \
  --report <evidence-dir>/vault-import.json \
  --mapping <evidence-dir>/vault-id-map.json
echo "exit=$?"
```

- The idempotency key is `(project, source_path, content_sha256, kind)`.
  **Resuming is simply re-running the command**: completed packages are skipped,
  failed or incomplete ones are retried.
- Each run inserts one `migration_runs` row (the run id) and one
  `migration_items` row per entity (legacy id <-> internal UUID mapping).
- Expected: `import.failed=0` and
  `import.imported + import.skipped = import.packages`.
- **Gate:** exit code 0 and an empty `failures` list. Otherwise stop, fix the
  data or the source and re-run. Never edit the database by hand.

## 3. Reconcile the counters

```bash
node scripts/vault-reconcile.mjs --report <evidence-dir>/vault-reconcile.json
echo "exit=$?"
```

The report compares:

- **C1 - packages:** source package count vs `reports(kind='bug-package')` vs
  `migration_items`;
- **C2 - files:** source file count vs `report_files` vs items;
- **C3 - bytes:** source bytes vs `sum(report_files.size_bytes)` vs items;
- **C4 - legacy ids:** distinct legacy ids in the source vs distinct ids in
  `migration_items`.

**Gate:** all four deltas are `0` (exit code 0). Otherwise stop and locate the
delta (the usual causes are an incomplete freeze or a source that changed while
being scanned).

## 4. Sample hashes and dual read

```bash
node scripts/vault-dual-read.mjs --sample 10 --report <evidence-dir>/vault-dual-read.json
echo "exit=$?"
```

For each sampled package, compare the local read-only file tree (paths, per-file
sha256, sizes, package-level content hash) with the authoritative Vault data
(`report_files` and `report_links` resolved through the bug legacy id).

**Gate:** `mismatches=0` and all sampled packages report
`contentSha256Match=true` (exit code 0).

During the grey period both read paths run: the local read-only copy and Vault.
On conflict the record with the newer `updated_at` wins, and the old local
channel stays available until cutover + 1 release cycle.

## 5. Grey rollout and observation

1. Switch report writers to Vault (online write). When Vault is unavailable,
   the client writes to its local pending queue and replays it later - do not
   double-write.
2. Re-run the reconcile and dual-read steps every day during the observation
   window with `--sample 10`. Any non-zero exit triggers rollback.
3. Record the window start/end and the daily readings in `<evidence-dir>`.

## 6. Rollback

Roll back per run, not per table. Stop writes first.

```bash
# 6.1 stop writes to Vault (read-only fallback stays available)
# 6.2 roll back this import run
node scripts/vault-import.mjs --rollback-run <runId> --purge-bugs \
  --report <evidence-dir>/vault-rollback.json
node scripts/vault-status.mjs --project <project> \
  --report <evidence-dir>/vault-status.after-rollback.json
# 6.3 re-run reconciliation (bug-package count for the rolled-back run must be 0)
node scripts/vault-reconcile.mjs --report <evidence-dir>/vault-reconcile.after-rollback.json
```

- `--purge-bugs` deletes only bugs created by this run that no other
  `report_links` reference. Blob reference counts are decremented per file;
  an object is removed only when its count reaches zero, so objects shared with
  other runs are preserved.
- For a whole-database rollback, restore the latest logical snapshot (and the
  file-level backup of the data directory) and then re-run steps 3 and 4.
- After a rollback, re-run the minimal pre-cutover checks and keep the evidence.
  A rollback is not a failure, but it must be documented.

## 7. Sign-off

| Item | Value |
|---|---|
| Source commit / archive id | `<...>` |
| Import run id | `<migration_runs.id>` |
| Counter readings | C1 = ... / 0, C2 = ... / 0, C3 = ... / 0, C4 = ... / 0 |
| Sampled hashes | 10 / 10 match |
| Grey window | `<start>` -> `<end>`; daily reconcile / dual-read readings |
| Rollback drill | isolated project 0 -> N -> 0 (evidence JSON) |
| Signed off by | operator / reviewer + timestamp |

Evidence files: `cutover-dry-run.json`, `vault-import.json`,
`vault-import.idempotent.json`, `vault-reconcile.json`,
`vault-dual-read.json`, `vault-id-map.json`,
`vault-rollback.json`.

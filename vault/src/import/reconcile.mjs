import { BUG_PACKAGE_KIND, sha256Hex } from "./scan.mjs";

/**
 * Three-counter reconciliation (package/file/byte deltas must be 0).
 *
 * Counter semantics (must stay explicit — the evidence file quotes them):
 *   C1 包数   = source bug package dirs  vs  Vault bug-package reports  vs  migration_items
 *   C2 文件数 = source regular files     vs  report_files rows          vs  migration_items.files
 *   C3 字节数 = source file bytes        vs  sum(report_files.size_bytes) vs migration_items.bytes
 * The bug ticket rows are deduplicated by legacy_id across worktrees, so the source unique
 * legacy-id count is reconciled against migration_items.legacy_id DISTINCT, not bugs rows.
 */
export async function reconcile({ store, projectId, scanResult }) {
  const source = scanResult.counters;
  const reports = await store.reportCounters(projectId, BUG_PACKAGE_KIND);
  const items = await store.migrationItemSummary(projectId);
  const bugs = await store.bugCounters(projectId);
  const blobs = await store.blobStats();
  const ingest = await store.ingestCounters(projectId);

  const counters = {
    packages: { source: source.packages, reports: reports.reports, migrationItems: items.items, deltaReports: source.packages - reports.reports, deltaItems: source.packages - items.items },
    files: { source: source.files, reportFiles: reports.files, migrationItems: items.files, deltaReportFiles: source.files - reports.files, deltaItems: source.files - items.files },
    bytes: { source: source.bytes, reportFiles: reports.bytes, migrationItems: items.bytes, deltaReportFiles: source.bytes - reports.bytes, deltaItems: source.bytes - items.bytes },
    legacyIds: { sourceUnique: source.uniqueLegacyIds, migrationItemsUnique: items.legacyIds, delta: source.uniqueLegacyIds - items.legacyIds },
  };
  const deltas = [
    counters.packages.deltaReports,
    counters.packages.deltaItems,
    counters.files.deltaReportFiles,
    counters.files.deltaItems,
    counters.bytes.deltaReportFiles,
    counters.bytes.deltaItems,
    counters.legacyIds.delta,
  ];
  return {
    projectId,
    ok: deltas.every((delta) => delta === 0),
    counters,
    vault: { reports: reports.reports, reportFiles: reports.files, reportFileBytes: reports.bytes, bugs: bugs.bugs, uniqueLegacyIds: bugs.uniqueLegacyIds, ingestRunning: ingest.running, ingestFailed: ingest.failed, blobs: blobs.blobs, blobBytes: blobs.bytes, blobRefs: blobs.refs },
    sourceStatusCounts: source.statusCounts,
    notes: [
      "bugs rows are deduplicated by legacy_id across worktrees; report rows keep one row per package",
      "blob bytes are deduplicated by sha256; logical file bytes are compared through report_files",
    ],
  };
}

/** Gray dual-read: compare the local (read-only) package tree against the Vault authoritative copy. */
export async function dualRead({ store, projectId, packages, sample = 10 }) {
  const selected = packages.slice(0, sample);
  const checks = [];
  let mismatches = 0;
  for (const pkg of selected) {
    const report = await store.findReportBySourcePath(projectId, pkg.sourcePath);
    const files = report ? await store.listReportFiles(report.id) : [];
    const vaultByPath = new Map(files.map((file) => [file.path, file]));
    const missing = [];
    const hashMismatch = [];
    const sizeMismatch = [];
    for (const file of pkg.files) {
      const vaultFile = vaultByPath.get(file.relPath);
      if (!vaultFile) {
        missing.push(file.relPath);
        continue;
      }
      const vaultSha = vaultFile.sha256 || vaultFile.sha256 === "" ? vaultFile.sha256 : vaultFile.sha256;
      if (vaultSha !== file.sha256) hashMismatch.push(file.relPath);
      const vaultSize = Number(vaultFile.sizeBytes ?? vaultFile.size_bytes ?? 0);
      if (vaultSize !== file.sizeBytes) sizeMismatch.push(file.relPath);
    }
    let bug = null;
    if (report) {
      const links = await store.listLinks(projectId, { reportId: report.id });
      const bugId = links.length > 0 ? links[0].bugId : null;
      if (bugId) bug = await store.getBug(projectId, bugId);
    }
    let vaultContentSha256 = null;
    let contentSha256Match = null;
    if (report && missing.length === 0 && hashMismatch.length === 0 && sizeMismatch.length === 0) {
      const manifest = pkg.files
        .map((file) => {
          const vaultFile = vaultByPath.get(file.relPath);
          return file.relPath + "\u0000" + String(vaultFile.sha256) + "\u0000" + String(Number(vaultFile.sizeBytes ?? vaultFile.size_bytes ?? 0));
        })
        .join("\n");
      vaultContentSha256 = sha256Hex(Buffer.from(pkg.name + "\n" + manifest, "utf8"));
      contentSha256Match = vaultContentSha256 === pkg.contentSha256;
    }
    const ok = Boolean(report) && missing.length === 0 && hashMismatch.length === 0 && sizeMismatch.length === 0 && contentSha256Match === true && (!pkg.legacyId || (bug && bug.legacyId === pkg.legacyId));
    if (!ok) mismatches += 1;
    checks.push({
      sourcePath: pkg.sourcePath,
      packageName: pkg.name,
      local: { files: pkg.filesTotal, bytes: pkg.bytesTotal, legacyId: pkg.legacyId },
      vault: {
        reportId: report ? report.id : null,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + Number(file.sizeBytes ?? file.size_bytes ?? 0), 0),
        legacyId: bug ? bug.legacyId : null,
        reportTitle: report ? report.title : null,
      },
      localContentSha256: pkg.contentSha256,
      vaultContentSha256,
      contentSha256Match,
      missingFiles: missing,
      hashMismatch,
      sizeMismatch,
      ok,
    });
  }
  return { projectId, sampled: checks.length, mismatches, ok: mismatches === 0, checks };
}

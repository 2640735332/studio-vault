import { BUG_PACKAGE_KIND } from "./scan.mjs";

const IMPORT_AUTHOR = "token:migration-import";

function computeImportDataGaps(pkg) {
  const gaps = [];
  if (!pkg.branch) gaps.push("branch");
  if (!pkg.commitSha) gaps.push("commitSha");
  if (!pkg.build) gaps.push("build");
  if (!(pkg.build && (pkg.build.os || pkg.build.hw))) gaps.push("env");
  if (!Array.isArray(pkg.steps) || pkg.steps.length === 0) gaps.push("steps");
  if (!pkg.worldState || Object.keys(pkg.worldState).length === 0) gaps.push("worldState");
  if (!pkg.reproRate) gaps.push("reproRate");
  if (!pkg.reporter) gaps.push("reporter");
  if (!pkg.caseContext || !(pkg.caseContext.case_id || (Array.isArray(pkg.caseContext.assertions) && pkg.caseContext.assertions.length))) gaps.push("caseContext");
  if (!pkg.sourceTrack) gaps.push("sourceTrack");
  if (!pkg.priority) gaps.push("priority");
  return gaps;
}

function objectKeyFor(objectStore, sha256) {
  return typeof objectStore.keyFor === "function" ? objectStore.keyFor(sha256) : sha256;
}

function bucketFor(objectStore) {
  return objectStore.driver === "fs" ? "vault-fs" : "vault";
}

/**
 * Import one package: object blobs -> bug (get-or-create by legacy_id) -> report + files ->
 * report_links -> ingest_job -> migration_item. Idempotent through the ingest_jobs idempotency
 * key (project, source_path, content_sha256, kind); a second run skips succeeded packages.
 */
async function importPackage({ store, objectStore, projectId, pkg, runId, logger }) {
  const job = await store.createIngestJob(projectId, {
    kind: BUG_PACKAGE_KIND,
    sourcePath: pkg.sourcePath,
    contentSha256: pkg.contentSha256,
    status: "running",
    bytesTotal: pkg.bytesTotal,
    filesTotal: pkg.filesTotal,
  });
  if (!job.created) {
    if (job.job.status === "succeeded") return { status: "skipped", job: job.job };
    await store.updateIngestJob(job.job.id, { status: "running", attempts: Number(job.job.attempts || 0) + 1 });
  }
  const jobId = job.job.id;

  const storedFiles = [];
  let newBlobs = 0;
  for (const file of pkg.files) {
    await objectStore.putFile(file.sha256, file.absPath);
    const blob = await store.upsertBlob({
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      bucket: bucketFor(objectStore),
      objectKey: objectKeyFor(objectStore, file.sha256),
      contentType: file.relPath.split(".").pop(),
    });
    if (blob.created) newBlobs += 1;
    storedFiles.push({ path: file.relPath, sha256: file.sha256, sizeBytes: file.sizeBytes, role: file.role });
  }

  let bug = null;
  let bugCreated = false;
  if (pkg.legacyId) {
    bug = await store.getBugByLegacyId(projectId, pkg.legacyId);
    if (!bug) {
      const created = await store.createBug(
        projectId,
        {
          legacyId: pkg.legacyId,
          title: pkg.title,
          status: pkg.status,
          severity: pkg.severity || "medium",
          priority: pkg.priority || null,
          worktree: pkg.worktreeName,
          repo: pkg.repo || null,
          branch: pkg.branch || null,
          commitSha: pkg.commitSha || null,
          sourceTrack: pkg.sourceTrack || null,
          payload: {
            description: pkg.description,
            reproducedAt: pkg.reproducedAt,
            rawStatus: pkg.rawStatus,
            sceneSnapshot: pkg.sceneSnapshot,
            history: pkg.history,
            firstSourcePath: pkg.sourcePath,
            readmeFields: pkg.readmeFields,
            build: pkg.build || null,
            env: pkg.env || null,
            steps: pkg.steps || null,
            worldState: pkg.worldState || null,
            reproRate: pkg.reproRate || null,
            reporter: pkg.reporter || null,
            caseContext: pkg.caseContext || (pkg.e2eReport ? { report_bundle: pkg.e2eReport } : null),
            worktreeGitAtImport: pkg.worktreeGitAtImport || null,
            dataGaps: computeImportDataGaps(pkg),
          },
        },
        IMPORT_AUTHOR,
      );
      bug = created.bug;
      bugCreated = true;
      try {
        await store.appendAudit({
          projectId,
          actor: IMPORT_AUTHOR,
          action: "bug.import",
          entity: "bug",
          entityId: bug.id,
          details: { legacyId: pkg.legacyId, sourcePath: pkg.sourcePath, dataGaps: computeImportDataGaps(pkg) },
        });
      } catch {
        // audit is best effort for imports
      }
    }
  }

  const report = await store.createReport(
    projectId,
    {
      kind: BUG_PACKAGE_KIND,
      title: pkg.title,
      storageTier: "hot",
      payload: {
        packageName: pkg.name,
        sourcePath: pkg.sourcePath,
        worktree: pkg.worktreeName,
        worktreePath: pkg.worktreePath,
        legacyId: pkg.legacyId,
        rawStatus: pkg.rawStatus,
        hasReadme: pkg.hasReadme,
        filesTotal: pkg.filesTotal,
        bytesTotal: pkg.bytesTotal,
        contentSha256: pkg.contentSha256,
        importRunId: runId,
      },
      files: storedFiles,
    },
    IMPORT_AUTHOR,
  );

  try {
    await store.appendAudit({
      projectId,
      actor: IMPORT_AUTHOR,
      action: "report.import",
      entity: "report",
      entityId: report.report.id,
      details: { legacyId: pkg.legacyId, sourcePath: pkg.sourcePath, filesTotal: pkg.filesTotal },
    });
  } catch {
    // audit is best effort for imports
  }

  let linked = false;
  if (bug) {
    const link = await store.createLink(projectId, { reportId: report.report.id, bugId: bug.id, role: "evidence" });
    linked = link.created || link.link !== undefined;
  }

  await store.updateIngestJob(jobId, {
    status: "succeeded",
    reportId: report.report.id,
    bytesTotal: pkg.bytesTotal,
    filesTotal: pkg.filesTotal,
  });
  await store.insertMigrationItem({
    runId,
    projectId,
    kind: "package",
    entityId: report.report.id,
    sourcePath: pkg.sourcePath,
    contentSha256: pkg.contentSha256,
    legacyId: pkg.legacyId,
    extra: {
      jobId,
      bugId: bug ? bug.id : null,
      bugCreated,
      filesTotal: pkg.filesTotal,
      bytesTotal: pkg.bytesTotal,
      worktree: pkg.worktreeName,
      packageName: pkg.name,
      linked,
    },
  });
  logger.info("imported package", { sourcePath: pkg.sourcePath, files: pkg.filesTotal, bytes: pkg.bytesTotal, newBlobs });
  return { status: "imported", jobId, reportId: report.report.id, bugId: bug ? bug.id : null, bugCreated, newBlobs };
}

export async function executeImport({ store, objectStore, projectId, scanResult, runId, logger, progressEvery = 50 }) {
  const counters = { packages: 0, imported: 0, skipped: 0, failed: 0, files: 0, bytes: 0, newBlobs: 0, bugsCreated: 0, withoutLegacyId: 0 };
  const failures = [];
  for (const pkg of scanResult.packages) {
    try {
      const result = await importPackage({ store, objectStore, projectId, pkg, runId, logger });
      counters.packages += 1;
      if (result.status === "skipped") counters.skipped += 1;
      else {
        counters.imported += 1;
        counters.files += pkg.filesTotal;
        counters.bytes += pkg.bytesTotal;
        counters.newBlobs += result.newBlobs || 0;
        if (result.bugCreated) counters.bugsCreated += 1;
      }
      if (!pkg.legacyId) counters.withoutLegacyId += 1;
    } catch (error) {
      counters.packages += 1;
      counters.failed += 1;
      failures.push({ sourcePath: pkg.sourcePath, error: String(error && error.message ? error.message : error) });
      logger.warn("import failed for package", { sourcePath: pkg.sourcePath, error: String(error && error.message) });
    }
    if (progressEvery > 0 && counters.packages % progressEvery === 0) {
      process.stderr.write("import progress: " + counters.packages + "/" + scanResult.packages.length + "\n");
    }
  }
  return { counters, failures };
}

export async function rollbackRun({ store, objectStore, projectId, runId, purgeBugs = false, logger }) {
  const items = await store.listMigrationItems(runId);
  const result = { runId, items: items.length, reportsDeleted: 0, filesDeleted: 0, linksDeleted: 0, jobsDeleted: 0, blobsRemoved: 0, bugsDeleted: 0, errors: [] };
  for (const item of items) {
    try {
      if (item.kind !== "package") continue;
      const reportId = item.entityId;
      const files = await store.listReportFiles(reportId);
      for (const file of files) {
        const decrement = await store.decrementBlobRef(file.sha256);
        if (decrement.removed) {
          await objectStore.delete(file.sha256);
          result.blobsRemoved += 1;
        }
        result.filesDeleted += 1;
      }
      const links = await store.listLinks(projectId, { reportId });
      for (const link of links) {
        if (await store.deleteLink({ reportId: link.reportId, bugId: link.bugId, role: link.role })) result.linksDeleted += 1;
      }
      if (await store.deleteReport(projectId, reportId)) result.reportsDeleted += 1;
      if (item.extra && item.extra.jobId) {
        if (await store.deleteIngestJob(item.extra.jobId)) result.jobsDeleted += 1;
      }
      if (purgeBugs && item.extra && item.extra.bugId) {
        const remaining = await store.countReportLinks(item.extra.bugId);
        if (remaining === 0 && (await store.deleteBug(projectId, item.extra.bugId))) result.bugsDeleted += 1;
      }
    } catch (error) {
      result.errors.push({ entityId: item.entityId, error: String(error && error.message ? error.message : error) });
    }
  }
  await store.deleteMigrationItems(runId);
  await store.finishMigrationRun(runId, { status: "rolled_back", counters: { rolledBack: items.length, ...result } });
  logger.info("rollback finished", result);
  return result;
}

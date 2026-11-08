import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BUG_PACKAGE_KIND = "bug-package";

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const STATUS_MAP = [
  { pattern: /未复现|cannot reproduce/i, status: "cannot_reproduce" },
  { pattern: /非缺陷|假红|false.?red/i, status: "false_red" },
  { pattern: /重复|duplicate/i, status: "duplicate" },
  { pattern: /不修|不会修|wontfix/i, status: "wontfix" },
  { pattern: /已修复|修复|fixed/i, status: "fixed" },
  { pattern: /进行中|处理中|investigating/i, status: "in_progress" },
  { pattern: /已定位|triaged/i, status: "triaged" },
  { pattern: /已关闭|关闭|closed/i, status: "closed" },
  { pattern: /新|待处理|待定|open/i, status: "new" },
];

export function mapBugStatus(raw) {
  const text = String(raw || "").trim();
  if (!text) return { status: "new", rawStatus: null };
  for (const entry of STATUS_MAP) {
    if (entry.pattern.test(text)) return { status: entry.status, rawStatus: text };
  }
  return { status: "new", rawStatus: text };
}

/**
 * Parse the bug package Readme.md written by the in-game F3 bug reporter.
 * Known fields: ID / 标题 / 描述 / 复现时间 / 日志 / 截图 / 现场快照 / 状态 / 历史变更.
 * Unknown fields are preserved in payload.readmeFields so nothing is silently dropped.
 */
const MAX_LABEL_LEN = 16;
const LABEL_RE = /^([^\s:：{}\[\]=]{1,16})[:：]\s*(.*)$/;
const SEVERITY_ZH = { "致命": "critical", "严重": "high", "一般": "medium", "轻微": "low" };

function parseJsonValue(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePriority(value) {
  const text = String(value || "").trim().toUpperCase();
  return ["P0", "P1", "P2", "P3"].includes(text) ? text : null;
}

function normalizeSeverity(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (["low", "medium", "high", "critical", "blocker"].includes(lower)) return lower;
  return SEVERITY_ZH[text] || null;
}

function firstString(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

/**
 * Parse a bug package Readme. Known labels become structured fields; lines that are not
 * labels are appended to the previous field (multi-line description/E2E context), so no
 * fake fields like "script={" are produced. Unknown safe labels are preserved in fields{}.
 */
export function parseBugReadme(text) {
  const result = {
    legacyId: null,
    title: null,
    description: null,
    reproducedAt: null,
    sceneSnapshot: null,
    logs: [],
    screenshots: [],
    history: [],
    fields: {},
    branch: null,
    commitSha: null,
    build: null,
    env: null,
    steps: null,
    worldState: null,
    reproRate: null,
    reporter: null,
    sourceTrack: null,
    severity: null,
    priority: null,
    e2eReport: null,
    caseContext: null,
    type: null,
    tags: [],
  };
  if (!text) return result;
  const lines = String(text).split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const match = LABEL_RE.exec(line);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      result.fields[key] = value;
      currentKey = key;
      continue;
    }
    if (!trimmed) {
      currentKey = null;
      continue;
    }
    if (/^[-*]\s*\[/.test(trimmed)) {
      result.history.push(trimmed);
      continue;
    }
    if (currentKey) {
      result.fields[currentKey] = (result.fields[currentKey] || "") + "\n" + trimmed;
    }
  }
  const f = result.fields;
  const idMatch = /(\d{8})/.exec(f["ID"] || "");
  result.legacyId = idMatch ? idMatch[1] : null;
  result.title = firstString(f["标题"]);
  result.description = firstString(f["描述"]);
  result.reproducedAt = firstString(f["复现时间"]);
  result.rawStatus = firstString(f["状态"]);
  result.e2eReport = firstString(f["E2E报告"]);
  result.type = firstString(f["类型"]);
  result.tags = String(f["Tags"] || "").split(/[,，\s]+/).filter(Boolean);
  for (const key of ["日志"]) if (f[key]) result.logs.push(...String(f[key]).split(/[,，\s]+/).filter(Boolean));
  for (const key of ["截图"]) if (f[key]) result.screenshots.push(...String(f[key]).split(/[,，\s]+/).filter(Boolean));
  if (f["现场快照"]) {
    const parsed = parseJsonValue(f["现场快照"]);
    result.sceneSnapshot = parsed === null ? f["现场快照"] : parsed;
  }
  result.branch = firstString(f["分支"] || f["代码分支"] || f["branch"] || f["Branch"]);
  result.commitSha = firstString(f["commit"] || f["提交"] || f["提交号"] || f["commitSha"] || f["Commit"]);
  result.build = parseJsonValue(f["构建"]);
  result.env = parseJsonValue(f["环境"]);
  result.worldState = parseJsonValue(f["世界状态"]);
  result.reproRate = parseJsonValue(f["复现"]);
  result.reporter = parseJsonValue(f["上报者"]);
  result.severity = normalizeSeverity(f["严重度"]);
  result.priority = normalizePriority(f["优先级"]);
  const stepsValue = f["复现步骤"] || f["操作步骤"];
  if (stepsValue) {
    const parsed = parseJsonValue(stepsValue);
    if (Array.isArray(parsed)) result.steps = parsed;
    else result.steps = String(stepsValue).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  const e2eLines = String(f["描述"] || "").split(/\r?\n/);
  const e2eContext = {};
  for (const line of e2eLines) {
    const m = /^(case|domain|covers|session_id|step|atom|reason)=(.+)$/.exec(line.trim());
    if (!m) continue;
    e2eContext[m[1] === "case" ? "case_id" : m[1]] = m[2].trim();
  }
  if (result.e2eReport) e2eContext.report_bundle = result.e2eReport;
  result.caseContext = Object.keys(e2eContext).length ? e2eContext : null;
  const trackValue = firstString(f["关联轨"] || f["track"] || f["sourceTrack"]);
  if (trackValue) {
    const trackMatch = /track-[A-Za-z0-9_-]+/.exec(trackValue);
    result.sourceTrack = trackMatch ? trackMatch[0] : trackValue;
  }
  return result;
}

function fileRole(relPath) {
  const lower = relPath.toLowerCase();
  if (lower.endsWith("readme.md")) return "readme";
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(lower)) return "screenshot";
  if (/\.(jsonl|log|txt)$/.test(lower)) return "log";
  if (lower.endsWith(".import")) return "attachment";
  return "attachment";
}

export async function scanPackage(packageDir, { worktreeName, worktreePath, sourceRootLabel, worktreeHead = null, worktreeBranch = null }) {
  const name = path.basename(packageDir);
  const files = [];
  async function walk(dir, prefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        const hash = crypto.createHash("sha256");
        await new Promise((resolve, reject) => {
          fs.createReadStream(full)
            .on("data", (chunk) => hash.update(chunk))
            .on("error", reject)
            .on("end", resolve);
        });
        files.push({
          relPath: rel,
          absPath: full,
          sizeBytes: stat.size,
          sha256: hash.digest("hex"),
          role: fileRole(rel),
        });
      }
    }
  }
  await walk(packageDir, "");
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const manifest = files.map((file) => file.relPath + "\u0000" + file.sha256 + "\u0000" + file.sizeBytes).join("\n");
  const contentSha256 = sha256Hex(Buffer.from(name + "\n" + manifest, "utf8"));

  let readme = null;
  const readmeFile = files.find((file) => file.relPath.toLowerCase() === "readme.md");
  if (readmeFile) readme = parseBugReadme(await fsp.readFile(readmeFile.absPath, "utf8"));

  const dirLegacy = /^\d{8}$/.test(name) ? name : null;
  const legacyId = (readme && readme.legacyId) || dirLegacy;
  const statusInfo = mapBugStatus(readme ? readme.rawStatus : null);
  const sourcePath = [sourceRootLabel, "game/reports/bugs", name].filter(Boolean).join("/");
  return {
    name,
    worktreeName,
    worktreePath,
    packageDir,
    sourcePath,
    files,
    filesTotal: files.length,
    bytesTotal: bytes,
    contentSha256,
    legacyId,
    title: (readme && readme.title) || name,
    description: readme ? readme.description : null,
    reproducedAt: readme ? readme.reproducedAt : null,
    sceneSnapshot: readme ? readme.sceneSnapshot : null,
    status: statusInfo.status,
    rawStatus: statusInfo.rawStatus,
    history: readme ? readme.history : [],
    readmeFields: readme ? readme.fields : {},
    branch: readme ? readme.branch : null,
    commitSha: readme ? readme.commitSha : null,
    build: readme ? readme.build : null,
    env: readme ? readme.env : null,
    steps: readme ? readme.steps : null,
    worldState: readme ? readme.worldState : null,
    reproRate: readme ? readme.reproRate : null,
    reporter: readme ? readme.reporter : null,
    sourceTrack: readme ? readme.sourceTrack : null,
    severity: readme ? readme.severity : null,
    priority: readme ? readme.priority : null,
    e2eReport: readme ? readme.e2eReport : null,
    caseContext: readme ? readme.caseContext : null,
    hasReadme: Boolean(readmeFile),
    worktreeGitAtImport: { head: worktreeHead, branch: worktreeBranch, capturedAt: new Date().toISOString() },
  };
}

async function listBugPackageDirs(bugsRoot) {
  const entries = await fsp.readdir(bugsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(bugsRoot, entry.name))
    .sort();
}

/** Discover report roots from explicit --source paths or from \`git worktree list\`. */
export async function discoverSources({ repoRoot, sources = [], includeExternalWorktrees = false, log = () => {} }) {
  const roots = [];
  const excludedWorktrees = [];
  const resolvedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
  const workspaceRoot = resolvedRepoRoot ? path.dirname(resolvedRepoRoot) : null;
  const inWorkspace = (candidate) => {
    if (!resolvedRepoRoot) return true;
    const resolved = path.resolve(candidate);
    return resolved === resolvedRepoRoot || path.dirname(resolved) === workspaceRoot;
  };
  if (sources.length > 0) {
    for (const source of sources) {
      const absolute = path.resolve(source);
      roots.push({ path: absolute, worktreeName: path.basename(absolute), worktreeHead: null, worktreeBranch: null });
    }
  } else {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
    let pendingHead = null;
    let pendingBranch = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("HEAD ")) { pendingHead = line.slice("HEAD ".length).trim(); continue; }
      if (line.startsWith("branch ")) { pendingBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""); continue; }
      if (!line.startsWith("worktree ")) continue;
      const worktreePath = line.slice("worktree ".length).trim();
      // Import scope: only worktrees inside the project workspace are in scope; checkouts
      // elsewhere on disk are excluded by default unless includeExternalWorktrees is set.
      if (!includeExternalWorktrees && !inWorkspace(worktreePath)) {
        excludedWorktrees.push({ path: worktreePath, reason: "outside workspace root" });
        continue;
      }
      roots.push({ path: worktreePath, worktreeName: path.basename(worktreePath), worktreeHead: pendingHead, worktreeBranch: pendingBranch });
      pendingHead = null;
      pendingBranch = null;
    }
  }
  const discovered = [];
  for (const root of roots) {
    const bugsRoot = path.join(root.path, "game", "reports", "bugs");
    if (!fs.existsSync(bugsRoot)) {
      log("skip source without bug packages: " + root.path);
      continue;
    }
    const dirs = await listBugPackageDirs(bugsRoot);
    discovered.push({ ...root, bugsRoot, packageDirs: dirs });
  }
  return Object.assign(discovered, { excludedWorktrees });
}

/** Scan every discovered source; returns packages plus source-side counters. */
export async function scanAll({ repoRoot, sources = [], limit = 0, includeExternalWorktrees = false, log = () => {} }) {
  const discovered = await discoverSources({ repoRoot, sources, includeExternalWorktrees, log });
  const packages = [];
  const skippedSources = [];
  for (const source of discovered) {
    let count = 0;
    for (const packageDir of source.packageDirs) {
      if (limit > 0 && packages.length >= limit) break;
      packages.push(
        await scanPackage(packageDir, {
          worktreeName: source.worktreeName,
          worktreePath: source.path,
          sourceRootLabel: source.worktreeName,
          worktreeHead: source.worktreeHead,
          worktreeBranch: source.worktreeBranch,
        }),
      );
      count += 1;
    }
    if (count < source.packageDirs.length) skippedSources.push({ source: source.worktreeName, total: source.packageDirs.length, scanned: count });
    log("scanned " + source.worktreeName + ": " + count + "/" + source.packageDirs.length + " packages");
  }
  const files = packages.reduce((sum, pkg) => sum + pkg.filesTotal, 0);
  const bytes = packages.reduce((sum, pkg) => sum + pkg.bytesTotal, 0);
  const legacyIds = new Set(packages.map((pkg) => pkg.legacyId).filter(Boolean));
  const withoutLegacy = packages.filter((pkg) => !pkg.legacyId).length;
  const fileHashes = new Set();
  for (const pkg of packages) for (const file of pkg.files) fileHashes.add(file.sha256);
  const duplicatePackages = new Set();
  const seenContent = new Map();
  for (const pkg of packages) {
    if (seenContent.has(pkg.contentSha256)) duplicatePackages.add(pkg.sourcePath);
    else seenContent.set(pkg.contentSha256, pkg.sourcePath);
  }
  const statusCounts = {};
  for (const pkg of packages) statusCounts[pkg.status] = (statusCounts[pkg.status] || 0) + 1;
  return {
    discovered: discovered.map((source) => ({ worktreeName: source.worktreeName, path: source.path, packages: source.packageDirs.length })),
    excludedWorktrees: discovered.excludedWorktrees || [],
    packages,
    counters: {
      packages: packages.length,
      files,
      bytes,
      uniqueLegacyIds: legacyIds.size,
      packagesWithoutLegacyId: withoutLegacy,
      uniqueFileHashes: fileHashes.size,
      duplicateContentPackages: duplicatePackages.size,
      statusCounts,
    },
    skippedSources,
  };
}

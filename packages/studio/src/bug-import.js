/**
 * 本地 F3 包 → Vault 补录 / 上报链路自检（CLI: studio bug import-local|check）
 * 只创建缺失 legacyId（不覆盖既有），幂等；dry-run 不写；token 只读本地文件（不入库/不打印）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_VAULT = process.env.VAULT_URL || 'http://127.0.0.1:3460';
const TOKEN_CANDIDATES = [
  process.env.STUDIO_VAULT_WRITER_TOKEN_FILE,
  process.env.VAULT_WRITER_TOKEN_FILE,
  path.join(os.homedir(), '.studio', 'secrets', 'vault-writer-token.txt'),
].filter(Boolean);

export function resolveToken() {
  for (const f of TOKEN_CANDIDATES) {
    try { if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return { ok: true, token: t, file: f }; } } catch { /* ignore */ }
  }
  return { ok: false, file: TOKEN_CANDIDATES[0] || '' };
}

export function resolveUserDir(explicit) {
  if (explicit) return explicit;
  if (process.env.STUDIO_GAME_USERDATA_DIR) return process.env.STUDIO_GAME_USERDATA_DIR;
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, 'Godot', 'app_userdata');
  return '';
}

export function pendingFiles(userDir) {
  const dir = path.join(userDir || '', 'reports', 'vault_pending');
  if (!userDir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const abs = path.join(dir, f);
    let j = null;
    try { j = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { /* ignore */ }
    return { file: f, path: abs, phase: j && j.phase, attempts: j && j.attempts, bugId: j && j.bug_id, legacyId: j && j.payload && j.payload.legacyId, createdAt: j && j.created_at };
  });
}

export function parseReadme(md) {
  // 字段值用 [ \t]*（不是 \s*）：旧 Readme 的「描述:」为空时，下一行不能被吞进 description。
  const get = (key) => { const m = md.match(new RegExp('^' + key + '[:：][ \\t]*(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const getJson = (key) => { const v = get(key); if (!v) return null; try { return JSON.parse(v); } catch { return null; } };
  const labels = ['ID','标题','类型','Tags','描述','复现时间','日志','截图','现场快照','分支','提交','commit','构建','环境','复现率','上报者','世界状态','复现步骤','E2E上下文','状态'];
  const fields = {};
  for (const k of labels) { const v = get(k); if (v !== '') fields[k] = v; }
  return {
    id: get('ID'), title: get('标题'), type: get('类型'), tags: get('Tags'),
    description: get('描述'), time: get('复现时间'), log: get('日志'), shotsRaw: get('截图'),
    branch: get('分支'), commit: get('提交') || get('commit'),
    build: getJson('构建'), env: getJson('环境'),
    worldState: getJson('世界状态'), sceneSnapshot: getJson('现场快照'),
    steps: getJson('复现步骤'), caseContext: getJson('E2E上下文'),
    reproRaw: get('复现率'), reporterRaw: get('上报者'), status: get('状态'), fields,
  };
}

function parseRepro(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const f = (s.match(/^(always|often|sometimes|rare|unknown)/i) || [])[1];
  const a = s.match(/尝试\s*(\d+)\s*次/);
  if (!f && !a) return null;
  return { frequency: f ? f.toLowerCase() : 'unknown', attempts: a ? Number(a[1]) : 1 };
}
function parseReporter(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try { const j = JSON.parse(s); if (j && typeof j === 'object') return j; } catch { /* plain name */ }
  return { name: s, source: 'f3' };
}

export function listPackages(sourceRoot) {
  const bugsDir = path.join(sourceRoot, 'game', 'reports', 'bugs');
  if (!fs.existsSync(bugsDir)) return [];
  return fs.readdirSync(bugsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const dir = path.join(bugsDir, e.name);
    const readme = ['Readme.md', 'README.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!readme) return null;
    const meta = parseReadme(fs.readFileSync(readme, 'utf8'));
    return { folder: e.name, dir, readme, legacyId: meta.id, ...meta };
  }).filter(Boolean).sort((a, b) => (b.folder > a.folder ? 1 : -1));
}

async function api(token, vault, pathname, opts = {}) {
  const res = await fetch(vault + pathname, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

function parseShots(raw) { return (!raw || raw === '无') ? [] : raw.split(/[,，]\s*/).filter(Boolean); }

export function buildBugBody(pkg) {
  const shots = parseShots(pkg.shotsRaw);
  const worldState = pkg.worldState || (pkg.sceneSnapshot ? {
    scene: pkg.sceneSnapshot.scene,
    chunk: { x: pkg.sceneSnapshot.player_chunk_x, y: pkg.sceneSnapshot.player_chunk_y },
    player: { x: pkg.sceneSnapshot.player_world_x, y: pkg.sceneSnapshot.player_world_y },
    camera: { x: pkg.sceneSnapshot.camera_world_x, y: pkg.sceneSnapshot.camera_world_y, zoom: pkg.sceneSnapshot.camera_zoom },
    time: { day: 1, hour: pkg.sceneSnapshot.time_hour, paused: !!pkg.sceneSnapshot.time_paused },
  } : null);
  return {
    legacyId: pkg.legacyId,
    title: pkg.title,
    status: 'new',
    severity: 'medium',
    repo: 'local-import',
    worktree: 'local-import',
    branch: pkg.branch || undefined,
    commitSha: pkg.commit || undefined,
    payload: {
      description: pkg.description || '',
      rawStatus: pkg.status || '新',
      reproducedAt: pkg.time,
      tags: pkg.tags ? String(pkg.tags).split(/[,，]\s*/).filter(Boolean) : undefined,
      build: pkg.build || undefined,
      env: pkg.env || undefined,
      worldState: worldState || undefined,
      sceneSnapshot: pkg.sceneSnapshot || undefined,
      steps: pkg.steps || undefined,
      reproRate: parseRepro(pkg.reproRaw) || undefined,
      reporter: parseReporter(pkg.reporterRaw) || undefined,
      caseContext: pkg.caseContext || undefined,
      readmeFields: pkg.fields || undefined,
      localReport: { id: pkg.legacyId, dir_path: 'game/reports/bugs/' + pkg.folder, log_file: pkg.log, screenshots: shots, report_type: pkg.type === 'bug转需求' ? 'requirement' : 'bug' },
      history: [],
    },
  };
}

export async function importLocal({ source, vault = DEFAULT_VAULT, dryRun = false, limit = 0 } = {}) {
  const tk = resolveToken();
  if (!tk.ok) return { ok: false, code: 'vault_token_missing', token_file: tk.file, hint: '设置 STUDIO_VAULT_WRITER_TOKEN_FILE 或放置本地 writer token' };
  const pkgs = listPackages(source).filter((p) => /^\d{8}$/.test(p.legacyId));
  const picked = limit > 0 ? pkgs.slice(0, limit) : pkgs;
  const existing = []; const missing = []; const invalid = [];
  for (const pkg of picked) {
    if (!/^\d{8}$/.test(pkg.legacyId)) { invalid.push({ folder: pkg.folder, id: pkg.legacyId }); continue; }
    const got = await api(tk.token, vault, '/api/v1/bugs/by-legacy/' + pkg.legacyId, { method: 'GET' });
    if (got.status === 200) existing.push({ folder: pkg.folder, legacyId: pkg.legacyId, bugId: got.json.bug.id, status: got.json.bug.status });
    else if (got.status === 404) missing.push(pkg);
    else return { ok: false, code: 'vault_lookup_failed', http: got.status, detail: got.json };
  }
  const report = { command: 'bug import-local', ok: true, dry_run: !!dryRun, source, vault, scanned: pkgs.length, checked: picked.length, existing: existing.length, missing: missing.length, imported: 0, failed: 0, existing_items: existing, missing_items: missing.map((p) => ({ folder: p.folder, legacyId: p.legacyId, title: p.title })), invalid, results: [] };
  if (dryRun) return { ok: true, report };
  for (const pkg of missing) {
    const body = buildBugBody(pkg);
    const created = await api(tk.token, vault, '/api/v1/bugs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (created.status !== 201 && created.status !== 200) { report.failed++; report.results.push({ folder: pkg.folder, legacyId: pkg.legacyId, error: 'create_failed', http: created.status, detail: created.json }); continue; }
    const bugId = created.json.bug.id;
    let reportId = null; const files = [];
    try {
      const rep = await api(tk.token, vault, '/api/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'bug-package', title: pkg.title, payload: { legacyId: pkg.legacyId, worktree: 'local-import', sourcePath: pkg.dir } }) });
      if (rep.status === 201 || rep.status === 200) {
        reportId = rep.json.report.id;
        const uploads = [['Readme.md', pkg.readme, 'readme']];
        if (pkg.log && fs.existsSync(path.join(pkg.dir, pkg.log))) uploads.push([pkg.log, path.join(pkg.dir, pkg.log), 'log']);
        for (const s of parseShots(pkg.shotsRaw)) if (fs.existsSync(path.join(pkg.dir, s))) uploads.push([s, path.join(pkg.dir, s), 'screenshot']);
        for (const [relFile, abs, role] of uploads) {
          const up = await api(tk.token, vault, '/api/v1/reports/' + reportId + '/files?path=' + encodeURIComponent(relFile) + '&role=' + role, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(abs) });
          files.push({ path: relFile, role, http: up.status });
        }
        await api(tk.token, vault, '/api/v1/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId, bugId, role: 'evidence' }) });
      }
    } catch (e) { files.push({ error: String((e && e.message) || e) }); }
    report.imported++;
    report.results.push({ folder: pkg.folder, legacyId: pkg.legacyId, bugId, created: created.status, reportId, files });
  }
  report.ok = report.failed === 0;
  return { ok: report.ok, report };
}

export async function checkChain({ source, userDir, vault = DEFAULT_VAULT } = {}) {
  const problems = []; const checks = {};
  const required = ['game/src/systems/vault_reporter.gd', 'game/src/systems/bug_report_service.gd', 'game/src/ui/bug_report_panel.gd'];
  for (const rel of required) {
    const abs = path.join(source, rel);
    const exists = fs.existsSync(abs);
    checks['code:' + rel.split('/').pop()] = exists;
    if (!exists) problems.push({ code: 'missing_code', file: rel, optional: true, hint: '游戏内 F3 直报为可选集成（上报包格式见 skills/studio-bug/SKILL.md）；全新工作区缺少该文件属正常' });
  }
  try {
    const svc = fs.readFileSync(path.join(source, 'game', 'src', 'systems', 'bug_report_service.gd'), 'utf8');
    checks.service_has_vault = svc.includes('VaultReporter');
    if (!checks.service_has_vault) problems.push({ code: 'service_without_vault', hint: 'bug_report_service.gd 未包含 Vault 直报扩展' });
  } catch { /* already missing */ }
  const tk = resolveToken();
  checks.token = !!tk.ok;
  if (!tk.ok) problems.push({ code: 'vault_token_missing', hint: '配置 STUDIO_VAULT_WRITER_TOKEN_FILE 或 ~/.studio/secrets/vault-writer-token.txt' });
  const pending = pendingFiles(userDir || resolveUserDir());
  checks.pending = pending.length;
  let vaultOk = false; let missingRecent = [];
  if (tk.ok) {
    // Vault 不可达不是异常：应降级成一个 problem，而不是让整条自检命令抛 fetch failed。
    try {
      const h = await api(tk.token, vault, '/api/v1/health', { method: 'GET' });
      vaultOk = h.status === 200;
      if (!vaultOk) problems.push({ code: 'vault_unreachable', http: h.status, hint: '检查 VAULT_URL / Vault 服务是否可达' });
    } catch (err) {
      problems.push({ code: 'vault_unreachable', error: String((err && err.message) || err), hint: '检查 VAULT_URL / Vault 服务是否可达（或先启动 Vault）' });
    }
    if (vaultOk) {
      const pkgs = listPackages(source).filter((p) => /^\d{8}$/.test(p.legacyId)).slice(0, 20);
      for (const pkg of pkgs) {
        try {
          const got = await api(tk.token, vault, '/api/v1/bugs/by-legacy/' + pkg.legacyId, { method: 'GET' });
          if (got.status !== 200) missingRecent.push({ legacyId: pkg.legacyId, folder: pkg.folder, http: got.status });
        } catch (err) {
          missingRecent.push({ legacyId: pkg.legacyId, folder: pkg.folder, error: String((err && err.message) || err) });
        }
      }
      checks.recent_local_packages = pkgs.length;
      checks.recent_missing = missingRecent.length;
      if (missingRecent.length) problems.push({ code: 'recent_packages_not_in_vault', missing: missingRecent.slice(0, 10), hint: '运行 studio bug import-local --source <source>' });
    }
  }
  const ok = problems.length === 0;
  return { ok, report: { command: 'bug check', ok, source, vault, checks, problems, pending, token_file: tk.ok ? path.basename(tk.file) : null, pending_items: pending.slice(0, 20) } };
}

export function triggerSync(userDir) {
  const candidates = [
    process.env.STUDIO_VAULT_SYNC,
    path.resolve(process.cwd(), 'scripts', 'ci', 'vault-sync.cjs'),
  ].filter(Boolean);
  for (const f of candidates) if (fs.existsSync(f)) {
    const r = spawnSync(process.execPath, [f], { cwd: process.cwd(), stdio: 'pipe', timeout: 120000 });
    return { ok: r.status === 0, exit: r.status, stdout: String(r.stdout || '').slice(-1000), stderr: String(r.stderr || '').slice(-1000) };
  }
  return { ok: false, skipped: true, hint: '未找到本地 sync 脚本；可调用 Studio POST /api/sync 或等待 StudioDataSync' };
}
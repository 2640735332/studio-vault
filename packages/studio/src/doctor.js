import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { loadShared } from './deps.js';
import { sharedRepoState, mirrorFiles, sharedTreeNames } from './mirror.js';
import { kbStatus } from './kb.js';

const S = await loadShared();

export const ASSET_MANIFEST = path.join('docs', 'evidence', 'rollout', '.asset-manifest.json');

/** 单机模式提示（report.hint 与 shared/mirror 的 detail.hint 复用）。 */
export const SINGLE_MACHINE_HINT = '单机模式（single-machine mode）：未配置 shared.remote 且本机没有共享仓，shared/mirror 为可选检查（degraded，不影响本地 Viewer/doctor）。要接入团队共享仓：在 studio.config.json 配置 shared.remote 后执行 studio bootstrap。';

/**
 * 单机模式判定：studio.config.json 未配置 shared.remote，且本机不存在共享仓。
 * 一旦配置了 remote（哪怕仓还没 clone）或本机已有共享仓，就回到原有可判 fail 的语义，不掩盖配置错误。
 */
export function isSingleMachineMode(config, state) {
  if (!state || state.exists) return false;
  const remote = config && config.shared && config.shared.remote;
  return !(remote && String(remote).trim());
}

export function gitLfsVersion(cwd) {
  const r = S.git(['lfs', 'version'], { cwd });
  if (r.code !== 0) return null;
  const m = /git-lfs\/(\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
  return m ? { version: m[0].replace('git-lfs/', ''), major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function packSizeBytes(paths) {
  const r = S.git(['count-objects', '-vH'], { cwd: paths.sharedRoot });
  if (r.code !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('size-pack:'));
  if (!line) return null;
  const m = /size-pack:\s*([\d.]+)\s*([KMG]iB)/.exec(line);
  if (!m) return null;
  const mult = { KiB: 1024, MiB: 1024 * 1024, GiB: 1024 * 1024 * 1024 }[m[2]] || 1;
  return { text: m[1] + ' ' + m[2], bytes: Math.round(Number(m[1]) * mult) };
}

export function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* non-json */ }
          done({ ok: res.statusCode === 200, status: res.statusCode, json, bytes: body.length });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (err) => done({ ok: false, error: String(err.message || err) }));
    } catch (err) {
      done({ ok: false, error: String(err.message || err) });
    }
  });
}

// 资产断链口径（相对引用快照 + src 统计）：
//   ① markdown/HTML 的 `](...)` 中**图片/快照类**引用 → md_link；
//   ② **HTML 文件内的 `src="..."`**（不含 href；不含 md 内嵌 HTML）→ src；
//   ③ 解析基准 = **消费者文件所在目录**（游戏仓侧真实目录）+ 共享仓对应文件目录（双根）；
//   ④ 外部（http:/mailto:/#/?/{...}）跳过。实测：md_link 30 + src 55 = 85 known_debt，new_broken=0。
const MD_LINK_RE = /\]\(([^)\s]+)\)/g;
const HTML_SRC_RE = /src=["']([^"']+)["']/g;
const SNAPSHOT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
function isExternalRef(ref) {
  return /^(?:[a-z]+:|\/\/|#|\?)/i.test(ref) || ref.startsWith('{');
}

/**
 * 资产可解析检查：md/html 内相对引用，消费者目录解析，双根（镜像 + 共享仓）。
 * 存量 known_debt 写入 .asset-manifest.json；判据 = 新增断链 0。
 */
export function scanAssetRefs(paths, { writeManifest = false } = {}) {
  const mirror = paths.mirrorRoot;
  const shared = path.join(paths.sharedRoot, paths.mirrorRel);
  const knownPath = path.join(paths.repoRoot, ASSET_MANIFEST);
  const known = new Set();
  const knownJson = S.readJson(knownPath, null);
  if (knownJson && Array.isArray(knownJson.known_debt)) for (const k of knownJson.known_debt) known.add(k.key);
  let files = 0;
  let refs = 0;
  const broken = [];
  const isHtml = (lower) => lower.endsWith('.html') || lower.endsWith('.htm');
  for (const rel of mirrorFiles(paths)) {
    const lower = rel.toLowerCase();
    if (!lower.endsWith('.md') && !isHtml(lower)) continue;
    const abs = path.join(mirror, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.length && text.startsWith('version https://git-lfs')) continue;
    files += 1;
    const relDir = path.dirname(rel);
    const consumerDir = path.join(mirror, relDir); // 游戏仓消费者目录（mirrorRoot/docs/briefs 下）
    const sharedConsumerDir = path.join(paths.sharedRoot, paths.mirrorRel, relDir);
    const checkOne = (kind, raw) => {
      const clean = raw.trim().split('#')[0].split('?')[0];
      if (!clean) return;
      refs += 1;
      const absTarget = path.resolve(consumerDir, clean);
      if (fs.existsSync(absTarget)) return;
      if (fs.existsSync(path.resolve(sharedConsumerDir, clean))) return;
      const resolved = path.relative(paths.repoRoot, absTarget).split(path.sep).join('/');
      const key = rel + ' -> ' + resolved;
      broken.push({ key, file: rel, ref: raw.trim(), kind, resolved, known: known.has(key) });
    };
    let m;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(text)) !== null) {
      const raw = m[1];
      if (!raw || isExternalRef(raw)) continue;
      if (!SNAPSHOT_EXTS.has(path.extname(raw.split('#')[0].split('?')[0]).toLowerCase())) continue;
      checkOne('md_link', raw);
    }
    if (isHtml(lower)) {
      HTML_SRC_RE.lastIndex = 0;
      while ((m = HTML_SRC_RE.exec(text)) !== null) {
        const raw = m[1];
        if (!raw || isExternalRef(raw)) continue;
        checkOne('src', raw);
      }
    }
  }
  const newBroken = broken.filter((b) => !b.known);
  const byKind = (arr) => { const o = {}; for (const b of arr) o[b.kind] = (o[b.kind] || 0) + 1; return o; };
  if (writeManifest) {
    S.writeJsonAtomic(knownPath, {
      schema_version: 1,
      generated_at: S.nowIso(),
      note: 'known_debt 基线：md/html 相对引用、消费者目录解析、双根；新增断链=0 为门禁判据（mirrorRel 相对路径补全 + 按 md_link/src 分类）',
      scanned_files: files,
      scanned_refs: refs,
      known_debt: broken.map((b) => ({ key: b.key, file: b.file, ref: b.ref, kind: b.kind, resolved: b.resolved })),
      counts: { files, refs, broken: broken.length, md_link: byKind(broken).md_link || 0, src: byKind(broken).src || 0 },
    });
  }
  return { files, refs, broken: broken.length, new_broken: newBroken.length, known_debt: broken.length - newBroken.length, broken_by_kind: byKind(broken), new_broken_by_kind: byKind(newBroken), sample: newBroken.slice(0, 10), manifest_path: knownPath, manifest_written: writeManifest };
}

/** doctor 检查集（分级语义；degraded 仍 exit 0）。 */
export function runChecks({ paths, config, assets = false, requireList = [], writeAssetsManifest = false }) {
  const checks = [];
  const state = sharedRepoState(paths);
  // 单机模式（没配共享仓远端、本机也没共享仓）：shared/mirror 判 degraded，不吓退第一次 init 的陌生用户。
  const singleMachine = isSingleMachineMode(config, state);
  checks.push({
    name: 'shared',
    level: singleMachine ? S.LEVEL.degraded : (state.ok ? S.LEVEL.ok : S.LEVEL.fail),
    detail: {
      root: state.root,
      exists: state.exists,
      is_repo: state.is_repo,
      head: state.head,
      branch: state.branch,
      briefs_dir: state.briefs_dir_exists,
      ...(singleMachine ? { single_machine: true, mode: 'single-machine', hint: SINGLE_MACHINE_HINT } : {}),
    },
  });
  if (state.ok) {
    const treeCount = sharedTreeNames(paths).length;
    const link = S.isLinkOrJunction(paths.mirrorRoot);
    const mirrorCount = mirrorFiles(paths).length;
    const mirrorExists = fs.existsSync(paths.mirrorRoot);
    const mirrorOk = mirrorExists && !link.isLink && mirrorCount === treeCount;
    checks.push({ name: 'mirror', level: mirrorOk ? S.LEVEL.ok : S.LEVEL.fail, detail: { mirror_root: paths.mirrorRoot, mirror_count: mirrorCount, shared_tree_count: treeCount, is_link: link.isLink, link_kind: link.kind } });
    const lfs = gitLfsVersion(paths.sharedRoot);
    const lfsOk = !!(lfs && (lfs.major > 3 || (lfs.major === 3 && lfs.minor >= 4)));
    let textPointers = 0;
    for (const rel of mirrorFiles(paths)) {
      if (!S.isTextLikePath(rel)) continue;
      if (S.isLfsPointerFile(path.join(paths.mirrorRoot, rel))) textPointers += 1;
    }
    checks.push({ name: 'lfs', level: lfsOk && textPointers === 0 ? S.LEVEL.ok : S.LEVEL.degraded, detail: { version: lfs ? lfs.version : null, min_required: '3.4', text_pointers_in_mirror: textPointers } });
    const pack = packSizeBytes(paths);
    const packOver = !!(pack && pack.bytes > 50 * 1024 * 1024);
    checks.push({ name: 'budget', level: packOver ? S.LEVEL.degraded : S.LEVEL.ok, detail: { size_pack: pack, limit_mib: 50, over: packOver } });
  } else {
    checks.push({
      name: 'mirror',
      level: singleMachine ? S.LEVEL.degraded : S.LEVEL.fail,
      detail: {
        skipped: true,
        reason: singleMachine ? 'single_machine_no_shared_repo' : 'shared_repo_not_ready',
        ...(singleMachine ? { single_machine: true, hint: SINGLE_MACHINE_HINT } : {}),
      },
    });
  }
  const kb = kbStatus(paths);
  checks.push({ name: 'kb', level: kb.level, detail: kb });
  const vaultUrl = process.env.VAULT_URL || (config && config.vault && config.vault.url) || null;
  checks.push({ name: 'vault', level: S.LEVEL.degraded, detail: { url: vaultUrl, note: '异步探测后回填（vault 不可达/缺凭据 = degraded，永不 fail）' } });
  if (assets) {
    // --assets 可显式写 baseline（.asset-manifest.json known_debt），不再固定 false
    const a = scanAssetRefs(paths, { writeManifest: !!writeAssetsManifest });
    checks.push({ name: 'assets', level: a.new_broken === 0 ? S.LEVEL.ok : S.LEVEL.fail, detail: a });
  }
  return { checks, state, singleMachine };
}

export async function doctor({ paths, config, assets = false, requireList = [], outPath = null, writeAssetsManifest = false }) {
  const { checks, singleMachine } = runChecks({ paths, config, assets, requireList, writeAssetsManifest });
  const vaultCheck = checks.find((c) => c.name === 'vault');
  const vaultUrl = process.env.VAULT_URL || (config && config.vault && config.vault.url) || null;
  if (vaultUrl) {
    const probe = await httpGetJson(vaultUrl.replace(/\/+$/, '') + '/api/v1/health', 2000);
    vaultCheck.detail = { url: vaultUrl, probe, level_note: probe.ok ? 'vault reachable' : 'vault unreachable => degraded（不是失败）' };
    vaultCheck.level = probe.ok ? S.LEVEL.ok : S.LEVEL.degraded;
  } else {
    vaultCheck.detail = { url: null, note: 'no vault url in studio.config.json (degraded, never fail)' };
  }
  const evaluated = S.evaluateChecks(checks, requireList);
  const report = {
    schema_version: 1,
    generated_at: S.nowIso(),
    project: paths.projectId,
    repo_root: paths.repoRoot,
    mirror_root: paths.mirrorRoot,
    shared_root: paths.sharedRoot,
    require: requireList,
    checks: Object.fromEntries(checks.map((c) => [c.name, c])),
    checks_list: checks,
    ok: evaluated.exitCode === 0,
    overall: evaluated.overall,
    exit_code: evaluated.exitCode,
    failing: evaluated.failing,
    mode: singleMachine ? 'single-machine' : 'team',
    single_machine: singleMachine,
  };
  if (singleMachine) report.hint = SINGLE_MACHINE_HINT;
  if (outPath) {
    S.writeJsonAtomic(path.resolve(paths.repoRoot, outPath), report);
    report.evidence_path = path.resolve(paths.repoRoot, outPath);
  }
  return { report, exitCode: evaluated.exitCode };
}

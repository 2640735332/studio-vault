import fs from 'node:fs';
import path from 'node:path';
import { loadShared } from './deps.js';

const S = await loadShared();

const TEXT_LFS_INCLUDE = '*.md,*.html,*.htm,*.json,*.yml,*.yaml,*.svg,*.txt,*.css,*.js';
const MIRROR_INDEX = 'mirror-index.json';

/**
 * 内容指纹：文本按 LF 归一后取 sha256，二进制取精确 sha256。
 * 为什么需要归一：游戏仓库 checkout 可能把 LF 转成 CRLF（core.autocrlf），
 * 而共享仓 LFS 对象存的是提交时的 LF 字节 —— 直接比 sha256 会把「仅行尾不同」
 * 误判成「未回写」。归一后与 LFS pointer 的 oid 可直接比（未回写判定）。
 */
/**
 * 判断磁盘文件内容是否等于 LFS pointer 的 oid：
 * 先比精确 sha256；不等且是文本（不含 NUL）则按 LF 归一后再比（Windows checkout 的 CRLF 差异）。
 */
export function lfsOidMatches(abs, rel, oid) {
  try {
    const exact = S.sha256File(abs);
    if (exact === oid) return true;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return false;
    const norm = buf.includes(0x0d) ? Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : buf;
    return S.sha256Buf(norm) === oid;
  } catch {
    return false;
  }
}

/**
 * 镜像文件是否仍等于共享仓 HEAD 的内容（用 git 自己的 clean filter 口径：core.autocrlf / .gitattributes / LFS）。
 * 只有这里不等才算「真·未回写」——原始字节差（CRLF/BOM/checkout 转换）不是未回写。
 */
export function mirrorMatchesHead(paths, rel) {
  const abs = path.join(paths.mirrorRoot, rel);
  if (!fs.existsSync(abs)) return false;
  const repoRel = paths.mirrorRel + '/' + rel;
  const hashed = S.git(['hash-object', '--path', repoRel, '--', abs], { cwd: paths.sharedRoot });
  if (hashed.code !== 0) return false;
  const head = S.git(['rev-parse', 'HEAD:' + repoRel], { cwd: paths.sharedRoot });
  if (head.code !== 0) return false;
  return head.stdout.trim() === hashed.stdout.trim();
}

export function contentHash(abs, rel) {
  try {
    if (S.isTextLikePath(rel)) {
      const buf = fs.readFileSync(abs);
      if (!buf.includes(0x0d)) return S.sha256Buf(buf);
      const normalized = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      return S.sha256Buf(normalized);
    }
    return S.sha256File(abs);
  } catch {
    return null;
  }
}

export function sharedBriefsDir(paths) {
  return path.join(paths.sharedRoot, paths.mirrorRel);
}

/** 共享仓就绪判定（缺失/非 git 仓/无 HEAD 都要给恢复命令，不静默假绿）。 */
export function sharedRepoState(paths) {
  const exists = fs.existsSync(paths.sharedRoot);
  const isRepo = exists && S.isGitRepo(paths.sharedRoot);
  const head = isRepo ? S.gitHead(paths.sharedRoot) : null;
  const briefsDir = sharedBriefsDir(paths);
  return {
    root: paths.sharedRoot,
    exists,
    is_repo: isRepo,
    head,
    branch: isRepo ? S.currentBranch(paths.sharedRoot) : null,
    briefs_dir_exists: fs.existsSync(briefsDir),
    ok: !!(exists && isRepo && head && fs.existsSync(briefsDir)),
  };
}

export function sharedTreeNames(paths) {
  const r = S.lsTreeNames(paths.sharedRoot, 'HEAD', paths.mirrorRel);
  return r.ok ? r.names.map((p) => p.slice(paths.mirrorRel.length + 1)) : [];
}

function readIndex(paths) {
  return S.readJson(path.join(paths.cacheDir, MIRROR_INDEX), { schema_version: 1, files: {} });
}
function writeIndex(paths, index) {
  S.writeJsonAtomic(path.join(paths.cacheDir, MIRROR_INDEX), index);
}

/** mirror 相对路径集合（普通文件）。 */
export function mirrorFiles(paths) {
  return S.walkFiles(paths.mirrorRoot);
}

/** 共享仓工作树里 docs/briefs 的文件集合（相对 mirrorRel）。 */
export function sourceFiles(paths) {
  return S.walkFiles(sharedBriefsDir(paths));
}

/** Bootstrap legacy tracked mirrors without overwriting edits or removing history. */
export function materializeMissing(paths, { dryRun = false } = {}) {
  const state = sharedRepoState(paths);
  if (!state.ok) return { ok: false, code: 'shared_repo_not_ready', state };
  if (S.isLinkOrJunction(paths.mirrorRoot).isLink) return { ok: false, code: 'mirror_is_link' };
  const copied=[], pointers=[], existing=[];
  for (const rel of sourceFiles(paths)) {
    const source=path.join(sharedBriefsDir(paths),rel), target=path.join(paths.mirrorRoot,rel);
    // Neither existing content nor symlinks may be replaced by this mode.
    let parent=target, linked=false;
    while(parent!==paths.mirrorRoot && parent!==path.dirname(parent)) {
      if(S.isLinkOrJunction(parent).isLink) {linked=true;break;}
      parent=path.dirname(parent);
    }
    if(linked) return {ok:false,code:'mirror_is_link',path:rel};
    if(fs.existsSync(target)) {existing.push(rel);continue;}
    if(S.readLfsPointer(source)) {pointers.push(rel);continue;}
    if(!dryRun) {
      fs.mkdirSync(path.dirname(target),{recursive:true});
      try {fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);} catch(error) {if(error.code==='EEXIST'){existing.push(rel);continue;}throw error;}
    }
    copied.push(rel);
  }
  return {ok:true,code:'missing_only',dry_run:dryRun,complete_mirror:false,copied,existing:existing.length,lfs_pending:pointers};
}

/** 计算/复用 mirror 文件 sha256（缓存按 size+mtime 复用，pre-commit 快路径）。 */
function mirrorHashes(paths, { useCache = true } = {}) {
  const index = useCache ? readIndex(paths) : { schema_version: 1, files: {} };
  const next = { schema_version: 1, generated_at: S.nowIso(), files: {} };
  const out = new Map();
  for (const rel of mirrorFiles(paths)) {
    const abs = path.join(paths.mirrorRoot, rel);
    const st = S.statSafe(abs);
    const prev = index.files[rel];
    let hash;
    if (prev && prev.size === st.size && prev.mtime_ms === st.mtimeMs && prev.sha256) hash = prev.sha256;
    else { hash = contentHash(abs, rel); }
    out.set(rel, { size: st.size, mtime_ms: st.mtimeMs, sha256: hash });
    next.files[rel] = { size: st.size, mtime_ms: st.mtimeMs, sha256: hash };
  }
  return { hashes: out, index: next };
}

/**
 * 比对共享仓工作树 ⇄ 镜像。**只读**。
 * 分类：missing（源有镜无）/ extra（镜有源无 = 未回写新增）/ differing（内容不同 = 未回写修改）/
 *      seedable（源是 LFS 指针但镜像已有同 sha256 真内容，可保留免拉取）/ lfs_missing（源是 LFS 指针且镜像无内容）。
 */
export function compareMirror(paths, opts = {}) {
  const { useCache = true } = opts;
  const src = sourceFiles(paths);
  const { hashes, index } = mirrorHashes(paths, { useCache });
  const srcSet = new Set(src);
  const mirSet = new Set(hashes.keys());
  const missing = src.filter((rel) => !mirSet.has(rel));
  const extra = [...mirSet].filter((rel) => !srcSet.has(rel) && !mirrorMatchesHead(paths, rel));
  const differing = [];
  const seedable = [];
  const lfsMissing = [];
  const srcLfsPointers = [];
  for (const rel of src) {
    if (!mirSet.has(rel)) continue;
    const srcAbs = path.join(sharedBriefsDir(paths), rel);
    const mirAbs = path.join(paths.mirrorRoot, rel);
    const st = S.statSafe(srcAbs);
    const mir = hashes.get(rel);
    if (st.size > S.LFS_POINTER_MAX_BYTES) {
      const hashDiffers = !mir.sha256 || contentHash(srcAbs, rel) !== mir.sha256;
      if (hashDiffers && !mirrorMatchesHead(paths, rel)) differing.push(rel);
      continue;
    }
    const ptr = S.readLfsPointer(srcAbs);
    if (ptr) {
      srcLfsPointers.push({ rel, oid: ptr.oid, size: ptr.size, text: S.isTextLikePath(rel) });
      if (lfsOidMatches(path.join(paths.mirrorRoot, rel), rel, ptr.oid)) seedable.push(rel);
      else lfsMissing.push({ rel, oid: ptr.oid, size: ptr.size, text: S.isTextLikePath(rel) });
      continue;
    }
    if (st.size !== mir.size) { differing.push(rel); continue; }
    const srcHash = contentHash(srcAbs, rel);
    if (srcHash && mir.sha256 && srcHash !== mir.sha256) differing.push(rel);
  }
  return {
    source_count: src.length,
    mirror_count: mirSet.size,
    missing,
    extra,
    differing,
    seedable,
    lfs_missing: lfsMissing,
    lfs_pointers_source: srcLfsPointers,
    text_lfs_pointers_source: srcLfsPointers.filter((p) => p.text).length,
    binary_lfs_pointers_source: srcLfsPointers.filter((p) => !p.text).length,
    unwritten: [...new Set([...extra, ...differing])],
    _hashIndex: index,
  };
}

/** 文本类 LFS 首启全量拉取；二进制按需不阻塞（degraded）。 */
export function pullTextLfs(paths) {
  const briefs = sharedBriefsDir(paths);
  const pointers = [];
  for (const rel of S.walkFiles(briefs)) {
    if (!S.isTextLikePath(rel)) continue;
    const abs = path.join(briefs, rel);
    if (S.isLfsPointerFile(abs)) pointers.push(rel);
  }
  if (!pointers.length) return { ok: true, pulled: 0, skipped: true };
  const r = S.git(['lfs', 'pull', '--include=' + TEXT_LFS_INCLUDE], { cwd: paths.sharedRoot, timeout: 600000 });
  const stillPointers = [];
  for (const rel of pointers) {
    if (S.isLfsPointerFile(path.join(briefs, rel))) stillPointers.push(rel);
  }
  return { ok: r.code === 0 && stillPointers.length === 0, rc: r.code, pulled: pointers.length - stillPointers.length, still_pointers: stillPointers, stderr: r.stderr || null };
}

/** 未回写内容先落 journal 再清理。 */
export function journalUnwritten(paths, rels, { reason = 'sync' } = {}) {
  if (!rels.length) return null;
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(paths.journalDir, id);
  const dataDir = path.join(dir, 'data');
  S.ensureDir(dataDir);
  const files = [];
  for (const rel of rels) {
    const abs = path.join(paths.mirrorRoot, rel);
    if (!fs.existsSync(abs)) { files.push({ path: rel, state: 'deleted' }); continue; }
    const dest = path.join(dataDir, rel);
    S.ensureDir(path.dirname(dest));
    fs.copyFileSync(abs, dest);
    files.push({ path: rel, state: 'saved', bytes: S.statSafe(abs).size });
  }
  const record = { schema_version: 1, id, project: paths.projectId, reason, base_commit: S.gitHead(paths.sharedRoot), files, created_at: S.nowIso(), attempts: 0, last_error: null };
  S.writeJsonAtomic(path.join(dir, 'journal.json'), record);
  return { id, dir, record };
}

export function listJournal(paths) {
  if (!fs.existsSync(paths.journalDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(paths.journalDir)) {
    const rec = S.readJson(path.join(paths.journalDir, name, 'journal.json'), null);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * 物化镜像：以共享仓工作树为准写入 mirrorRoot（普通目录，禁 junction）。
 * @param {object} opts {dryRun, force, lfs:'text'|'none', seed}
 */
export function materialize(paths, opts = {}) {
  const { dryRun = false, force = false, lfs = 'text', seed = true } = opts;
  const state = sharedRepoState(paths);
  if (!state.ok) {
    return { ok: false, code: 'shared_repo_not_ready', state, hint: 'node scripts/studio/bootstrap.cjs（或 studio sync --clone）' };
  }
  const link = S.isLinkOrJunction(paths.mirrorRoot);
  if (link.isLink) return { ok: false, code: 'mirror_is_link', detail: link, hint: '镜像必须是普通目录（禁 junction/symlink）' };

  let lfsReport = { ok: true, skipped: true };
  if (lfs === 'text' && !dryRun) lfsReport = pullTextLfs(paths);
  const cmp = compareMirror(paths, { useCache: !dryRun });
  const plan = {
    dry_run: dryRun,
    source_count: cmp.source_count,
    mirror_count: cmp.mirror_count,
    shared_tree_count: sharedTreeNames(paths).length,
    missing: cmp.missing.length,
    extra: cmp.extra.length,
    differing: cmp.differing.length,
    seedable: cmp.seedable.length,
    lfs_missing: cmp.lfs_missing.length,
    lfs_text_pointers: cmp.text_lfs_pointers_source,
    lfs_binary_pointers: cmp.binary_lfs_pointers_source,
    unwritten: cmp.unwritten,
    lfs: lfsReport,
  };
  if (dryRun) return { ok: cmp.unwritten.length === 0, code: cmp.unwritten.length ? 'mirror_has_unwritten' : 'plan', plan, changed: 0 };

  let journal = null;
  if (cmp.unwritten.length && !force) {
    return {
      ok: false,
      code: 'mirror_has_unwritten',
      plan,
      hint: '镜像有未回写共享仓的改动；先 node scripts/studio/commit 回写（或 --force 先 journal 再清理）',
    };
  }
  if (cmp.unwritten.length && force) journal = journalUnwritten(paths, cmp.unwritten, { reason: 'sync --force' });

  const srcDir = sharedBriefsDir(paths);
  const seedSet = new Set(seed ? cmp.seedable : []);
  let copied = 0;
  let kept = 0;
  const binaryPointersKept = [];
  for (const rel of cmp.missing.concat(cmp.differing)) {
    const srcAbs = path.join(srcDir, rel);
    const destAbs = path.join(paths.mirrorRoot, rel);
    const st = S.statSafe(srcAbs);
    const ptr = st.size <= S.LFS_POINTER_MAX_BYTES ? S.readLfsPointer(srcAbs) : null;
    if (ptr) {
      const existing = S.statSafe(destAbs);
      if (seed && existing.exists && lfsOidMatches(destAbs, rel, ptr.oid)) { kept += 1; continue; }
      S.ensureDir(path.dirname(destAbs));
      fs.copyFileSync(srcAbs, destAbs);
      binaryPointersKept.push({ path: rel, oid: ptr.oid, size: ptr.size });
      copied += 1;
      continue;
    }
    S.ensureDir(path.dirname(destAbs));
    fs.copyFileSync(srcAbs, destAbs);
    copied += 1;
  }
  for (const rel of cmp.seedable) { if (seedSet.has(rel)) kept += 1; }
  for (const rel of cmp.extra) {
    try { fs.rmSync(path.join(paths.mirrorRoot, rel), { force: true }); } catch { /* ignore */ }
  }

  const after = compareMirror(paths, { useCache: false });
  writeIndex(paths, after._hashIndex);
  const ok = after.missing.length === 0 && after.unwritten.length === 0;
  return {
    ok,
    code: ok ? 'materialized' : 'verify_failed',
    plan,
    changed: copied,
    kept_seeded: kept,
    deleted: cmp.extra.length,
    journal,
    verify: {
      source_count: after.source_count,
      mirror_count: after.mirror_count,
      shared_tree_count: sharedTreeNames(paths).length,
      missing: after.missing.length,
      extra: after.extra.length,
      differing: after.differing.length,
      lfs_missing: after.lfs_missing.length,
      lfs_missing_text: after.lfs_missing.filter((x) => x.text).length,
      binary_pointers: after.lfs_missing.filter((x) => !x.text).length,
    },
  };
}

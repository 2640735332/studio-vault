/** Performance evidence adapter. Vault remains the index/object store; no metrics DB. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const SCHEMA = 's3-perf/v1';
export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_PACKAGE = 256 * 1024 * 1024;
export const PREVIEW_LIMIT = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
export function fail(code, status = 400) { const e = new Error(code); e.code = code; e.status = status; throw e; }
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('nonfinite_number');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  if (value === undefined) fail('undefined_value');
  return JSON.stringify(value);
}
export function reportId(project, key) {
  const hex = sha256(project + '\n' + key);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || /[\x00-\x1f:]/.test(value) || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..')) fail('unsafe_artifact_path');
  if (value.split('/').some(x => /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) fail('unsafe_artifact_path');
  return value;
}
function safeFile(root, relative) {
  const file = path.join(root, safePath(relative));
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(file);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('artifact_outside_package');
  return real;
}
function finiteFrames(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 2_000_000 || frames.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) fail('invalid_frame_stream');
  return frames;
}
export function frameSummary(frames) {
  finiteFrames(frames);
  const sorted = [...frames].sort((a,b) => a-b);
  const n = frames.length, total = frames.reduce((a,b) => a+b, 0);
  const tail = sorted.slice(-Math.ceil(n * .01));
  return { frames: n, duration_ms: total, mean_ms: total/n, mean_fps: 1000*n/total,
    p99_ms: sorted[Math.ceil(n*.99)-1], p99_reciprocal_fps: 1000/sorted[Math.ceil(n*.99)-1],
    one_pct_low_fps: 1000/(tail.reduce((a,b)=>a+b,0)/tail.length), max_ms: sorted[n-1] };
}
function noSecrets(value) {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (/(password|secret|authorization|(?:^|_)token$|private_key|api_key)/i.test(key)) fail('sensitive_metadata_field');
    noSecrets(child);
  }
  if (typeof value === 'string' && /https?:\/\/[^/\s]+:[^/\s]+@/.test(value)) fail('credential_in_url');
}
export function validateManifest(m) {
  if (!m || m.schema !== SCHEMA) fail('unsupported_schema');
  if (!uuid.test(m.run_id || '')) fail('invalid_run_id');
  for (const key of ['project', 'case_id', 'case_version', 'testbed', 'profile', 'metric_version', 'policy_version', 'created_at']) {
    if (typeof m[key] !== 'string' || !m[key] || m[key].length > 200) fail('missing_' + key);
  }
  if (!digest.test(m.request_key || '')) fail('invalid_request_key');
  if (!['historical', 'manual', 'ci'].includes(m.source)) fail('invalid_source');
  // v1 never grants baseline or CI trust from a client declaration.
  if (m.trust !== 'observation') fail('untrusted_baseline_claim');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 100) fail('invalid_files');
  const seen = new Set(); let total = 0;
  for (const f of m.files) {
    safePath(f.path);
    const normalized=f.path.normalize('NFC').toLowerCase();
    if (seen.has(normalized) || normalized === 'manifest.json' || normalized === 'sync.json') fail('duplicate_artifact_path');
    seen.add(normalized);
    if (!digest.test(f.sha256 || '') || !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > MAX_FILE) fail('invalid_artifact');
    total += f.size;
  }
  if (total > MAX_PACKAGE) fail('package_too_large', 413);
  noSecrets(m); canonical(m);
  return m;
}
export function readPackage(dir) {
  const root = fs.realpathSync(dir);
  const mfile = safeFile(root, 'manifest.json');
  if (fs.statSync(mfile).size > 1024*1024) fail('manifest_too_large', 413);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(mfile, 'utf8')));
  for (const f of manifest.files) {
    const file = safeFile(root, f.path), stat = fs.statSync(file);
    if (stat.size !== f.size || sha256(fs.readFileSync(file)) !== f.sha256) fail('artifact_hash_mismatch');
  }
  return { root, manifest, manifest_hash: sha256(canonical(manifest)) };
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.partial';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, file);
}
export function importFrames(source, out, meta) {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > MAX_FILE) fail('source_too_large', 413);
  const bytes = fs.readFileSync(source), compressed = source.endsWith('.gz');
  const raw = JSON.parse((compressed ? gunzipSync(bytes,{maxOutputLength:MAX_FILE}) : bytes).toString('utf8'));
  const artifactPath = compressed ? 'frames.json.gz' : 'frames.json';
  // Preserve the original stream and its definition. Do not silently join process/post_draw.
  const stream = meta.stream || (Array.isArray(raw.post_draw_ms) && raw.post_draw_ms.length ? 'post_draw_ms' : 'frame_ms');
  const frames = finiteFrames(raw[stream]);
  const metrics = frameSummary(frames);
  const manifest = {
    schema: SCHEMA, run_id: meta.run_id || randomUUID(), capture_id: meta.capture_id || randomUUID(),
    project: meta.project, repository: meta.repository || 'unknown', case_id: meta.case_id,
    case_version: meta.case_version || '1', testbed: meta.testbed || 'unknown', profile: meta.profile || 'historical',
    source: meta.source || 'historical', mode: meta.mode || 'observation', trust: 'observation',
    metric_version: 'frame-v2/' + stream, policy_version: meta.policy_version || 's3-perf-observe-v1',
    created_at: meta.created_at || new Date().toISOString(), commit: meta.commit || 'unknown',
    base_commit: meta.base_commit || 'unknown', comparison_id: meta.comparison_id || null,
    input_hash: meta.input_hash || 'unknown', config_hash: meta.config_hash || 'unknown', engine_hash: meta.engine_hash || 'unknown',
    request_key: meta.request_key || sha256(canonical({project:meta.project, case_id:meta.case_id, source_sha:sha256(bytes), window:meta.window || 'manual'})),
    qualification: { status: 'unverified', reasons: ['imported evidence; controlled environment and workload not certified'] },
    capabilities: { frames: 'available', os_present: 'unsupported', process: 'not_collected', gpu: 'not_collected', profiler: 'not_collected' },
    stream, metrics, files: [{path:artifactPath, size:bytes.length, sha256:sha256(bytes), type:compressed?'application/gzip':'application/json', role:'evidence'}],
  };
  validateManifest(manifest);
  if (fs.existsSync(out)) fail('output_already_exists', 409);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, artifactPath), bytes, { flag:'wx' });
  atomicJson(path.join(out, 'manifest.json'), manifest);
  return { ...readPackage(out), metrics };
}
export function connection(config = {}, env = process.env) {
  const base = String(env.VAULT_URL || config.vault?.url || 'http://127.0.0.1:3460').replace(/\/+$/, '');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('invalid_vault_url');
  let token = env.STUDIO_PERF_TOKEN || env.VAULT_TOKEN || '';
  const tokenFile = env.STUDIO_VAULT_READER_TOKEN_FILE || env.STUDIO_VAULT_WRITER_TOKEN_FILE || env.VAULT_WRITER_TOKEN_FILE || path.join(os.homedir(), '.studio', 'secrets', 'vault-writer-token.txt');
  if (!token) { try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* absence is explicit below */ } }
  return { base, token, project: config.project?.id || env.STUDIO_PROJECT || '' };
}
export async function vaultRequest(conn, route, { method='GET', json, body, headers={}, binary=false, allow404=false } = {}) {
  if (!conn.token) fail('vault_credentials_missing', 503);
  if (conn.project) route += (route.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(conn.project);
  let res;
  try { res = await fetch(conn.base + route, { method, headers:{Authorization:'Bearer '+conn.token, ...(json === undefined ? {} : {'Content-Type':'application/json'}), ...headers}, body:json === undefined ? body : JSON.stringify(json), signal:AbortSignal.timeout(20_000) }); }
  catch { fail('vault_unreachable', 503); }
  if (allow404 && res.status === 404) return null;
  if (!res.ok) { await res.body?.cancel(); fail('vault_http_' + res.status, res.status); }
  if (binary) {
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_FILE) { await res.body?.cancel(); fail('artifact_too_large', 413); }
    const reader = res.body.getReader(), chunks=[]; let size=0;
    for (;;) { const {done,value} = await reader.read(); if (done) break; size+=value.length; if (size>MAX_FILE) { await reader.cancel(); fail('artifact_too_large',413); } chunks.push(Buffer.from(value)); }
    return Buffer.concat(chunks);
  }
  return res.json();
}
async function createImmutable(conn, id, kind, payload, title) {
  const route='/api/v1/reports/'+id;
  let existing = await vaultRequest(conn, route, {allow404:true});
  if (!existing) {
    try { return await vaultRequest(conn, '/api/v1/reports', {method:'POST', headers:{'If-None-Match':'*'}, json:{id,kind,title,payload}}); }
    catch (e) {
      if (!['vault_http_409','vault_http_412'].includes(e.code)) throw e;
      existing = await vaultRequest(conn, route, {allow404:true});
      if (!existing) throw e;
    }
  }
  if (existing.report.kind !== kind || canonical(existing.report.payload) !== canonical(payload)) fail('run_identity_conflict',409);
  return existing;
}
export async function publishPackage(dir, conn) {
  const pkg = readPackage(dir), m = pkg.manifest;
  if (m.project !== conn.project) fail('project_mismatch',403);
  const health=await vaultRequest(conn,'/api/v1/health');
  if(health.capabilities?.reportCreateOnly!==true || health.capabilities?.performanceArtifactIntegrity!==true)fail('vault_upgrade_required',409);
  const id = reportId(m.project, 'run:'+m.run_id);
  atomicJson(path.join(dir,'sync.json'), {state:'pending',report_id:id,manifest_hash:pkg.manifest_hash});
  try {
    await createImmutable(conn, id, 'performance-run', m, `${m.case_id} / ${m.run_id}`);
    for (const f of m.files) {
      const fileRoute='/api/v1/reports/'+id+'/file?path='+encodeURIComponent(f.path);
      let bytes = await vaultRequest(conn,fileRoute,{binary:true,allow404:true});
      if (bytes && sha256(bytes) !== f.sha256) fail('remote_artifact_conflict',409);
      if (!bytes) {
        await vaultRequest(conn,'/api/v1/reports/'+id+'/files?path='+encodeURIComponent(f.path),{method:'PUT',body:fs.readFileSync(safeFile(pkg.root,f.path)),headers:{'Content-Type':'application/octet-stream'}});
        // Independent GET checks actual object bytes, not the upload response's own hash.
        bytes = await vaultRequest(conn,fileRoute,{binary:true});
      }
      if (bytes.length !== f.size || sha256(bytes) !== f.sha256) fail('remote_hash_mismatch');
    }
    const receipt={schema:SCHEMA,run_id:m.run_id,report_id:id,manifest_hash:pkg.manifest_hash,files:m.files.map(f=>({path:f.path,sha256:f.sha256,size:f.size})),complete:true};
    await createImmutable(conn,reportId(m.project,'receipt:'+m.run_id),'performance-receipt',receipt,'Verified performance evidence');
    const result={state:'complete',report_id:id,run_id:m.run_id,manifest_hash:pkg.manifest_hash,verified_files:m.files.length};
    atomicJson(path.join(dir,'sync.json'), result); return result;
  } catch(e) { atomicJson(path.join(dir,'sync.json'),{state:'pending',report_id:id,error:e.code || 'publish_failed'}); throw e; }
}
export async function getRun(conn, id) {
  if (!uuid.test(id || '')) fail('invalid_report_id');
  const result=await vaultRequest(conn,'/api/v1/reports/'+id);
  if (result.report.kind !== 'performance-run') fail('not_a_performance_run');
  const manifest=validateManifest(result.report.payload);
  const receipt=await vaultRequest(conn,'/api/v1/reports/'+reportId(manifest.project,'receipt:'+manifest.run_id),{allow404:true});
  const complete=receipt?.report.kind==='performance-receipt' && receipt.report.payload.complete===true && receipt.report.payload.report_id===id && receipt.report.payload.manifest_hash===sha256(canonical(manifest));
  return {report_id:id,manifest,author:result.report.author,files:result.files,state:complete?'complete':'partial'};
}
export async function listRuns(conn, {limit=50,offset=0}={}) {
  const page=await vaultRequest(conn,`/api/v1/reports?kind=performance-run&limit=${Math.min(500,Math.max(1,limit))}&offset=${Math.max(0,offset)}`);
  return { ...page, items:(page.items || []).map(r=>({report_id:r.id,manifest:r.payload,created_at:r.createdAt})), limit, offset };
}
export async function publishIntegration(file, conn) {
  if(fs.statSync(file).size>1024*1024)fail('integration_too_large',413);
  const record=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(record.schema!=='s3-perf-integration/v1'||!uuid.test(record.run_id || '')||record.mode!=='observe')fail('invalid_integration_record');
  for(const key of ['source_sha','perf_sha'])if(!/^[a-f0-9]{40}$/.test(record[key] || ''))fail('invalid_'+key);
  if(record.candidate_sha!==null&&!/^[a-f0-9]{40}$/.test(record.candidate_sha || ''))fail('invalid_candidate_sha');
  if(record.auto_publish!==false||record.auto_issue!==false)fail('integration_cannot_grant_automation');
  noSecrets(record);canonical(record);
  const health=await vaultRequest(conn,'/api/v1/health');
  if(health.capabilities?.reportCreateOnly!==true)fail('vault_upgrade_required',409);
  const id=reportId(conn.project,'integration:'+record.run_id);
  await createImmutable(conn,id,'performance-integration',record,'Performance CI '+(record.job || 'observation'));
  return {state:'registered',report_id:id,run_id:record.run_id,gameplay_pass:false};
}
export async function downloadRun(conn, id, out) {
  const run=await getRun(conn,id);
  if (run.state !== 'complete') fail('run_not_complete',409);
  if (fs.existsSync(out)) fail('output_already_exists',409);
  fs.mkdirSync(out,{recursive:true});
  for (const f of run.manifest.files) {
    const bytes=await vaultRequest(conn,'/api/v1/reports/'+id+'/file?path='+encodeURIComponent(f.path),{binary:true});
    if (bytes.length !== f.size || sha256(bytes)!==f.sha256) fail('download_hash_mismatch');
    const dest=path.join(out,safePath(f.path));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});
  }
  atomicJson(path.join(out,'manifest.json'),run.manifest);
  readPackage(out);return {state:'verified',report_id:id,files:run.manifest.files.length};
}
export function compareRuns(base, candidate) {
  const keys=['project','case_id','case_version','testbed','profile','metric_version','policy_version','input_hash','config_hash','engine_hash'];
  const mismatches=keys.filter(k=>!base[k] || ['unknown','historical'].includes(base[k]) || base[k]!==candidate[k]);
  const deltas={};
  for (const k of ['mean_ms','p99_ms','max_ms']) {
    const a=base.metrics?.[k], b=candidate.metrics?.[k];
    if (typeof a==='number' && a>0 && typeof b==='number' && Number.isFinite(b)) deltas[k]=(b/a-1)*100;
  }
  const comparable=!mismatches.length && Object.keys(deltas).length===3;
  return {comparable,mismatches,deltas,classification:comparable?'observation_only':'incomparable',baseline_eligible:false,reason:'Single imported observations cannot confirm a regression or approve a baseline.'};
}
export function pendingPackages(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>{
    try { const dir=path.join(root,e.name),p=readPackage(dir);let sync={state:'local'};try{sync=JSON.parse(fs.readFileSync(path.join(dir,'sync.json'),'utf8'));}catch{}return {run_id:p.manifest.run_id,case_id:p.manifest.case_id,state:sync.state,error:sync.error || null,directory:e.name}; }
    catch { return {directory:e.name,state:'invalid'}; }
  });
}

/** Consume a CI-authored, Conbench-confirmed comparison. A raw user JSON verdict is insufficient. */
export async function publishRegression(conn, comparisonId, {enabled=false,trustedAuthors=[],conbenchUrl=''}={}) {
  if (!enabled) fail('automatic_issue_disabled',409);
  if (!trustedAuthors.length || !conbenchUrl) fail('ci_trust_or_conbench_unconfigured',503);
  if (!uuid.test(comparisonId || '')) fail('invalid_comparison_id');
  const record=await vaultRequest(conn,'/api/v1/reports/'+comparisonId);
  const proof=record.report.payload, author=record.report.author;
  if (record.report.kind!=='performance-comparison' || !trustedAuthors.includes(author)) fail('untrusted_comparison',403);
  if (proof.schema!=='s3-perf-comparison/v1' || proof.classification!=='confirmed_regression' || proof.provider!=='conbench' || proof.independent_confirmation!==true || proof.last_good_compared!==true) fail('regression_not_confirmed',409);
  const target=new URL(proof.comparison_url), backend=new URL(conbenchUrl);
  if (!['http:','https:'].includes(target.protocol) || target.origin!==backend.origin || target.username || target.password) fail('invalid_comparison_url');
  if (!/^track-\d{3}-[A-Za-z0-9]+$/.test(proof.source_track || '')) fail('source_track_required');
  for (const key of ['base_commit','candidate_commit','last_good_commit','first_bad_commit']) if(!/^[a-f0-9]{40}$/.test(proof[key] || ''))fail('invalid_'+key);
  const samples=proof.sample_report_ids,controls=proof.control_report_ids;
  if (!Array.isArray(samples)||samples.length<8||samples.length>32||!Array.isArray(controls)||controls.length<5||controls.length>50)fail('confirmation_samples_missing');
  const ids=[...samples,...controls];if(new Set(ids).size!==ids.length)fail('duplicate_confirmation_sample');
  const runs=[];
  for(const id of ids){const run=await getRun(conn,id);if(run.state!=='complete'||!trustedAuthors.includes(run.author)||run.manifest.source!=='ci'||run.manifest.mode!=='controlled'||run.manifest.clean!==true||run.manifest.qualification?.status!=='valid')fail('unqualified_confirmation_sample',409);runs.push(run);}
  const first=runs[0].manifest;
  if(runs.some(r=>!compareRuns(first,r.manifest).comparable))fail('incomparable_confirmation_samples',409);
  // ABBA is repeated independently. Each run is tied to its exact base/candidate commit.
  const order=[proof.base_commit,proof.candidate_commit,proof.candidate_commit,proof.base_commit];
  if(samples.length!==8||runs.slice(0,8).some((r,i)=>r.manifest.commit!==order[i%4]))fail('invalid_confirmation_order');
  if(runs.slice(8).some(r=>r.manifest.commit!==proof.last_good_commit))fail('invalid_control_commit');
  const eventKey=sha256(canonical({project:conn.project,case_id:first.case_id,case_version:first.case_version,testbed:first.testbed,profile:first.profile,metric_version:first.metric_version,last_good:proof.last_good_commit,first_bad:proof.first_bad_commit}));
  const legacyId=String(parseInt(eventKey.slice(0,12),16)%100_000_000).padStart(8,'0');
  let existing=await vaultRequest(conn,'/api/v1/bugs/by-legacy/'+legacyId,{allow404:true});
  if(!existing){existing=await vaultRequest(conn,'/api/v1/bugs',{method:'POST',json:{legacyId,title:'Performance regression: '+first.case_id,severity:'high',priority:'P1',status:'new',commitSha:proof.candidate_commit,sourceTrack:proof.source_track,fingerprint:eventKey,payload:{performance:{event_key:eventKey,comparison_report_id:comparisonId,case_id:first.case_id,testbed:first.testbed,comparison_url:proof.comparison_url},domain:proof.owner_domain || 'performance-engineering'}}});}
  const bug=existing.bug;
  if(bug?.payload?.performance?.event_key!==eventKey)fail('legacy_event_collision',409);
  for(const id of [comparisonId,...ids])await vaultRequest(conn,'/api/v1/links',{method:'POST',json:{reportId:id,bugId:bug.id,role:'evidence'}});
  return {event_key:eventKey,legacy_id:legacyId,bug_id:bug.id,linked_reports:ids.length+1,status:bug.status};
}

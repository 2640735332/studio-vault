import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const ARCHIVE_SCHEMA = 'studio-archive/v1';
const KIND = 'workspace-archive', PACK_SIZE = 16 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const recoverableRead = error => /^vault_http_(404|429|5\d\d)$/.test(error.message) || error.message==='archive_content_hash_mismatch' || ['fetch failed','terminated'].includes(error.message) || ['AbortError','TimeoutError'].includes(error.name);
export function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':') || /[\x00-\x1f]/.test(value)) fail('unsafe_archive_path');
  if (value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) fail('unsafe_archive_path');
  return value;
}
export function isSecretPath(value) {
  return /(^|\/)(\.env($|\.)|\.npmrc$|id_(rsa|ed25519)$|credentials($|\.)|.*(?:token|password|secret|private-key).*(?:\.txt|\.json|\.env|\.pem|\.key)$)/i.test(value) && !/\.example$/.test(value);
}
async function request(conn, route, { method='GET', json, body, binary=false, allow404=false, retries=3 }={}) {
  if (!conn.token || !conn.project) fail('vault_credentials_or_project_missing');
  const url = new URL(route, conn.base); url.searchParams.set('project', conn.project);
  for (let attempt=0; ; attempt++) {
    try {
      const response = await fetch(url, {method, headers:{Authorization:'Bearer '+conn.token, ...(json===undefined?{}:{'Content-Type':'application/json'})}, body:json===undefined?body:JSON.stringify(json), signal:AbortSignal.timeout(120000)});
      if (allow404 && response.status===404) return null;
      if (!response.ok) { await response.body?.cancel(); const e = new Error('vault_http_'+response.status); e.retryable=response.status>=500 || response.status===429; throw e; }
      return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    } catch (error) {
      if (attempt>=retries || error.retryable===false || /^vault_http_[34]/.test(error.message) && error.message!=='vault_http_429') throw error;
      await new Promise(resolve=>setTimeout(resolve, 500*(2**attempt)));
    }
  }
}
const routeFor = id => '/api/v1/reports/'+encodeURIComponent(id);
const fileRoute = (id, file, upload=false) => routeFor(id)+(upload?'/files?path=':'/file?path=')+encodeURIComponent(file);
function verify(bytes, sha) { if (digest(bytes)!==sha) fail('archive_content_hash_mismatch'); return bytes; }

// A supplied selection is a snapshot contract: missing, changing or linked files fail closed.
// Large files are segmented; each bounded pack is independently uploaded and read back.
export async function uploadArchive(conn, selection, {id=crypto.randomUUID(), progress=()=>{}}={}) {
  const root=path.resolve(selection.root), files=[...new Set(selection.files)].sort();
  for (const rel of files) { safeArchivePath(rel); if (isSecretPath(rel)) fail('secret_requires_separate_protected_storage: '+rel); }
  const payload={schema:ARCHIVE_SCHEMA, source:selection.label || path.basename(root), metadata:selection.metadata || {}, selection_sha256:digest(JSON.stringify(files)), retention:'permanent'};
  let existing=await request(conn,routeFor(id),{allow404:true});
  if (!existing) existing=await request(conn,'/api/v1/reports',{method:'POST',json:{id,kind:KIND,title:selection.title || 'Workspace archive: '+payload.source,payload}});
  if (existing.report.kind!==KIND || JSON.stringify(existing.report.payload)!==JSON.stringify(payload)) {
    // PostgreSQL JSONB does not preserve key ordering.
    if (existing.report.kind!==KIND || existing.report.payload?.schema!==ARCHIVE_SCHEMA || existing.report.payload?.selection_sha256!==payload.selection_sha256 || existing.report.payload?.source!==payload.source) fail('archive_identity_conflict');
  }
  const known=new Map((existing.files || []).map(f=>[f.path,f]));
  if (known.has('complete.json')) fail('archive_already_complete');
  const packs=[], entries=[], jobs=new Set(); let chunk=[], length=0, packNumber=0, total=0;
  async function put(name, bytes) {
    const sha256=digest(bytes), prior=known.get(name);
    if (prior?.sha256===sha256) {
      try {verify(await request(conn,fileRoute(id,name),{binary:true,retries:0}),sha256);return {path:name,sha256,size:bytes.length};}
      catch(error) {if(!recoverableRead(error))throw error;}
    }
    await request(conn,fileRoute(id,name,true),{method:'PUT',body:bytes});
    verify(await request(conn,fileRoute(id,name),{binary:true}),sha256);
    return {path:name,sha256,size:bytes.length};
  }
  async function flush() {
    if (!length) return;
    const number=packNumber++, name='packs/'+String(number).padStart(6,'0')+'.gz', raw=Buffer.concat(chunk,length);
    chunk=[];length=0;
    const job=(async()=>{ const result=await put(name,gzipSync(raw,{level:1})); packs[number]={...result,raw_size:raw.length}; progress({id,packs:number+1,bytes:total}); })();
    jobs.add(job); job.then(()=>jobs.delete(job),()=>{});
    if (jobs.size>=2) await Promise.race(jobs);
  }
  for (const rel of files) {
    const filename=path.join(root,...rel.split('/')); let parent=root;
    for (const part of rel.split('/')) { parent=path.join(parent,part); if (fs.lstatSync(parent).isSymbolicLink()) fail('archive_symlink_not_supported'); }
    const before=fs.statSync(filename,{bigint:true}); if (!before.isFile()) fail('archive_source_not_file');
    const entry={path:rel,size:Number(before.size),mtime_ns:String(before.mtimeNs),sha256:null,segments:[]}, hash=crypto.createHash('sha256');
    const fd=fs.openSync(filename,'r');
    try {
      let offset=0;
      while(offset<entry.size) {
        const count=Math.min(entry.size-offset,PACK_SIZE-length), bytes=Buffer.allocUnsafe(count);
        let read=0; while(read<count) { const n=fs.readSync(fd,bytes,read,count-read,offset+read); if(!n) fail('archive_source_changed'); read+=n; }
        hash.update(bytes); entry.segments.push({pack:packNumber,offset:length,length:count}); chunk.push(bytes); length+=count; offset+=count; total+=count;
        if(length===PACK_SIZE) await flush();
      }
    } finally {fs.closeSync(fd);}
    const after=fs.statSync(filename,{bigint:true});
    if(before.size!==after.size || before.mtimeNs!==after.mtimeNs) fail('archive_source_changed: '+rel);
    entry.sha256=hash.digest('hex'); entries.push(entry);
  }
  await flush(); await Promise.all(jobs);
  const manifest={schema:ARCHIVE_SCHEMA,id,source:payload.source,metadata:payload.metadata,files:entries,packs,total_bytes:total};
  const index=await put('manifest.json.gz',gzipSync(Buffer.from(JSON.stringify(manifest)),{level:6}));
  if(index.size>32*1024*1024) fail('archive_index_too_large');
  const seal={schema:ARCHIVE_SCHEMA,id,manifest:index,files:entries.length,total_bytes:total,packs:packs.length,verified_at:new Date().toISOString()};
  await put('complete.json',Buffer.from(JSON.stringify(seal)));
  return {id,uri:'vault://'+conn.project+'/reports/'+id,...seal};
}
export async function getArchive(conn,id) {
  const report=await request(conn,routeFor(id));
  if(report.report.kind!==KIND || report.report.payload?.schema!==ARCHIVE_SCHEMA) fail('not_workspace_archive');
  const sealFile=report.files.find(f=>f.path==='complete.json'); if(!sealFile) fail('archive_incomplete');
  const seal=JSON.parse(verify(await request(conn,fileRoute(id,'complete.json'),{binary:true}),sealFile.sha256));
  const manifest=JSON.parse(gunzipSync(verify(await request(conn,fileRoute(id,'manifest.json.gz'),{binary:true}),seal.manifest.sha256)));
  if(manifest.schema!==ARCHIVE_SCHEMA || manifest.id!==id || manifest.files.length!==seal.files) fail('archive_manifest_invalid');
  return {report,seal,manifest};
}
export async function listArchives(conn) {
  const items=[]; for(let offset=0;;offset+=100) {
    const page=await request(conn,'/api/v1/reports?kind='+KIND+'&limit=100&offset='+offset);
    const rows=page.items || page.reports || []; items.push(...rows); if(rows.length<100) break;
  } return items;
}
export async function searchArchives(conn,query,{id,limit=100}={}) {
  const ids=id?[id]:(await listArchives(conn)).map(row=>row.id), matches=[];
  for(const archiveId of ids) {
    let archive; try {archive=await getArchive(conn,archiveId);} catch(e) {if(e.message==='archive_incomplete') continue; throw e;}
    for(const entry of archive.manifest.files) if(entry.path.toLowerCase().includes(query.toLowerCase())) {
      matches.push({id:archiveId,source:archive.manifest.source,path:entry.path,size:entry.size,sha256:entry.sha256,uri:'vault://'+conn.project+'/reports/'+archiveId+'?path='+encodeURIComponent(entry.path)});
      if(matches.length>=limit) return matches;
    }
  } return matches;
}
export async function downloadArchive(conn,id,out,{file}={}) {
  const {manifest}=await getArchive(conn,id), destination=path.resolve(out);
  if(fs.existsSync(destination)) fail('archive_output_must_be_new');
  const entries=file?manifest.files.filter(e=>e.path===file):manifest.files;
  if(file && !entries.length) fail('archive_file_not_found');
  for(const entry of entries) safeArchivePath(entry.path);
  fs.mkdirSync(destination,{recursive:true});
  let cached=-1, raw;
  for(const entry of entries) {
    const target=path.join(destination,...entry.path.split('/')); fs.mkdirSync(path.dirname(target),{recursive:true});
    const fd=fs.openSync(target,'wx'), hash=crypto.createHash('sha256'); let size=0;
    try {
      for(const segment of entry.segments) {
        if(cached!==segment.pack) {const pack=manifest.packs[segment.pack]; if(!pack)fail('archive_pack_missing');raw=gunzipSync(verify(await request(conn,fileRoute(id,pack.path),{binary:true}),pack.sha256));cached=segment.pack;}
        const bytes=raw.subarray(segment.offset,segment.offset+segment.length); if(bytes.length!==segment.length)fail('archive_segment_invalid');
        fs.writeSync(fd,bytes); hash.update(bytes); size+=bytes.length;
      }
    } finally {fs.closeSync(fd);}
    if(size!==entry.size || hash.digest('hex')!==entry.sha256) fail('archive_restored_hash_mismatch');
    const seconds=Number(BigInt(entry.mtime_ns))/1e9; fs.utimesSync(target,seconds,seconds);
  }
  return {id,directory:destination,files:entries.length,verified:true};
}

// Recovery uses an authenticated manifest hash as the authority. Source changes
// cannot replace archived content: each regenerated compressed pack must match it.
export async function repairArchive(conn,id,manifest,root,{progress=()=>{}}={}) {
  const report=await request(conn,routeFor(id));
  if(report.report.kind!==KIND || manifest.schema!==ARCHIVE_SCHEMA || manifest.id!==id) fail('not_workspace_archive');
  const indexFile=report.files.find(f=>f.path==='manifest.json.gz');
  if(!indexFile) fail('repair_requires_registered_manifest');
  const indexBytes=gzipSync(Buffer.from(JSON.stringify(manifest)),{level:6});
  verify(indexBytes,indexFile.sha256);
  const segments=manifest.packs.map(()=>[]),source=path.resolve(root);
  for(const file of manifest.files) {
    safeArchivePath(file.path);let offset=0;
    for(const segment of file.segments) {segments[segment.pack].push({...segment,file:file.path,file_offset:offset});offset+=segment.length;}
  }
  let repaired=0,verified=0;
  for(let number=0;number<manifest.packs.length;number++) {
    const pack=manifest.packs[number];
    try {verify(await request(conn,fileRoute(id,pack.path),{binary:true,retries:0}),pack.sha256);verified++;continue;}
    catch(error) {if(!recoverableRead(error))throw error;}
    const raw=Buffer.alloc(pack.raw_size);
    for(const part of segments[number]) {
      const filename=path.join(source,...part.file.split('/'));
      if(fs.lstatSync(filename).isSymbolicLink()) fail('archive_symlink_not_supported');
      const fd=fs.openSync(filename,'r');
      try {let read=0;while(read<part.length){const n=fs.readSync(fd,raw,part.offset+read,part.length-read,part.file_offset+read);if(!n)fail('repair_source_changed');read+=n;}}
      finally {fs.closeSync(fd);}
    }
    const bytes=gzipSync(raw,{level:1});
    if(digest(bytes)!==pack.sha256) fail('repair_source_changed');
    await request(conn,fileRoute(id,pack.path,true),{method:'PUT',body:bytes});
    verify(await request(conn,fileRoute(id,pack.path),{binary:true}),pack.sha256);
    repaired++;verified++;progress({id,verified,repaired,packs:manifest.packs.length});
  }
  await request(conn,fileRoute(id,'manifest.json.gz',true),{method:'PUT',body:indexBytes});
  const seal={schema:ARCHIVE_SCHEMA,id,manifest:{path:'manifest.json.gz',sha256:indexFile.sha256,size:indexBytes.length},files:manifest.files.length,total_bytes:manifest.total_bytes,packs:manifest.packs.length,verified_at:new Date().toISOString()};
  await request(conn,fileRoute(id,'complete.json',true),{method:'PUT',body:Buffer.from(JSON.stringify(seal))});
  await getArchive(conn,id);
  return {id,repaired,verified,uri:'vault://'+conn.project+'/reports/'+id};
}

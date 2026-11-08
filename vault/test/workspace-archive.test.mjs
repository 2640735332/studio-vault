import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startTestApp, TOKEN_A, TOKEN_B } from './helpers.mjs';
import { FsObjectStore } from '../src/store/objects.mjs';
import { PgVaultStore } from '../src/store/pg.mjs';
import { uploadArchive, getArchive, listArchives, searchArchives, downloadArchive, repairArchive, safeArchivePath } from '../../packages/studio/src/archive.js';

test('archive packs span files, survive retention, search and restore exact bytes', async t=>{
  const app=await startTestApp(); t.after(()=>app.close());
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-archive-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source');fs.mkdirSync(source);
  const large=crypto.randomBytes(17*1024*1024+321), text=Buffer.from('source material: 恢复验证');
  fs.writeFileSync(path.join(source,'capture.bin'),large);fs.writeFileSync(path.join(source,'notes.txt'),text);fs.writeFileSync(path.join(source,'empty'),Buffer.alloc(0));
  const conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'};
  const result=await uploadArchive(conn,{root:source,label:'test-archive',files:['capture.bin','notes.txt','empty']});
  assert.equal(result.packs,2);assert.equal(result.files,3);
  assert.equal((await listArchives(conn)).length,1);
  const hits=await searchArchives(conn,'notes');assert.equal(hits.length,1);assert.equal(hits[0].id,result.id);
  const restored=await downloadArchive(conn,result.id,path.join(root,'restore'));
  assert.equal(restored.verified,true);assert.deepEqual(fs.readFileSync(path.join(root,'restore','capture.bin')),large);assert.deepEqual(fs.readFileSync(path.join(root,'restore','notes.txt')),text);
  assert.equal(fs.statSync(path.join(root,'restore','empty')).size,0);
  await assert.rejects(downloadArchive(conn,result.id,path.join(root,'restore')),/must_be_new/);
  await assert.rejects(getArchive({...conn,token:TOKEN_B},result.id),/vault_http_403/);
  const stored=app.store.reports.get(result.id);stored.createdAt='2000-01-01T00:00:00.000Z';
  assert.equal((await app.store.retentionCandidates({reportRetainDays:1})).expireReports,0);
  assert.equal(await app.store.applyExpireReports({reportRetainDays:1}),0);assert.equal(stored.deletedAt,null);
  const archive=await getArchive(conn,result.id), pack=archive.manifest.packs[0];
  // Corrupt the stored blob through the test service's configured object directory.
  const objectPath=path.join(app.config.objectsDir,pack.sha256.slice(0,2),pack.sha256.slice(2,4),pack.sha256);
  fs.writeFileSync(objectPath,Buffer.from('corrupt'));
  await assert.rejects(downloadArchive(conn,result.id,path.join(root,'corrupt-restore')),/vault_http_503/);
  // A store rollback can retain metadata while losing bytes. Quarantine bad bytes,
  // restore only the original registered content, and renew the verification seal.
  fs.unlinkSync(objectPath);
  const indexFile=archive.report.files.find(f=>f.path==='manifest.json.gz');
  fs.unlinkSync(path.join(app.config.objectsDir,indexFile.sha256.slice(0,2),indexFile.sha256.slice(2,4),indexFile.sha256));
  const realFetch=globalThis.fetch;let resetOnce=true;
  t.mock.method(globalThis,'fetch',(url,options)=>{
    if(resetOnce && (!options?.method || options.method==='GET') && String(url).includes('000000.gz')){resetOnce=false;throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});}
    return realFetch(url,options);
  });
  const repair=await repairArchive(conn,result.id,archive.manifest,source);assert.equal(repair.repaired,1);assert.equal(repair.verified,2);
  assert.equal(resetOnce,false);
  await downloadArchive(conn,result.id,path.join(root,'repaired'),{file:'notes.txt'});
  assert.deepEqual(fs.readFileSync(path.join(root,'repaired','notes.txt')),text);
  const lastPack=archive.manifest.packs[1];
  fs.unlinkSync(path.join(app.config.objectsDir,lastPack.sha256.slice(0,2),lastPack.sha256.slice(2,4),lastPack.sha256));
  fs.writeFileSync(path.join(source,'notes.txt'),'different source');
  await assert.rejects(repairArchive(conn,result.id,archive.manifest,source),/repair_source_changed/);
});
test('concurrent content-addressed writes have distinct temporary files',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vault-cas-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const objects=new FsObjectStore({root});await objects.init();
  const bytes=crypto.randomBytes(80000),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  await Promise.all(Array.from({length:50},()=>objects.putBuffer(sha,bytes)));
  assert.deepEqual(await objects.readBuffer(sha),bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(objects.pathFor(sha))),[sha]);
});
test('PostgreSQL preview and expiration both exclude permanent archives',async()=>{
  const queries=[],store=new PgVaultStore({});
  store.client={query:async sql=>{queries.push(sql);return {rows:[{count:'0'}]};}};
  await store.retentionCandidates({});await store.applyExpireReports({});
  const expiry=queries.filter(sql=>sql.includes('r.deleted_at') && !sql.includes("storage_tier <>"));
  assert.equal(expiry.length,2);
  assert.ok(expiry.every(sql=>sql.includes("r.kind <> 'workspace-archive'")));
});
test('archive rejects traversal, credential files and unfinished reports',async t=>{
  for(const value of ['../outside','/root','a\\b','C:/root','a/../x','CON.txt','folder/x.']) assert.throws(()=>safeArchivePath(value),/unsafe/);
  const app=await startTestApp();t.after(()=>app.close());
  const conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'};
  await assert.rejects(uploadArchive(conn,{root:os.tmpdir(),files:['writer-token.txt']}),/secret_requires/);
  const row=await app.store.createReport('demo-project',{kind:'workspace-archive',payload:{schema:'studio-archive/v1'}},'test');
  await assert.rejects(getArchive(conn,row.report.id),/incomplete/);
});

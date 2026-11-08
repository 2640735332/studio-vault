import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestApp, TOKEN_A, TOKEN_B } from '../../../../vault/test/helpers.mjs';
import { importFrames, readPackage, frameSummary, publishPackage, downloadRun, listRuns, getRun, compareRuns, canonical, sha256, reportId, publishRegression, publishIntegration } from '../../src/performance.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-perf-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'raw.json');
  fs.writeFileSync(source,JSON.stringify({post_draw_ms:[...Array(198).fill(5),10,100],frame_ms:[8,8,8]}));
  const out=path.join(root,'bundle');
  const packet=importFrames(source,out,{project:'demo-project',case_id:'PF-test',testbed:'machine',profile:'4k',input_hash:'a'.repeat(64),engine_hash:'b'.repeat(64),config_hash:'c'.repeat(64)});
  return {root,out,packet};
}
test('true slowest one percent differs from reciprocal p99; originals and streams stay separate',t=>{
  const {packet}=fixture(t),m=packet.manifest;
  assert.equal(m.stream,'post_draw_ms');assert.equal(m.metrics.frames,200);
  assert.equal(m.metrics.p99_reciprocal_fps,200);
  assert.equal(m.metrics.one_pct_low_fps,1000/55);
  assert.throws(()=>frameSummary([0,5]),/invalid_frame_stream/);
  assert.throws(()=>frameSummary([NaN]),/invalid_frame_stream/);
  assert.throws(()=>canonical({n:Infinity}),/nonfinite_number/);
});
test('hash corruption, path traversal, secret metadata and self-certified trust are rejected',t=>{
  const {out,packet}=fixture(t),file=path.join(out,'manifest.json');
  const change=(fn)=>{const m=structuredClone(packet.manifest);fn(m);fs.writeFileSync(file,JSON.stringify(m));};
  for(const unsafe of ['../raw.json','CON.json','folder/name.','folder/name ']){change(m=>m.files[0].path=unsafe);assert.throws(()=>readPackage(out),/unsafe_artifact_path/);}
  change(m=>m.trust='approved');assert.throws(()=>readPackage(out),/untrusted_baseline_claim/);
  change(m=>m.password='x');assert.throws(()=>readPackage(out),/sensitive_metadata_field/);
  fs.writeFileSync(file,JSON.stringify(packet.manifest));fs.appendFileSync(path.join(out,'frames.json'),' ');
  assert.throws(()=>readPackage(out),/artifact_hash_mismatch/);
});
test('HTTP: repeated/concurrent publish creates one immutable run, independent receipt and verified download',async t=>{
  const app=await startTestApp();t.after(()=>app.close());
  const {out,root,packet}=fixture(t),conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'};
  const attempts=await Promise.all([publishPackage(out,conn),publishPackage(out,conn)]);
  assert.equal(attempts[0].report_id,attempts[1].report_id);
  const again=await publishPackage(out,conn);assert.equal(again.state,'complete');
  const page=await listRuns(conn);assert.equal(page.total,1);
  const detail=await getRun(conn,again.report_id);assert.equal(detail.state,'complete');
  const dest=path.join(root,'download');await downloadRun(conn,again.report_id,dest);
  assert.equal(sha256(fs.readFileSync(path.join(dest,'frames.json'))),packet.manifest.files[0].sha256);
  assert.equal(readPackage(dest).manifest_hash,packet.manifest_hash);
  await assert.rejects(getRun({...conn,token:TOKEN_B},again.report_id),/vault_http_403/);
  await assert.rejects(publishPackage(out,{...conn,token:'invalid'}),/vault_http_401/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'sync.json'))).state,'pending');
});
test('HTTP: interrupted registration stays partial; identity collision cannot replace manifest or bytes',async t=>{
  const app=await startTestApp();t.after(()=>app.close());
  const {out,packet}=fixture(t),conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'},id=reportId('demo-project','run:'+packet.manifest.run_id);
  const created=await app.request('POST','/api/v1/reports',{token:TOKEN_A,headers:{'If-None-Match':'*'},body:{id,kind:'performance-run',payload:packet.manifest}});
  assert.equal(created.status,201);assert.equal((await getRun(conn,id)).state,'partial');
  const wrong=await fetch(app.baseUrl+'/api/v1/reports/'+id+'/files?path=frames.json',{method:'PUT',headers:{Authorization:'Bearer '+TOKEN_A},body:'wrong'});
  assert.equal(wrong.status,409);
  const dup=await app.request('POST','/api/v1/reports',{token:TOKEN_A,headers:{'If-None-Match':'*'},body:{id,kind:'performance-run',payload:{...packet.manifest,case_id:'changed'}}});
  assert.equal(dup.status,409);
  await publishPackage(out,conn);assert.equal((await getRun(conn,id)).state,'complete');
  const changed=structuredClone(packet.manifest);changed.commit='abcdef0';fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(changed));
  await assert.rejects(publishPackage(out,conn),/run_identity_conflict/);
});
test('comparisons refuse mixed inputs and never promote single observations',t=>{
  const {packet}=fixture(t),base=packet.manifest,candidate=structuredClone(base);candidate.run_id=randomUUID();candidate.metrics.mean_ms*=1.5;
  let result=compareRuns(base,candidate);assert.equal(result.comparable,true);assert.equal(result.classification,'observation_only');assert.equal(result.baseline_eligible,false);
  candidate.engine_hash='unknown';result=compareRuns(base,candidate);assert.equal(result.comparable,false);assert.deepEqual(result.mismatches,['engine_hash']);
});
test('automatic issues reject untrusted verdicts; a complete trusted repeated comparison deduplicates three retries',async t=>{
  const app=await startTestApp();t.after(()=>app.close());
  const {root,packet}=fixture(t),conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'};
  await assert.rejects(publishRegression(conn,randomUUID()),/automatic_issue_disabled/);
  const ids=[];
  for(let i=0;i<13;i++){
    const dir=path.join(root,'proof-'+i);fs.mkdirSync(dir);fs.copyFileSync(path.join(root,'bundle','frames.json'),path.join(dir,'frames.json'));
    const commit=i>=8?'c'.repeat(40):[0,3].includes(i%4)?'a'.repeat(40):'b'.repeat(40);
    const m={...packet.manifest,run_id:randomUUID(),source:'ci',mode:'controlled',clean:true,commit,qualification:{status:'valid',reasons:[]}};
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));ids.push((await publishPackage(dir,conn)).report_id);
  }
  const author=(await getRun(conn,ids[0])).author;
  const id=randomUUID(),proof={schema:'s3-perf-comparison/v1',classification:'confirmed_regression',provider:'conbench',independent_confirmation:true,last_good_compared:true,comparison_url:'https://bench.example.test/compare/abc',source_track:'track-001-demo',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),last_good_commit:'c'.repeat(40),first_bad_commit:'b'.repeat(40),sample_report_ids:ids.slice(0,8),control_report_ids:ids.slice(8)};
  assert.equal((await app.request('POST','/api/v1/reports',{token:TOKEN_A,body:{id,kind:'performance-comparison',payload:proof}})).status,201);
  const options={enabled:true,trustedAuthors:[author],conbenchUrl:'https://bench.example.test'};
  await assert.rejects(publishRegression(conn,id,{...options,trustedAuthors:['somebody_else']}),/untrusted_comparison/);
  const results=[];for(let i=0;i<3;i++)results.push(await publishRegression(conn,id,options));
  assert.equal(new Set(results.map(r=>r.bug_id)).size,1);
  const bugs=await app.request('GET','/api/v1/bugs',{token:TOKEN_A});assert.equal(bugs.json.total,1);
  const links=await app.request('GET','/api/v1/links?bug_id='+results[0].bug_id,{token:TOKEN_A});assert.equal(links.json.total,14);
});

test('integration records preserve NOT_RUN and deduplicate without certifying gameplay',async t=>{
  const app=await startTestApp();t.after(()=>app.close());const {root}=fixture(t),file=path.join(root,'integration.json');
  const record={schema:'s3-perf-integration/v1',run_id:randomUUID(),mode:'observe',source_sha:'a'.repeat(40),perf_sha:'a'.repeat(40),candidate_sha:null,auto_publish:false,auto_issue:false,product_gate:'NOT_RUN',capture:'NOT_RUN',job:'canary'};
  fs.writeFileSync(file,JSON.stringify(record));const conn={base:app.baseUrl,token:TOKEN_A,project:'demo-project'};
  const a=await publishIntegration(file,conn),b=await publishIntegration(file,conn);assert.equal(a.report_id,b.report_id);assert.equal(a.gameplay_pass,false);
  const stored=await app.request('GET','/api/v1/reports/'+a.report_id,{token:TOKEN_A});assert.equal(stored.json.report.payload.capture,'NOT_RUN');
  fs.writeFileSync(file,JSON.stringify({...record,auto_publish:true}));await assert.rejects(publishIntegration(file,conn),/integration_cannot_grant_automation/);
});

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadConfig } from '../config.js';
import { connection, listRuns, getRun, compareRuns, vaultRequest, safePath, sha256, PREVIEW_LIMIT, pendingPackages } from '../performance.js';

function localJson(root, file) {
  try { const p=path.join(root,file);if(fs.statSync(p).size>1024*1024)return null;return JSON.parse(fs.readFileSync(p,'utf8')); }catch{return null;}
}
export async function handlePerformanceRequest(req,res,url,{root=process.cwd(),env=process.env}={}) {
  if (!url.pathname.startsWith('/api/performance/')) return false;
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method!=='GET'){send(405,{ok:false,error:'read_only_performance_api'});return true;}
  const loaded=loadConfig({cwd:root,env}),conn=connection(loaded.config || {},env);
  try {
    const suffix=url.pathname.slice('/api/performance/'.length),parts=suffix.split('/');
    if(suffix==='catalog'){
      send(200,{ok:true,catalog:localJson(root,'tools/test/perf/lifecycle/cases.json'),pending:pendingPackages(path.join(root,'game','.mcp','performance','outbox')),import_command:'studio perf import --source <frames.json[.gz]> --meta <metadata.json> --out <new bundle>'});return true;
    }
    if(suffix==='status'){
      const ci=localJson(root,'tools/test/perf/lifecycle/ci.json');
      let health=null;try{const h=await vaultRequest(conn,'/api/v1/health');health={status:h.status,driver:h.storage?.driver,durable:h.storage?.durable};}catch{/* configured is not a connectivity claim */}
      let integrations=[],integrationError=null;try{const r=await vaultRequest(conn,'/api/v1/reports?kind=performance-integration&limit=5');integrations=(r.items || []).map(x=>({report_id:x.id,author:x.author,...x.payload}));}catch(e){integrationError=e.code || 'unavailable';}
      send(200,{ok:true,project:conn.project,preview:env.STUDIO_PERF_PREVIEW==='1',vault_health:health,vault_credentials_configured:!!conn.token,ci,recent_integrations:integrations,integration_error:integrationError,conbench:{state:'not_connected',reason:'No verified service connection is recorded in this initial release.'},baseline_approval:'disabled',auto_publish:false,auto_issue:false});return true;
    }
    if(suffix==='runs'){
      const n=(key,fallback,max)=>{const x=Number(url.searchParams.get(key) ?? fallback);return Number.isSafeInteger(x)&&x>=0?Math.min(x,max):fallback;};
      send(200,{ok:true,...await listRuns(conn,{limit:n('limit',50,500)||50,offset:n('offset',0,1000000)})});return true;
    }
    if(suffix==='compare'){
      const [a,b]=await Promise.all([getRun(conn,url.searchParams.get('base')),getRun(conn,url.searchParams.get('candidate'))]);
      send(200,{ok:true,base:a,candidate:b,comparison:compareRuns(a.manifest,b.manifest)});return true;
    }
    if(parts[0]==='runs' && parts[1]){
      const run=await getRun(conn,parts[1]);
      if(parts.length===2){send(200,{ok:true,...run});return true;}
      if(parts.length===3 && parts[2]==='file'){
        const rel=safePath(url.searchParams.get('path'));
        const file=run.manifest.files.find(f=>f.path===rel);
        if(!file){send(404,{ok:false,error:'artifact_not_in_manifest'});return true;}
        if(file.size>PREVIEW_LIMIT && url.searchParams.get('preview')==='1'){send(413,{ok:false,error:'preview_too_large',download:true});return true;}
        const bytes=await vaultRequest(conn,'/api/v1/reports/'+parts[1]+'/file?path='+encodeURIComponent(rel),{binary:true});
        if(bytes.length!==file.size || sha256(bytes)!==file.sha256){send(409,{ok:false,error:'artifact_hash_mismatch'});return true;}
        if(url.searchParams.get('preview')==='1'){
          try {
            const decoded=rel.endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:PREVIEW_LIMIT}):bytes;
            if(decoded.length>PREVIEW_LIMIT)throw new Error('preview_too_large');
            if(/\.json(?:\.gz)?$/.test(rel)){send(200,{ok:true,format:'json',sha256:file.sha256,data:JSON.parse(decoded.toString('utf8'))});return true;}
            if(/\.(log|txt|csv|md)$/.test(rel)){send(200,{ok:true,format:'text',sha256:file.sha256,text:decoded.toString('utf8')});return true;}
          }catch{send(422,{ok:false,error:'preview_decode_failed',download:true});return true;}
          send(200,{ok:true,format:'unsupported',sha256:file.sha256,viewer:rel.endsWith('.rdc')?'RenderDoc':rel.endsWith('.nsys-rep')?'Nsight Systems':rel.endsWith('.etl')?'WPA':'Native tool'});return true;
        }
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+path.basename(rel).replace(/[^a-zA-Z0-9_.-]/g,'_')+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':file.sha256});res.end(bytes);return true;
      }
    }
    send(404,{ok:false,error:'unknown_performance_route'});
  }catch(e){send(e.status || 503,{ok:false,error:e.code || 'performance_unavailable'});}
  return true;
}

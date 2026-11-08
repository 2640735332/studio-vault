#!/usr/bin/env node
/** Local-only, non-durable preview of explicitly selected existing frame captures. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { loadConfig } from '../packages/studio/src/config.js';
import { importFrames, readPackage, publishPackage, sha256 } from '../packages/studio/src/performance.js';
import { loadConfig as vaultConfig } from '../vault/src/lib/config.mjs';
import { newSecret, newTokenId, formatToken, sha256Hex } from '../vault/src/lib/ids.mjs';
import { openStore } from '../vault/src/store/index.mjs';
import { createApp } from '../vault/src/app.mjs';

const args=process.argv.slice(2),get=(key)=>args[args.indexOf(key)+1];
if(!args.includes('--root'))throw new Error('Usage: performance-preview.mjs --root <Studio project> [--port 3488] [--capture <existing frames.json[.gz]> ...]');
const root=path.resolve(get('--root')),loaded=loadConfig({cwd:root});
if(!loaded.ok)throw new Error('Studio project config required');
const port=Number(args.includes('--port')?get('--port'):3488);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local preview port');
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
const captures=[];for(let i=0;i<args.length;i++)if(args[i]==='--capture')captures.push(path.resolve(args[++i]));
for(const file of captures)if(!fs.statSync(file).isFile())throw new Error('Capture is not a file');
const dataDir=path.join(root,'game','.mcp','performance','preview-vault');
const cfg=vaultConfig({VAULT_DB:'memory',VAULT_PORT:'0',VAULT_BIND:'127.0.0.1',VAULT_DEV_SEED:'0',VAULT_DATA_DIR:dataDir,VAULT_LOG_LEVEL:'error'});
const logger={info(){},warn(){},error(){},debug(){},child(){return this;}};
const store=await openStore(cfg,{logger});
await store.ensureProject(loaded.paths.projectId,loaded.paths.projectId);
const id=newTokenId(),secret=newSecret();
await store.createToken({id,label:'local-performance-preview',tokenHash:sha256Hex(secret),projects:[loaded.paths.projectId],role:'writer'});
const app=createApp({config:cfg,store,logger});await app.listen();
const conn={base:'http://127.0.0.1:'+app.server.address().port,token:formatToken(id,secret),project:loaded.paths.projectId};
try{
  for(const capture of captures){
    const hash=sha256(fs.readFileSync(capture));
    const bundle=path.join(root,'game','.mcp','performance','outbox','historical-'+hash.slice(0,16));
    if(!fs.existsSync(bundle))importFrames(capture,bundle,{project:conn.project,repository:loaded.config.project?.repository || 'unknown',source:'historical',case_id:'historical-'+path.basename(path.dirname(capture)),testbed:'historical-unknown',profile:'historical-production-observation'});
    readPackage(bundle);const receipt=await publishPackage(bundle,conn);console.log('Imported observation '+receipt.run_id);
  }
  process.chdir(root);
  process.env.VAULT_URL=conn.base;process.env.STUDIO_PERF_TOKEN=conn.token;
  process.env.SPECVIEWER_PORT=String(port);process.env.SPECVIEWER_BIND='127.0.0.1';process.env.SPECVIEWER_READONLY='1';process.env.STUDIO_PERF_PREVIEW='1';
  const {startServer}=await import('../packages/studio/src/serve/server.js');startServer();
  console.log('NON-DURABLE isolated preview: http://127.0.0.1:'+port+'/#/performance');
}catch(e){await app.close();await store.close();throw e;}

import fs from 'node:fs';
import path from 'node:path';
import { connection, importFrames, readPackage, publishPackage, listRuns, getRun, downloadRun, compareRuns, pendingPackages, publishRegression, publishIntegration } from '../performance.js';

export const name='perf';
export const summary='性能证据：导入、离线队列、上传、查询、对比、SHA校验下载';
export const usage='studio perf import --source <frames.json[.gz]> --meta <metadata.json> --out <bundle> | validate|publish --source <bundle> | pending | list [--offset N] | show|download --id <report UUID> [--out <new dir>] | compare --base <UUID> --id <UUID> [--json]';
export async function run({paths,config,args,env}) {
  const sub=args._[0] || 'pending', conn=connection(config,env), root=paths.repoRoot;
  const source=args.source ? path.resolve(root,String(args.source)) : null;
  const out=args.out ? path.resolve(root,String(args.out)) : null;
  const required=(value,key)=>{if(!value)throw new Error('missing --'+key);return value;};
  let result;
  if(sub==='import') {
    const meta=JSON.parse(fs.readFileSync(path.resolve(root,required(args.meta,'meta')),'utf8'));
    if(meta.project && meta.project!==paths.projectId)throw new Error('project_mismatch');
    result=importFrames(required(source,'source'),required(out,'out'),{...meta,project:paths.projectId});
    result={run_id:result.manifest.run_id,manifest:result.manifest,state:'local',directory:out};
  } else if(sub==='validate') result={...readPackage(required(source,'source')),state:'verified_local'};
  else if(sub==='publish') result=await publishPackage(required(source,'source'),conn);
  else if(sub==='integration') result=await publishIntegration(required(source,'source'),conn);
  else if(sub==='pending') result={items:pendingPackages(source || path.join(root,'game','.mcp','performance','outbox'))};
  else if(sub==='list') result=await listRuns(conn,{limit:Number(args.limit || 50),offset:Number(args.offset || 0)});
  else if(sub==='show') result=await getRun(conn,required(args.id,'id'));
  else if(sub==='download') result=await downloadRun(conn,required(args.id,'id'),required(out,'out'));
  else if(sub==='issue') result=await publishRegression(conn,required(args.id,'id'),{enabled:env.PERF_AUTO_ISSUE==='1',trustedAuthors:(env.STUDIO_PERF_CI_AUTHORS || '').split(',').map(x=>x.trim()).filter(Boolean),conbenchUrl:env.CONBENCH_URL || ''});
  else if(sub==='compare') {const [a,b]=await Promise.all([getRun(conn,required(args.base,'base')),getRun(conn,required(args.id,'id'))]);result=compareRuns(a.manifest,b.manifest);}
  else throw new Error('unknown_perf_command');
  return {exitCode:0,report:{command:'perf '+sub,ok:true,...result},text:JSON.stringify(result,null,2)};
}

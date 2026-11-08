import fs from 'node:fs';
import path from 'node:path';
import { connection } from '../performance.js';
import { uploadArchive, listArchives, getArchive, searchArchives, downloadArchive, repairArchive } from '../archive.js';

export const summary='Vault permanent archives: upload, list, search and verified download';
export const usage='studio archive upload --source <selection.json> [--id UUID] | list | search --query <text> [--id UUID] | show --id UUID | download --id UUID --out <new directory> [--file <relative path>] | repair --id UUID --source <saved-manifest.json> --root <original files>';
export async function run({paths,config,args,env}) {
  const conn=connection(config,env), sub=args._[0], required=key=>{if(!args[key])throw new Error('missing --'+key);return String(args[key]);};
  let result;
  if(sub==='upload') result=await uploadArchive(conn,JSON.parse(fs.readFileSync(path.resolve(paths.repoRoot,required('source')),'utf8')),{id:args.id,progress:p=>console.error('[archive] '+JSON.stringify(p))});
  else if(sub==='list') result={items:await listArchives(conn)};
  else if(sub==='show') {const a=await getArchive(conn,required('id'));result={...a.seal,source:a.manifest.source,metadata:a.manifest.metadata};}
  else if(sub==='search') result={items:await searchArchives(conn,required('query'),{id:args.id,limit:Number(args.limit || 100)})};
  else if(sub==='download') result=await downloadArchive(conn,required('id'),path.resolve(paths.repoRoot,required('out')),{file:args.file});
  else if(sub==='repair') result=await repairArchive(conn,required('id'),JSON.parse(fs.readFileSync(path.resolve(paths.repoRoot,required('source')),'utf8')),path.resolve(paths.repoRoot,required('root')),{progress:p=>console.error('[archive] '+JSON.stringify(p))});
  else throw new Error('unknown_archive_command');
  return {exitCode:0,report:{command:'archive '+sub,ok:true,...result},text:JSON.stringify(result,null,2)};
}

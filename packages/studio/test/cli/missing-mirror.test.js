import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeMissing } from '../../src/mirror.js';

test('missing-only mirror bootstrap preserves authored edits and skips LFS placeholders',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-mirror-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sharedRoot=path.join(root,'shared'),mirrorRoot=path.join(root,'game','docs','briefs'),mirrorRel='docs/briefs';
  fs.mkdirSync(path.join(sharedRoot,mirrorRel),{recursive:true});fs.mkdirSync(mirrorRoot,{recursive:true});
  execFileSync('git',['init',sharedRoot],{stdio:'ignore'});
  for(const [name,text] of [['preview.html','canonical'],['BRIEF.md','canonical'],['image.png','version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'.repeat(64)+'\nsize 123\n']])fs.writeFileSync(path.join(sharedRoot,mirrorRel,name),text);
  execFileSync('git',['-C',sharedRoot,'add','.']);execFileSync('git',['-C',sharedRoot,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],{stdio:'ignore'});
  fs.writeFileSync(path.join(mirrorRoot,'BRIEF.md'),'uncommitted authored edit');
  const paths={sharedRoot,mirrorRoot,mirrorRel},planned=materializeMissing(paths,{dryRun:true});
  assert.deepEqual(planned.copied,['preview.html']);assert.equal(fs.existsSync(path.join(mirrorRoot,'preview.html')),false);
  const result=materializeMissing(paths);assert.equal(result.ok,true);assert.equal(result.complete_mirror,false);
  assert.deepEqual(result.lfs_pending,['image.png']);assert.equal(fs.readFileSync(path.join(mirrorRoot,'BRIEF.md'),'utf8'),'uncommitted authored edit');
  assert.equal(fs.readFileSync(path.join(mirrorRoot,'preview.html'),'utf8'),'canonical');assert.equal(fs.existsSync(path.join(mirrorRoot,'image.png')),false);
  assert.equal(materializeMissing(paths).copied.length,0);
});

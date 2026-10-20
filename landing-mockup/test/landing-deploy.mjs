import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);

export async function checkLandingDeploy({directory}){
  const fixture=await mkdtemp(join(directory,'landing-deploy-'));let server;
  try{
    const repo=join(fixture,'repo'),root=join(fixture,'public');await mkdir(join(repo,'landing-mockup/deploy'),{recursive:true});await mkdir(root);
    const script=new URL('../deploy/publish.sh',import.meta.url);await writeFile(join(repo,'landing-mockup/deploy/publish.sh'),await readFile(script));await chmod(join(repo,'landing-mockup/deploy/publish.sh'),0o755);
    const sourceScript=[
      "import {mkdir,writeFile,readFile} from 'node:fs/promises';",
      "import {resolve} from 'node:path';",
      "if(process.argv[2]!=='--landing'||!process.argv[3])process.exit(2);",
      "const out=resolve(process.argv[3]);await mkdir(out);",
      "const version=(await readFile('version','utf8')).trim();",
      "await writeFile(resolve(out,'index.html'),'<!doctype html><title>version-'+version+'</title>');",
      "await writeFile(resolve(out,'404.html'),'<!doctype html>missing');",
      "await writeFile(resolve(out,'503.html'),'<!doctype html>unavailable');"
    ].join('\n');
    await writeFile(join(repo,'landing-mockup/package.mjs'),sourceScript);await writeFile(join(repo,'version'),'one');
    await exec('git',['init','-q'],{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}});
    const git=async(...args)=>exec('git',args,{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}});
    await git('add','.');await git('commit','-qm','fixture one');await git('tag','deploy-20261018-1');
    let corrupt=false;
    server=http.createServer(async(req,res)=>{const current=join(root,'current'),path=new URL(req.url,'http://fixture').pathname;const file=path==='/'?'index.html':path==='/503.html'?'503.html':'404.html';const status=path==='/'?200:path==='/503.html'?503:404;try{const original=await readFile(join(current,file));const data=corrupt&&path==='/'&&original.toString().includes('version-two')?Buffer.from('different'):original;res.writeHead(status).end(data);}catch{res.writeHead(404).end();}});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));const probe=`http://127.0.0.1:${server.address().port}`;
    const caller=join(fixture,'caller with spaces');await mkdir(caller);
    const shim=join(fixture,'shim');await mkdir(shim);const scanLog=join(fixture,'find-pwd');
    const realFind=(await exec('sh',['-c','command -v find'])).stdout.trim();
    await writeFile(join(shim,'find'),`#!/bin/sh\npwd -P > "$FIND_PWD_LOG"\n[ "${'${'}FAIL_FIND:-0}" = 1 ] && exit 1\nexec "${'${'}REAL_FIND}" "$@"\n`);await chmod(join(shim,'find'),0o755);
    const invoke=async(tag,extra={})=>exec('sh',[join(repo,'landing-mockup/deploy/publish.sh'),tag],{cwd:caller,env:{...process.env,HODOS_LANDING_ROOT:root,HODOS_LANDING_PROBE:probe,FIND_PWD_LOG:scanLog,REAL_FIND:realFind,PATH:`${shim}:${process.env.PATH}`,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',...extra}});
    await invoke('deploy-20261018-1');const first=await readlink(join(root,'current'));assert.match(first,/^releases\/deploy-20261018-1-/);assert.match(await readFile(join(root,'current/index.html'),'utf8'),/version-one/);
    const regressions=[];
    if((await readFile(scanLog,'utf8')).trim()!==repo)regressions.push('scan cwd is not computed repo');
    const oldBytes=await readFile(join(root,first,'index.html'));
    const scanFailure=await invoke('deploy-20261018-1',{FAIL_FIND:'1'}).then(()=>null,error=>error);
    if(!scanFailure)regressions.push('empty-output find failure did not stop publication');
    if(await readlink(join(root,'current'))!==first||!(await readFile(join(root,first,'index.html'))).equals(oldBytes))regressions.push('failed scan changed current or old release bytes');
    assert.deepEqual(regressions,[],`publisher scan regressions: ${regressions.join('; ')}`);
    await writeFile(join(repo,'version'),'two');await git('add','version');await git('commit','-qm','fixture two');await git('tag','deploy-20261018-2');corrupt=true;
    const failed=await invoke('deploy-20261018-2').then(()=>{throw new Error('Expected failed publication');},error=>error);assert.match(failed.stderr,/Restored releases\//);assert.doesNotMatch(failed.stderr,/Rollback health check FAILED/);assert.equal(await readlink(join(root,'current')),first);assert.match(await readFile(join(root,'current/index.html'),'utf8'),/version-one/);
    assert.equal(await readFile(join(root,'current/404.html'),'utf8'),'<!doctype html>missing');
    return 'PASS disposable publisher success and verified rollback control flow (fixture is not Caddy validation)';
  }finally{if(server)await new Promise(done=>server.close(done));await rm(fixture,{recursive:true,force:true});}
}

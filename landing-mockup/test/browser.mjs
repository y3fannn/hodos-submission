// Existing combined actual-browser journey; full-site and approved reference share guards.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createPreviewServer} from '../serve.mjs';
import {startChrome} from '../../webapp/test/browser-kit.mjs';
import {checkFullSite} from './full-site.mjs';
import {checkScrollPreview} from './scroll-preview.mjs';
import {previewFiles} from '../package.mjs';
const started=new Date().toISOString(),results=[];
const server=createPreviewServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,evidence=new URL('../evidence/',import.meta.url);
await fs.mkdir(evidence,{recursive:true});let browser;
try {
  const response=await fetch(origin);assert.equal(response.status,200);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const path of ['/serve.mjs','/package.mjs','/test/browser.mjs','/api/auth/status','/.env','/evidence/desktop.png'])assert.equal((await fetch(origin+path)).status,404,path);
  for(const file of previewFiles)assert.equal((await fetch(origin+'/'+file)).status,200,'Allowlisted asset '+file);
  assert.equal((await fetch(origin,{method:'POST'})).status,405);assert.equal((await fetch(origin,{method:'HEAD'})).status,200);
  results.push('PASS static allowlist, strict resource policy, no API/source/env/evidence/POST exposure');
  browser=await startChrome({width:1440,height:1000});const{cmd,js,waitFor}=browser;
  const shot=async name=>{await waitFor(`document.getAnimations().every(a=>a.playState!=='running')`);const r=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(new URL(name+'.png',evidence),Buffer.from(r.result.data,'base64'));};
  results.push(await checkFullSite({cmd,js,waitFor,baseUrl:origin+'/',shot}));
  results.push(await checkScrollPreview({cmd,js,waitFor,baseUrl:origin+'/',shot}));
  assert.deepEqual(browser.problems(),[]);
  results.push('Start '+started+'; end '+new Date().toISOString());console.log(results.join('\n'));await fs.writeFile(new URL('checks.txt',evidence),results.join('\n')+'\n');
}finally{browser?.close();await new Promise(done=>server.close(done));}

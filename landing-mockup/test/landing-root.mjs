import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleLanding, landingFiles } from '../package.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
async function list(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isDirectory())result.push(...(await list(join(directory,entry.name))).map(file=>`${entry.name}/${file}`));else result.push(entry.name);}return result.sort();}
const mime={html:'text/html',css:'text/css',js:'application/javascript',svg:'image/svg+xml',png:'image/png',txt:'text/plain',xml:'application/xml'};

export async function checkLandingRoot({browser,directory}){
  const root=join(directory,'landing-root'); await assembleLanding(root);
  const files=await list(root); assert.equal(files.length,49); assert.deepEqual(files,[...landingFiles].sort());
  await assert.rejects(assembleLanding(root));
  await assert.rejects(assembleLanding(join(source,'unsafe')));
  await assert.rejects(assembleLanding(join(fileURLToPath(new URL('../../webapp/public/',import.meta.url)),'unsafe')));
  const sourceLink=join(directory,'source-parent-link'); await symlink(source,sourceLink,'dir'); await assert.rejects(assembleLanding(join(sourceLink,'unsafe')));
  const original=await readFile(join(source,'index.html')), built=await readFile(join(root,'index.html'));
  const expected=Buffer.from(original.toString().replace('<meta name="robots" content="noindex,nofollow">','<meta name="robots" content="index,follow">').replace('</head>','<link rel="canonical" href="https://hodos.consulting/"></head>'));
  assert.deepEqual(built,expected); assert.match(original.toString(),/<meta name="robots" content="noindex,nofollow">/);
  for(const file of files)if(file!=='index.html')assert.deepEqual(await readFile(join(root,file)),await readFile(join(source,file)),`Exact public copy ${file}`);
  const sitemap=(await readFile(join(root,'sitemap.xml'),'utf8')).match(/<loc>(.*?)<\/loc>/g)||[];assert.deepEqual(sitemap,['<loc>https://hodos.consulting/</loc>']);
  assert.match(await readFile(join(root,'robots.txt'),'utf8'),/Sitemap: https:\/\/hodos\.consulting\/sitemap\.xml/);
  for(const [file,title,body] of [['404.html','This page couldn’t be found','Check the address or return home'],['503.html','We’ll be back soon','Please try again shortly']]){const html=await readFile(join(root,file),'utf8');assert.match(html,/<meta name="robots" content="noindex,nofollow">/);assert.doesNotMatch(html,/<script\b/i);for(const text of [title,body,'href="/"','href="https://app.hodos.consulting/"','href="\/styles.css"','href="\/errors.css"','src="\/assets\/hodos.svg"'])assert.ok(html.includes(text),`${file}: ${text}`);}
  let server; const evidence=join(source,'evidence');await mkdir(evidence,{recursive:true});
  try{
    server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://fixture').pathname;let file=path==='/'?'index.html':path.slice(1);let status=200;if(path==='/404.html'){file='404.html';status=404;}else if(path==='/503.html'){file='503.html';status=503;}else if(path==='/_render/404.html')file='404.html';else if(path==='/_render/503.html')file='503.html';if(!landingFiles.includes(file)){file='404.html';status=404;}try{res.writeHead(status,{'Content-Type':mime[extname(file).slice(1)]||'application/octet-stream','X-Content-Type-Options':'nosniff',"Content-Security-Policy":"default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}).end(await readFile(join(root,file)));}catch{res.writeHead(404).end();}});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
    for(const [path,status,file] of [['/404.html',404,'404.html'],['/503.html',503,'503.html'],['/deep/missing',404,'404.html']]){const response=await fetch(base+path);assert.equal(response.status,status);assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(join(root,file)));}
    const {cmd,js,waitFor,problems}=browser;const navigate=async(path,title)=>{await cmd('Page.navigate',{url:base+path});await waitFor(`document.readyState==='complete' && location.pathname===${JSON.stringify(path)} && document.title===${JSON.stringify(title)}`);await js(`[...document.images].forEach(i=>i.loading='eager')`);await waitFor(`[...document.images].every(i=>i.complete&&i.naturalWidth>0)`);};
    await navigate('/','Hodos — One Assistant for every dollar');assert.match(await js(`document.querySelector('h1').textContent`),/One Assistant/);assert.ok((await js(`[...document.querySelectorAll('a')].some(a=>a.href==='https://app.hodos.consulting/#/signup')`)));
    for(const [path,title,width,shotName] of [['/_render/404.html','Page not found — Hodos',390,'launch-404-mobile.png'],['/_render/503.html','Temporarily unavailable — Hodos',1440,'launch-503-desktop.png']]){await cmd('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});await navigate(path,title);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);assert.equal(await js(`{const a=document.querySelector('.error-actions a');getComputedStyle(a).fontSize==='16px'||parseFloat(getComputedStyle(a).fontSize)>=16}`),true);assert.equal(await js(`{const a=document.querySelector('.error-actions a');a.getBoundingClientRect().height>=44}`),true);await js(`document.querySelector('.error-actions a').focus()`);assert.equal(await js(`document.activeElement===document.querySelector('.error-actions a')`),true);const image=await cmd('Page.captureScreenshot',{format:'png'});await import('node:fs/promises').then(fs=>fs.writeFile(join(evidence,shotName),Buffer.from(image.result.data,'base64')));}
    assert.deepEqual(problems(),[]);return 'PASS landing-root bundle and browser render; fixture statuses are not Caddy validation';
  }finally{if(server)await new Promise(done=>server.close(done));}
}

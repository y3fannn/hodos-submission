// Package integrity + real project/subfolder browser check; optional anonymous public-preview verification.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemblePages, previewFiles } from '../package.mjs';
import { startChrome } from '../../webapp/test/browser-kit.mjs';
import { checkScrollPreview } from './scroll-preview.mjs';
import { checkFullSite } from './full-site.mjs';
import { checkLandingRoot } from './landing-root.mjs';
import { checkLandingDeploy } from './landing-deploy.mjs';

const previewSource = fileURLToPath(new URL('../', import.meta.url));
const appSource = fileURLToPath(new URL('../../webapp/public/', import.meta.url));
const prefix = '/personal-finance-ai-agent/';
const directory = await mkdtemp(join(tmpdir(), 'hodos-pages-'));
let server, browser;
async function list(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...(await list(join(directory, entry.name))).map(file => entry.name + '/' + file));
    else result.push(entry.name);
  }
  return result.sort();
}
try {
  const output = await assemblePages(join(directory, 'site'));
  const originalFiles = await list(appSource);
  for (const file of originalFiles) assert.deepEqual(await readFile(join(output, file)), await readFile(join(appSource, file)), `Existing app file unchanged: ${file}`);
  assert.deepEqual(await list(join(output, 'hodos-preview')), [...previewFiles].sort());
  for (const file of previewFiles) assert.deepEqual(await readFile(join(output, 'hodos-preview', file)), await readFile(join(previewSource, file)));
  await assert.rejects(assemblePages(output), /EEXIST/);
  await assert.rejects(assemblePages(join(appSource, 'unsafe')), /outside/);
  await assert.rejects(assemblePages(join(previewSource, 'unsafe')), /outside/);
  console.log(`PASS artifact: ${originalFiles.length} app files byte-identical; exactly ${previewFiles.length} preview files; existing/source output refused`);

  let url;
  if (process.argv[2] === '--url') {
    url = new URL(process.argv[3]);
    assert.equal(url.href, 'https://lyd-sg.github.io/personal-finance-ai-agent/hodos-preview/');
  } else {
    const allowed = new Map();
    for (const file of await list(output)) allowed.set(prefix + file, join(output, file));
    allowed.set(prefix + 'hodos-preview/', join(output, 'hodos-preview/index.html'));
    server = http.createServer(async (request, response) => {
      const file = allowed.get(new URL(request.url, 'http://localhost').pathname);
      if (!file) { response.writeHead(404).end(); return; }
      const extension = file.split('.').pop();
      const type = { html: 'text/html', css: 'text/css', js: 'text/javascript', png: 'image/png', svg: 'image/svg+xml' }[extension] || 'application/octet-stream';
      try { response.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }).end(await readFile(file)); }
      catch { response.writeHead(500).end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    url = new URL(`http://127.0.0.1:${server.address().port}${prefix}hodos-preview/`);
  }
  for (const file of previewFiles) {
    const response = await fetch(new URL(file, url), { cache: 'no-store' });
    assert.equal(response.status, 200, file);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(previewSource, file)), `Served exact preview source: ${file}`);
  }
  // The existing Pages application's entry/style/router must remain exactly the app source.
  for (const file of ['index.html', 'app.css', 'js/main.js']) {
    const response = await fetch(new URL('../' + file, url), { cache: 'no-store' });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(appSource, file)), `Existing hosted app unchanged: ${file}`);
  }
  console.log(`PASS HTTP: ${previewFiles.length} exact preview assets and unchanged app entry/style/router at ${url.href}`);

  browser = await startChrome({ width: 1440, height: 1000 });
  const { cmd, js, waitFor } = browser;
  console.log(await checkFullSite({cmd,js,waitFor,baseUrl:url.href}));
  assert.equal(await js(`location.pathname`), url.pathname, 'Keep actual project/subfolder navigation');
  assert.deepEqual(browser.problems(), []);
  console.log(await checkScrollPreview({cmd,js,waitFor,baseUrl:url.href}));
  assert.deepEqual(browser.problems(),[]);
  console.log(await checkLandingRoot({browser,directory}));
  assert.deepEqual(browser.problems(),[]);
  console.log(await checkLandingDeploy({directory}));
} finally {
  browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(directory, { recursive: true, force: true });
}

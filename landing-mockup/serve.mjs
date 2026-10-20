// Standalone loopback-only preview. Does not start/import the financial app or read its environment.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewFiles } from './package.mjs';

const types = {html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',svg:'image/svg+xml',png:'image/png'};
// The same explicit inventory governs local serving and publication; no directory discovery.
const files = new Map([
  ['/', ['index.html', types.html]],
  ...previewFiles.map(file => ['/'+file, [file, types[file.split('.').pop()]]])
]);

export function createPreviewServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let file;
    try { file = files.get(new URL(request.url, 'http://localhost').pathname); } catch { /* Reject malformed request paths. */ }
    if (!file) { response.writeHead(404).end('Not found'); return; }
    try {
      const bytes = await readFile(new URL(file[0], import.meta.url));
      response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(500).end('Preview asset unavailable');
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createPreviewServer();
  server.on('error', error => { console.error(`Preview could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(4173, '127.0.0.1', () => console.log('Hodos landing mockup: http://localhost:4173 (preview only; Ctrl+C to stop)'));
}

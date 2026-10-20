// Render the app's PNG icons from the SVG sources, so the two can never drift apart again — which
// is exactly what happened before: icon.svg was changed and the three PNGs kept the old colour for
// months. Run it whenever a source SVG changes:
//
//   node webapp/tools/make-icons.mjs
//
// It drives the same headless Chrome that test/screenshot.mjs uses, rather than adding an image
// library to the project for three files. CHROME=/path/to/chrome to override.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// The home-screen icons all come from the maskable source: it bleeds to the edges and keeps its
// content inside the safe circle, which is what a launcher's own mask expects.
const JOBS = [
  { src: "icon-maskable.svg", size: 192, out: "icon-192.png" },
  { src: "icon-maskable.svg", size: 512, out: "icon-512.png" },
  { src: "icon-maskable.svg", size: 180, out: "apple-touch-icon.png" },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-"));
const PORT = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch {}
}
if (!target) { chrome.kill(); throw new Error("Chrome did not start. Set CHROME to its path."); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await cmd("Page.enable");
for (const job of JOBS) {
  // The SVG goes inline in the page rather than into an <img>, so the system font the glyph asks
  // for actually resolves. An <img> renders the SVG in isolation, where it would not.
  const svg = fs.readFileSync(path.join(PUBLIC, job.src), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${svg}`;
  const page = path.join(dir, "page.html");
  fs.writeFileSync(page, html);
  await cmd("Emulation.setDeviceMetricsOverride", { width: job.size, height: job.size, deviceScaleFactor: 1, mobile: false });
  await cmd("Page.navigate", { url: "file://" + page + "?v=" + Math.random() });
  await sleep(600);
  const shot = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(PUBLIC, job.out), Buffer.from(shot.result.data, "base64"));
  console.log(`${job.out.padEnd(22)} ${job.size}x${job.size}  from ${job.src}`);
}
ws.close(); chrome.kill(); process.exit(0);

// Screenshot one screen in real Chrome, in real time, and print any browser errors.
// node test/screenshot.mjs "http://localhost:8787/?demo=1#/networth" out.png [height]
// Chrome's own --screenshot flag runs on virtual time, which never waits for the vault's IndexedDB,
// and so draws a blank page. This waits for real. CHROME=/path/to/chrome to override.
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [url, out, h = "1400"] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-")); const PORT = 9400 + Math.floor(Math.random() * 500);
const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let t;
for (let i = 0; i < 60 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); } catch {} }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(), logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); if (d.method === "Log.entryAdded" && d.params.entry.level === "error") logs.push("ERROR " + d.params.entry.text); if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push("CONSOLE " + d.params.args.map((a) => a.value ?? a.description).join(" ")); };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd("Page.enable"); await cmd("Runtime.enable"); await cmd("Log.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 420, height: Number(h), deviceScaleFactor: 1, mobile: true });
await cmd("Page.navigate", { url }); await sleep(4000);
const r = await cmd("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(out, Buffer.from(r.result.data, "base64"));
console.log(logs.length ? logs.join("\n") : "no errors"); ws.close(); chrome.kill(); process.exit(0);

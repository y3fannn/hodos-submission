// Shared by the real-browser checks: a server of their own, and Chrome driven over the DevTools protocol.
// A test that starts its own server needs nothing running, and never touches the accounts on yours.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// env: extra settings for the server, e.g. { AUTH: "off" }. out() is everything it has printed.
export async function startServer(env = {}) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-data-"));
  const child = spawn(process.execPath, [path.join(here, "..", "server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: data, NODE_ENV: "test", AUTH: "on", APP_ORIGIN: "", RP_ID: "", EMAIL_MODE: "log", RESEND_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes("prototype:"); i++) await sleep(100);
  const stop = () => { try { child.kill(); } catch {} fs.rmSync(data, { recursive: true, force: true }); };
  process.on("exit", stop);
  return { url: `http://localhost:${port}/`, out: () => out, stop };
}

export async function startChrome({ width = 420, height = 1100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), `--user-data-dir=${dir}/profile`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let launchError = "";
  chrome.on("error", (e) => { launchError = e.message; });
  chrome.stderr.on("data", (d) => { launchError = (launchError + d).slice(-2000); });
  process.on("exit", () => { try { chrome.kill(); } catch {} });
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {} }
  if (!target) { chrome.kill(); throw new Error(`Chrome did not start. Set CHROME to its binary; root-only test containers may require CHROME_NO_SANDBOX=1. ${launchError}`); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome control connection timed out.')), 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Chrome control connection failed.')); };
  });
  let id = 0; const waiting = new Map(), logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    if (d.method === "Runtime.consoleAPICalled") logs.push(`${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === "Log.entryAdded") logs.push(`LOG ${d.params.entry.level}: ${d.params.entry.text}${d.params.entry.url ? ` (${d.params.entry.url})` : ""}`);
  };
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { waiting.delete(i); reject(new Error(`Chrome command timed out: ${method}`)); }, 45000);
    waiting.set(i, (reply) => { clearTimeout(timer); resolve(reply); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const js = async (expr) => { const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
  const waitFor = async (expr, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(150); }
    console.log("PAGE:", (await js(`document.body.innerText`))?.slice(0, 1500));
    throw new Error("timeout waiting for " + expr);
  };
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-shots-"));
  const shot = async (name) => { const r = await cmd("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(r.result.data, "base64")); };
  await cmd("Page.enable"); await cmd("Runtime.enable"); await cmd("Log.enable");
  await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
  // Anything the browser blocked or threw, for the end-of-test check.
  const problems = () => logs.filter((l) => /EXCEPTION|Refused|Content Security|LOG error/i.test(l));
  return { cmd, js, waitFor, shot, shots, logs, problems, close: () => { ws.close(); chrome.kill(); } };
}

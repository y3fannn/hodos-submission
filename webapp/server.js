// Prototype server. Serves the PWA, signs people in, and proxies AI calls.
// Holds the provider key. Stores no payload, no output. Keeps accounts (accounts.mjs) and, per person,
// one running AI cost a month; never content.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "./proxy-prompt.mjs";
import { SECURITY_HEADERS, HSTS } from "./security-headers.mjs";
import { json, readBody, MAX_BODY } from "./http-util.mjs";
import { openAccounts } from "./accounts.mjs";
import { createAuth } from "./auth.mjs";
import { Worker } from "node:worker_threads";
import { taskDefinition, ASSISTANT_MODEL, LIMITS, validateInput, providerSchema, decodeProviderOutput } from "./public/js/lib/assistant-tasks.js";
import { validateProtectedContext } from "./public/js/lib/assistant-privacy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TESTING = process.env.NODE_ENV === "test";
// Test processes never read adjacent development secrets, inherit real keys, or fetch off-device.
if (!TESTING) loadDotEnv(path.join(here, ".env"));
else {
  const localFetch = globalThis.fetch;
  globalThis.fetch = (request, options = {}) => {
    fixtureEndpoint(typeof request === "string" || request instanceof URL ? request : request.url);
    return localFetch(request, { ...options, redirect: "error" });
  };
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_BASE_URL ? "hodos-fixture-key" : "";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const PORT = Number(process.env.PORT || 8787);
// Behind Caddy the server listens on 127.0.0.1 only, so nothing reaches it except through Caddy,
// even if a firewall rule slips. Unset, it listens on every network, as a laptop demo needs.
const HOST = process.env.HOST || undefined;
const PUBLIC = path.join(here, "public");
// Accounts live in one file beside the server, never inside public/. AUTH=off turns sign-in and the
// AI guard off, for a demo server nobody else can reach (security note, Rollback).
const AUTH_ON = process.env.AUTH !== "off";
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
if (TESTING && AUTH_ON && !process.env.DATA_DIR) throw new Error("Fixtures require a disposable DATA_DIR.");
let auth = null;
if (AUTH_ON) { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); auth = createAuth({ accounts: openAccounts(path.join(DATA_DIR, "accounts.db")), port: PORT }); }
const MODELS = Object.freeze({ cheap: "claude-haiku-5-5", strong: "claude-opus-5-5" });
if (process.env.AI_MODEL_CHEAP || process.env.AI_MODEL_STRONG) console.warn("AI model overrides are ignored; the app pins the approved model for each role.");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function fixtureEndpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Invalid fixture endpoint."); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Fixture external traffic is blocked.");
  return url;
}

let anthropicClient = null;
let anthropicModule = null;
async function getClient() {
  if (TESTING && process.env.ANTHROPIC_BASE_URL) fixtureEndpoint(process.env.ANTHROPIC_BASE_URL);
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (anthropicClient) return anthropicClient;
  try {
    anthropicModule = await import("@anthropic-ai/sdk");
    const Anthropic = anthropicModule.default;
    anthropicClient = new Anthropic({ logLevel: "off" });
    return anthropicClient;
  } catch {
    console.error("AI proxy setup failed. Check the installed SDK and private provider settings.");
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.socket.encrypted || req.headers["x-forwarded-proto"] === "https") res.setHeader("Strict-Transport-Security", HSTS);
  try {
    // Anything that changes something must come from this app's own page.
    if (url.pathname.startsWith("/api/") && req.method !== "GET" && auth && !auth.originOk(req)) return json(res, 403, { code: "ORIGIN", message: "Requests must come from this app.", retryable: false });
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/account/")) return auth ? await auth.handle(req, res, url) : json(res, 200, { enabled: false });
    if (url.pathname === "/api/ai/status") return json(res, 200, await status());
    if (url.pathname === "/api/ai" && req.method === "POST") return await proxy(req, res);
    if (url.pathname === "/api/fx") return json(res, 410, { code: "MANUAL_RATES", message: "Enter exchange rates in Settings. Online lookup is not available.", retryable: false });
    return serveStatic(url.pathname, res);
  } catch (e) {
    console.error("Server request failed:", e.code || "ERROR");
    json(res, 500, { code: "SERVER", message: "The server could not complete this request. Try again or use the normal form.", retryable: true });
  }
});

async function status() {
  const client = await getClient();
  return { configured: Boolean(client), models: client ? { ...MODELS, assistant: ASSISTANT_MODEL } : null, sign_in_required: AUTH_ON };
}

async function proxy(req, res) {
  // Who is asking is checked here and then dropped: nothing about the account goes any further.
  const guard = auth ? auth.aiGuard(req) : { account: null };
  if (guard.status && guard.body.code === "SIGN_IN") return json(res, guard.status, guard.body);
  const client = await getClient();
  if (!client) return json(res, 503, { code: "AI_FAILED", message: "AI isn't set up on this server.", retryable: false });
  if (guard.status) return json(res, guard.status, guard.body);
  let raw;
  try { raw = await readBody(req, MAX_BODY); } catch { return json(res, 413, { code: "TOO_LARGE", message: "Request too large.", retryable: false }); }
  let body;
  try { body = JSON.parse(raw); }
  catch { return json(res, 400, { code: "INVALID_REQUEST", message: "That request is not valid JSON. Try again.", retryable: false }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { code: "INVALID_REQUEST", message: "A request object is required.", retryable: false });
  const { task, input, images, documents } = body;
  const definition = taskDefinition(task);
  if (typeof task !== "string" || task.startsWith("assistant_") && !definition) return json(res, 400, { code: "INVALID_REQUEST", message: "Unknown task.", retryable: false });
  let { tier, system, schema, max_tokens } = body;
  if (definition) {
    if (Object.keys(body).some(k => !["task", "tier", "input", "images", "documents"].includes(k)) || tier != null && tier !== "strong") return json(res, 400, { code: "INVALID_REQUEST", message: "Assistant templates and limits belong to the app.", retryable: false });
    const problem = validateInput(task, input) || (input?.context != null ? validateProtectedContext(input.context) : null);
    if (problem) return json(res, 400, { code: "INVALID_REQUEST", message: problem, retryable: false });
    tier = "strong"; system = definition.system; schema = providerSchema(task); max_tokens = task === "assistant_extract" ? LIMITS.extractionOutputTokens : LIMITS.outputTokens;
    if ((images != null || documents != null) && task !== "assistant_extract" || !(await validAttachments(images, documents))) return json(res, 400, { code: "INVALID_REQUEST", message: "Unsupported or oversized file payload.", retryable: false });
  }
  if (!task || !tier || !schema) return json(res, 400, { code: "INVALID_REQUEST", message: "task, tier, schema required", retryable: false });
  if (!definition && !Object.hasOwn(MODELS, tier)) return json(res, 400, { code: "INVALID_REQUEST", message: "Choose a supported AI tier.", retryable: false });
  if (!definition) schema = closedProviderSchema(schema);
  const model = definition ? ASSISTANT_MODEL : MODELS[tier];

  const content = [];
  for (const img of images || []) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  for (const doc of definition ? documents || [] : []) content.push({ type: "document", source: { type: "base64", media_type: doc.media_type, data: doc.data } });
  const prompt = buildPrompt({ task, system, input, preserveUserText: Boolean(definition) });
  content.push({ type: "text", text: prompt.text });

  // No server identity/account/device metadata is forwarded. Assistant raw user text/files
  // are intentionally unchanged; attached financial context uses explicit protected projections.
  const params = {
    model,
    max_tokens: definition ? max_tokens : Math.min(max_tokens || 4096, 8192),
    system: prompt.system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  };

  if (req.aborted || res.destroyed) return;
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", cancel); res.once("close", cancel);
  let msg;
  try {
    msg = await client.messages.create(params, { maxRetries: 0, timeout: LIMITS.timeoutMs, signal: controller.signal });
  } catch (e) {
    if (guard.account) auth.aiCharge(guard.account, model, null);
    const failure = providerFailure(e);
    console.error("AI proxy failed:", Number.isInteger(e.status) ? e.status : "ERROR", failure.code, failure.diagnostic || "", ...(failure.mentions ? [failure.mentions.join(",")] : []));
    return json(res, 502, failure);
  } finally {
    req.removeListener("aborted", cancel); res.removeListener("close", cancel);
  }
  const usage = msg.usage || null;
  // Returned usage counts even when the reply is refused/malformed; unavailable is not zero.
  if (guard.account) auth.aiCharge(guard.account, model, usage);
  if (controller.signal.aborted) return;
  if (msg.stop_reason === "max_tokens") return json(res, 502, { code: "AI_SCHEMA", message: "The AI reply was incomplete. Split the request or use the normal form.", retryable: true });
  if (msg.stop_reason === "refusal") {
    return json(res, 502, { code: "AI_FAILED", message: "The AI provider declined this request.", retryable: false });
  }
  const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let output;
  try {
    output = JSON.parse(text);
    if (definition) output = decodeProviderOutput(task, output);
  } catch {
    return json(res, 502, { code: "AI_SCHEMA", message: "The AI reply did not match the permitted request. Retry or use the normal form.", retryable: true });
  }
  const safeTokens = value => Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
  console.log(`AI [${model}] in=${safeTokens(usage?.input_tokens)} out=${safeTokens(usage?.output_tokens)}`);
  json(res, 200, { output, usage });
}

async function validAttachments(images, documents) {
  if (images != null && !Array.isArray(images) || documents != null && !Array.isArray(documents)) return false;
  if ((images?.length || 0) + (documents?.length || 0) > 1) return false;
  for (const file of [...(images || []), ...(documents || [])]) {
    if (!file || Object.keys(file).some(k => !["media_type", "data"].includes(k)) || typeof file.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0 || file.data.length > Math.ceil(LIMITS.fileBytes / 3) * 4) return false;
    const bytes = Buffer.from(file.data, "base64");
    if (!bytes.length || bytes.length > LIMITS.fileBytes) return false;
    const type = file.media_type;
    const valid = type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 || type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || type === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" || type === "application/pdf" && bytes.toString("ascii", 0, 5) === "%PDF-";
    if (!valid || (documents || []).includes(file) && type !== "application/pdf" || (images || []).includes(file) && type === "application/pdf") return false;
    if (type === "application/pdf" && !(await checkPdfInThread(bytes))) return false;
  }
  return true;
}

function checkPdfInThread(bytes) {
  return new Promise(resolve => {
    let worker, timer, settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); worker?.terminate(); resolve(ok);
    };
    try {
      worker = new Worker(path.join(here, "pdf-validation-worker.mjs"), { workerData: bytes, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      timer = setTimeout(() => finish(false), 8000);
      worker.once("message", result => finish(result.ok === true));
      worker.once("error", () => finish(false));
      worker.once("exit", () => finish(false));
    } catch { finish(false); }
  });
}

// Provider objects must be closed; retain the caller's native validation/schema unchanged.
function closedProviderSchema(schema) {
  const result = structuredClone(schema);
  const close = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(close); return; }
    if (node.type === "object" || Array.isArray(node.type) && node.type.includes("object") || node.properties) node.additionalProperties = false;
    Object.values(node).forEach(close);
  };
  close(result);
  return result;
}

function providerFailure(error) {
  const status = error.status;
  const detail = error.error?.error?.message || error.error?.message || error.message || "";
  const A = anthropicModule.default;
  if (error instanceof A.APIConnectionTimeoutError || error.name === "TimeoutError") return { code: "AI_TIMEOUT", message: "AI timed out. Retry this step or use the normal form.", retryable: true };
  if ([400, 402].includes(status) && /credit balance|insufficient.*credit|billing/i.test(detail)) return { code: "AI_BILLING", message: "The AI account needs billing attention. Use the normal form for now.", retryable: false };
  if (status === 401 || status === 403) return { code: "AI_ACCESS", message: "The AI provider rejected this server's access. Use the normal form for now.", retryable: false };
  if (status === 404 || status === 400 && /unknown model|invalid model|model.*(?:not found|not available|not supported|access)/i.test(detail)) return { code: "AI_MODEL", message: "The configured AI model is unavailable for this account. Use the normal form for now.", retryable: false };
  if (status === 400 && /schema|output_config|structured output|additionalProperties|parameter|format|request option/i.test(detail)) {
    let diagnostic = "AI_REQUEST_FORMAT_UNKNOWN";
    if (/(?:too many|exceed(?:s|ed)?|limit(?: is| of)?|maximum)\s+optional\s+(?:schema\s+)?parameters?|optional\s+(?:parameter|field)s?\s+(?:limit|maximum|count)/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_OPTIONAL_LIMIT";
    else if (/(?:too many|exceed(?:s|ed)?|limit(?: is| of)?|maximum)\s+union\s+(?:schema\s+)?parameters?|union\s+(?:parameter|field)s?\s+(?:limit|maximum|count)/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_UNION_LIMIT";
    else if (/unsupported|not\s+supported|invalid.{0,40}schema|schema.{0,40}invalid/i.test(detail)) {
      if (/unsupported|not\s+supported/i.test(detail) && /(?:keyword|type|constraint|schema|grammar)/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA";
      else if (/invalid.{0,40}schema|schema.{0,40}invalid/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_INVALID_SCHEMA";
      else if (/unsupported.{0,40}(?:output_config|request option|option)|(?:output_config|request option).{0,40}unsupported/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_UNSUPPORTED_OPTION";
    } else if (/(?:too\s+complex|complexity\s+(?:limit|exceeded)|(?:grammar|schema).{0,40}(?:too\s+large|size\s+limit)|(?:compile|compilation|compiling).{0,40}tim(?:e|ed)\s*out|tim(?:e|ed)\s*out.{0,40}(?:compile|compilation|grammar|schema))/i.test(detail)) diagnostic = "AI_REQUEST_FORMAT_COMPLEXITY";
    const mentions = [];
    const hintPatterns = [
      ["clarification", /clarification/i], ["params/value", /params.{0,12}value|value.{0,12}params/i],
      ["topic", /topic/i], ["additionalProperties", /additionalProperties/i],
      ["type-array", /type.{0,12}array|array.{0,12}type/i], ["enum", /enum/i],
    ];
    for (const [label, pattern] of hintPatterns) if (pattern.test(detail)) mentions.push(label);
    const messages = {
      AI_REQUEST_FORMAT_COMPLEXITY: "The provider could not compile this structured reply format. Use the normal form for now.",
      AI_REQUEST_FORMAT_OPTIONAL_LIMIT: "The provider rejected the number of optional fields in this reply format. Use the normal form for now.",
      AI_REQUEST_FORMAT_UNION_LIMIT: "The provider rejected the number of choice types in this reply format. Use the normal form for now.",
      AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA: "The provider does not support part of this reply format. Use the normal form for now.",
      AI_REQUEST_FORMAT_INVALID_SCHEMA: "The provider rejected this reply format as invalid. Use the normal form for now.",
      AI_REQUEST_FORMAT_UNSUPPORTED_OPTION: "The provider does not support a request option. Use the normal form for now.",
      AI_REQUEST_FORMAT_UNKNOWN: "The provider rejected the reply format for an unknown reason. Use the normal form for now.",
    };
    return { code: "AI_REQUEST_FORMAT", diagnostic, message: messages[diagnostic], retryable: false, ...(mentions.length ? { mentions } : {}) };
  }
  if (status === 429) return { code: "AI_RATE_LIMIT", message: "AI is busy or its request limit was reached. Retry later or use the normal form.", retryable: true };
  return { code: "AI_FAILED", message: "AI could not complete this request. Retry or use the normal form.", retryable: error instanceof A.APIConnectionError || Number.isInteger(status) && status >= 500 };
}

function serveStatic(pathname, res) {
  let file = pathname === "/" ? "/index.html" : pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return json(res, 403, { code: "FORBIDDEN" });
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      if (!path.extname(file)) return fs.readFile(path.join(PUBLIC, "index.html"), (e2, d2) => send(res, e2 ? 404 : 200, ".html", d2 || "Not found"));
      return send(res, 404, ".html", "Not found");
    }
    send(res, 200, path.extname(full), data);
  });
}

function send(res, code, ext, data) {
  res.writeHead(code, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(data);
}
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Hodos prototype: http://${HOST || "localhost"}:${PORT}`);
  status().then(s => {
    let notice = "AI proxy off: no ANTHROPIC_API_KEY. Manual doors only.";
    if (s.configured) notice = `AI proxy on: ${JSON.stringify(s.models)}`;
    else if (process.env.ANTHROPIC_API_KEY) notice = "AI proxy off: SDK/private provider setup failed. Manual doors only.";
    console.log(notice);
  });
  console.log(auth ? `Sign-in on for ${auth.config.origins.join(", ")}. Email codes: ${auth.config.emailMode === "log" ? "printed here (no email service yet)" : auth.config.emailMode}. Google: ${auth.config.google ? "on" : "off (no GOOGLE_CLIENT_ID)"}.` : "Sign-in off (AUTH=off): the AI connection answers anyone who can reach it.");
});

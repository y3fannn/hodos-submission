// Resend sender and real auth handler, with a fake provider and no real credentials or mail.
// node webapp/test/email.mjs; expiry/resend use a controlled clock, not ten-minute sleeps.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmailSender } from "../email.mjs";
import { createAuth } from "../auth.mjs";
import { openAccounts } from "../accounts.mjs";
import { json } from "../http-util.mjs";

let checks = 0;
const ok = (condition, name) => { assert.ok(condition, name); checks++; };
const env = { NODE_ENV: "production", EMAIL_MODE: "resend", RESEND_API_KEY: "test-resend-secret" };
const accepted = () => new Response(JSON.stringify({ id: "test-message-id" }), { status: 200 });

// Configuration errors must not echo setting values or silently switch mode.
assert.throws(() => createEmailSender({ env: { ...env, EMAIL_MODE: "typo" } }), /EMAIL_MODE must/); checks++;
assert.throws(() => createEmailSender({ env: { ...env, RESEND_API_KEY: "" } }), /requires RESEND_API_KEY/); checks++;
assert.throws(() => createEmailSender({ env: { ...env, EMAIL_FROM: "bad\naddress" } }), /single sender address/); checks++;
assert.throws(() => createEmailSender({ env: { ...env, EMAIL_MODE: "log" } }), /refused in production/); checks++;
ok(createEmailSender({ env: { NODE_ENV: "production" } }).mode === "off", "production defaults to off");
ok(createEmailSender({ env: {} }).mode === "log", "local development keeps log mode");
await assert.rejects(createEmailSender({ env: { EMAIL_MODE: "off" } }).send("a@example.com", "code", "123456"), { code: "EMAIL_FAILED" }); checks++;

let request;
const sender = createEmailSender({ env, fetchImpl: async (url, options) => { request = { url, ...options }; return accepted(); } });
const logs = [], originalLog = console.log, originalError = console.error;
console.log = (...args) => logs.push(args.join(" "));
console.error = (...args) => logs.push(args.join(" "));
try {
  await sender.send("a@example.com", "Your Hodos sign-in code", "Your sign-in code is 123456.");
  ok(request.url === "https://api.resend.com/emails" && request.method === "POST", "fixed HTTPS endpoint");
  ok(request.headers.Authorization === "Bearer test-resend-secret" && request.redirect === "error", "server-only bearer key, redirects refused");
  assert.deepEqual(JSON.parse(request.body), { from: "Hodos <no-reply@hodos.consulting>", to: ["a@example.com"], subject: "Your Hodos sign-in code", text: "Your sign-in code is 123456." }); checks++;
  ok(request.signal instanceof AbortSignal, "sender has a bounded timeout");

  for (const response of [
    () => new Response("provider echoed test-resend-secret and 123456", { status: 401 }),
    () => new Response("quota reached", { status: 429 }),
    () => new Response("provider unavailable", { status: 503 }),
    () => new Response("not JSON", { status: 200 }),
    () => new Response("{}", { status: 200 }),
    () => new Response('{"id":""}', { status: 200 }),
  ]) {
    const failing = createEmailSender({ env, fetchImpl: async () => response() });
    await assert.rejects(failing.send("a@example.com", "code", "123456"), (e) => e.code === "EMAIL_FAILED" && !/test-resend-secret|123456|provider|quota/i.test(e.message)); checks++;
  }
  const failing = createEmailSender({ env, fetchImpl: async () => { throw new Error("Network leaked test-resend-secret 123456"); } });
  await assert.rejects(failing.send("a@example.com", "code", "123456"), { code: "EMAIL_FAILED" }); checks++;

  // Trigger the real timeout catch path deterministically without waiting eight seconds.
  const originalTimeout = AbortSignal.timeout;
  let requestedTimeout;
  try {
    AbortSignal.timeout = (ms) => { requestedTimeout = ms; return AbortSignal.abort(new DOMException("Timed out", "TimeoutError")); };
    const timedOut = createEmailSender({ env, fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); return accepted(); } });
    await assert.rejects(timedOut.send("a@example.com", "code", "123456"), { code: "EMAIL_FAILED" }); checks++;
    ok(requestedTimeout === 8000, "timeout is eight seconds");
  } finally { AbortSignal.timeout = originalTimeout; }
  ok(logs.length === 0, "production sender never logs mail, codes, keys or provider errors");
} finally { console.log = originalLog; console.error = originalError; }

// HTTP fixture invokes the same auth handler as server.js, not a substitute code verifier.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hodos-mail-"));
const accounts = openAccounts(path.join(dataDir, "accounts.db"));
const originalNow = Date.now;
let clock = originalNow(), outcome = "ok", releasePending, signalPending;
const sent = [];
const fakeSend = async (_url, options) => {
  const body = JSON.parse(options.body);
  sent.push(body);
  if (outcome === "network") throw new Error("test-resend-secret provider failure");
  if (outcome === "reject") return new Response("test-resend-secret echoed body", { status: 429 });
  if (outcome === "malformed") return new Response("{}", { status: 200 });
  if (outcome === "pending") {
    const pending = new Promise((resolve) => { releasePending = () => resolve(accepted()); });
    signalPending();
    return pending;
  }
  return accepted();
};
let auth;
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && !auth.originOk(req)) return json(res, 403, { code: "ORIGIN" });
    await auth.handle(req, res, new URL(req.url, "http://localhost"));
  } catch { json(res, 500, { code: "UNEXPECTED_TEST_ERROR" }); }
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  auth = createAuth({ accounts, env: { ...env, APP_ORIGIN: base }, fetchEmail: fakeSend });
  Date.now = () => clock;
  const call = async (route, body, origin = base) => {
    const r = await fetch(base + "/api/auth/" + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json(), headers: r.headers };
  };
  const code = () => sent.at(-1).text.match(/code is (\d{6})/)[1];
  const status = await (await fetch(base + "/api/auth/status")).json();
  ok(status.email === "resend" && status.signedIn === false, "status advertises configured Resend, not a session");
  let r = await call("email/start", { email: "a@example.com" }, "https://other.example");
  ok(r.status === 403 && sent.length === 0, "cross-site request sends no mail");
  r = await call("email/start", { email: "not-an-email" });
  ok(r.status === 400 && sent.length === 0, "invalid address sends no mail");

  r = await call("email/start", { email: "  First@Example.com ", intent: "signup" });
  const firstCode = code();
  ok(r.status === 200 && r.data.resend_after === 60 && /^\d{6}$/.test(firstCode), "accepted request sends six digits with the normal gap");
  ok(sent.at(-1).to[0] === "first@example.com" && !r.headers.has("set-cookie") && !accounts.byEmail("first@example.com"), "normalised address; requesting code creates no account or session");
  r = await call("email/start", { email: "first@example.com" });
  ok(r.status === 429 && sent.length === 1, "resend gap prevents another provider call");
  r = await call("email/verify", { email: "first@example.com", code: firstCode, intent: "signup" });
  ok(r.status === 200 && r.data.created === true && r.headers.has("set-cookie"), "accepted email code creates the account and session");
  r = await call("email/verify", { email: "first@example.com", code: firstCode });
  ok(r.data.code === "CODE_EXPIRED", "code works only once");

  clock += 61_000;
  await call("email/start", { email: "first@example.com" });
  r = await call("email/verify", { email: "first@example.com", code: code() });
  ok(r.status === 200 && r.data.created === false, "returning email finds the existing account");

  // Sign in must not register; start answers are generic until identity is proved.
  r = await call("email/start", { email: "unknown@example.com" });
  const unknownCode = code();
  ok(r.status === 200 && r.data.ok === true && !accounts.byEmail("unknown@example.com"), "unknown sign-in request reveals no account status");
  r = await call("email/verify", { email: "unknown@example.com", code: unknownCode, intent: "signup" });
  ok(r.status === 400 && r.data.code === "CODE_PURPOSE" && !r.headers.has("set-cookie") && !accounts.byEmail("unknown@example.com"), "sign-in code cannot be turned into signup");
  r = await call("email/verify", { email: "unknown@example.com", code: unknownCode });
  ok(r.status === 409 && r.data.code === "ACCOUNT_NOT_FOUND" && !r.headers.has("set-cookie") && !accounts.byEmail("unknown@example.com"), "verified unknown Sign in creates neither account nor session");
  r = await call("email/verify", { email: "unknown@example.com", code: unknownCode });
  ok(r.data.code === "CODE_EXPIRED", "unknown-account sign-in proof is consumed");
  clock += 61_000;
  r = await call("email/start", { email: "unknown@example.com", intent: "signup" });
  const signupCode = code();
  ok(r.status === 200 && sent.at(-1).subject === "Your Hodos account creation code", "explicit signup sends an account-creation message");
  r = await call("email/verify", { email: "unknown@example.com", code: signupCode });
  ok(r.status === 400 && r.data.code === "CODE_PURPOSE" && !accounts.byEmail("unknown@example.com"), "signup proof cannot be submitted on Sign in");
  r = await call("email/verify", { email: "unknown@example.com", code: signupCode, intent: "signup" });
  ok(r.status === 200 && r.data.created && accounts.byEmail("unknown@example.com"), "explicit verified signup creates the new account");
  r = await call("email/start", { email: "invalid-intent@example.com", intent: "auto" });
  ok(r.status === 400 && r.data.code === "INTENT", "invalid account intent is refused");
  clock += 61_000;
  r = await call("email/start", { email: "first@example.com", intent: "signup" });
  const existingSignupCode = code(), existingId = accounts.byEmail("first@example.com").id;
  r = await call("email/verify", { email: "first@example.com", code: existingSignupCode, intent: "signup" });
  ok(r.status === 200 && !r.data.created && accounts.byEmail("first@example.com").id === existingId, "signup of an existing verified address reuses, never duplicates");

  await call("email/start", { email: "expire@example.com" });
  const expiresCode = code();
  clock += 600_001;
  r = await call("email/verify", { email: "expire@example.com", code: expiresCode });
  ok(r.data.code === "CODE_EXPIRED" && !accounts.byEmail("expire@example.com"), "ten-minute expiry actually prevents sign-in");

  await call("email/start", { email: "tries@example.com" });
  const triesCode = code(), wrong = triesCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) r = await call("email/verify", { email: "tries@example.com", code: wrong });
  ok(r.data.code === "CODE_EXPIRED", "five wrong attempts invalidate the code");
  r = await call("email/verify", { email: "tries@example.com", code: triesCode });
  ok(r.data.code === "CODE_EXPIRED", "correct code cannot revive an exhausted code");

  for (const failure of ["reject", "network", "malformed"]) {
    outcome = "ok";
    const email = failure + "@example.com";
    await call("email/start", { email });
    const oldCode = code();
    clock += 61_000;
    outcome = failure;
    r = await call("email/start", { email });
    const failedCode = code();
    ok(r.status === 503 && r.data.code === "EMAIL_FAILED" && !JSON.stringify(r.data).includes("test-resend-secret"), failure + ": clear safe failure");
    for (const value of [oldCode, failedCode]) {
      r = await call("email/verify", { email, code: value });
      ok(r.data.code === "CODE_EXPIRED", failure + ": neither old nor failed code is usable");
    }
    r = await call("email/start", { email });
    ok(r.status === 429 && !accounts.byEmail(email), failure + ": failures retain request limits and create no account");
  }

  // The message may still be in flight: the code cannot work until acceptance.
  outcome = "pending";
  const pendingReached = new Promise((resolve) => { signalPending = resolve; });
  const pendingRequest = call("email/start", { email: "pending@example.com", intent: "signup" });
  await pendingReached;
  const pendingCode = code();
  r = await call("email/verify", { email: "pending@example.com", code: pendingCode });
  ok(r.data.code === "CODE_EXPIRED", "pending mail cannot sign anyone in");
  releasePending();
  ok((await pendingRequest).status === 200, "pending request completes when accepted");
  r = await call("email/verify", { email: "pending@example.com", code: pendingCode, intent: "signup" });
  ok(r.status === 200, "only then can its code sign in");
} finally {
  Date.now = originalNow;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  accounts.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`${checks} email checks passed`);

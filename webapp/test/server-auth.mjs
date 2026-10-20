// Sign-in and the AI guard, against the real server. design/2026-09-19-security.md §1, §4.
// Starts its own server on a spare port with a throwaway accounts file, a stand-in AI provider and a
// stand-in Google, so it needs no key, no network and nothing running. node test/server-auth.mjs
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { authenticator, enroll, approve } from "./webauthn-fixture.mjs";
await import("./device-access.mjs");

// The existing CI entry point also gates Resend delivery. Fail before starting server fixtures
// if any email assertion fails, without needing a workflow-permission change.
await import("./email.mjs");
await import("./auth-entry.mjs");
await import("./demo-loading.mjs");
// Keep the rate tests' browser globals isolated; this entry point is the existing CI gate.
const manualFx = spawnSync(process.execPath, [fileURLToPath(new URL("./manual-fx.mjs", import.meta.url))], { stdio: "inherit", timeout: 30000 });
if (manualFx.status !== 0) throw new Error("Manual exchange-rate checks failed.");
// Gate the real SDK boundary in the existing CI entry point, without changing its workflow.
await import("./assistant-proxy.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };

// ---------- stand-ins ----------
// The AI provider: answers every call with a small JSON object; a call whose input says BIG reports
// four million synthetic input tokens, crossing the former dollar cap in five fake calls.
const provider = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const big = body.includes("BIG");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: big ? 4_000_000 : 100, output_tokens: 10 } }));
  });
});
// Google's token endpoint: hands back an id_token for whatever nonce the test planted.
let googleClaims = null;
const google = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const p = new URLSearchParams(body);
    const good = p.get("code") === "good-code" && p.get("code_verifier") && p.get("client_id") === "test-client";
    const token = ["e30", Buffer.from(JSON.stringify(googleClaims)).toString("base64url"), "sig"].join(".");
    res.writeHead(good ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(good ? { id_token: token } : { error: "invalid_grant" }));
  });
});
await new Promise((r) => provider.listen(0, r)); await new Promise((r) => google.listen(0, r));

const PORT = 18000 + Math.floor(Math.random() * 2000), BASE = `http://localhost:${PORT}`, ORIGIN = BASE;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-auth-"));
const server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, EMAIL_MODE: "log", AUTH_RESEND_SECONDS: "1", AI_HOURLY_LIMIT: "5",
    ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "s", GOOGLE_AUTH_URL: "https://google.test/auth", GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.address().port}/token`, NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));
for (let i = 0; i < 50 && !out.includes("prototype:"); i++) await sleep(100);

// ---------- a tiny cookie-keeping client, one per "browser" ----------
function browser() {
  const jar = new Map(); let accountId;
  const call = async (p, { method = "GET", body, origin = ORIGIN, redirect = "manual", accountIdHeader } = {}) => {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (origin) headers.Origin = origin;
    const expected = accountIdHeader ?? accountId;
    if (expected) headers["X-Hodos-Account"] = expected;
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect });
    const set = r.headers.getSetCookie();
    for (const c of set) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); }
    let data = null; try { data = await r.json(); } catch {}
    if (data?.account?.id) accountId = data.account.id;
    if (data?.account === null || (p === "/api/auth/signout" && r.ok)) accountId = undefined;
    return { status: r.status, data, set, headers: r.headers };
  };
  return { call, jar, accountId: () => accountId };
}
const codeFor = async () => { for (let i = 0; i < 30; i++) { const m = [...out.matchAll(/code is (\d{6})/g)]; if (m.length) return m.at(-1)[1]; await sleep(50); } return null; };
async function signIn(b, email, remember = true, intent = "signin") {
  const before = [...out.matchAll(/code is/g)].length;
  const s = await b.call("/api/auth/email/start", { method: "POST", body: { email, intent } });
  for (let i = 0; i < 30 && [...out.matchAll(/code is/g)].length === before; i++) await sleep(50);
  const v = await b.call("/api/auth/email/verify", { method: "POST", body: { email, code: await codeFor(), remember, intent } });
  return { s, v };
}

try {
  // ---------- status ----------
  const A = browser();
  let r = await A.call("/api/auth/status");
  ok(r.status === 200 && r.data.enabled && r.data.email === "log" && r.data.google === true && r.data.signedIn === false, "status before sign-in");

  r = await A.call("/api/fx?from=USD&to=SGD");
  ok(r.status === 410 && r.data.code === "MANUAL_RATES", "current rate lookup retired, never proxied");
  r = await A.call("/api/fx?from=USD&to=SGD&date=2016-01-04");
  ok(r.status === 410 && r.data.code === "MANUAL_RATES", "historical rate lookup retired, never proxied");

  // ---------- the page's own origin only ----------
  r = await A.call("/api/auth/email/start", { method: "POST", body: { email: "a@example.com" }, origin: null });
  ok(r.status === 403 && r.data.code === "ORIGIN", "a request with no Origin is refused");
  r = await A.call("/api/auth/email/start", { method: "POST", body: { email: "a@example.com" }, origin: "https://evil.example" });
  ok(r.status === 403, "a request from another site is refused");
  r = await A.call("/api/ai", { method: "POST", body: { task: "t", tier: "cheap", schema: {} }, origin: "https://evil.example" });
  ok(r.status === 403, "the AI connection refuses another site too");

  // ---------- email code: explicit signup creates the account ----------
  r = await A.call("/api/auth/email/start", { method: "POST", body: { email: "not an email" } });
  ok(r.status === 400 && r.data.code === "EMAIL", "a malformed address is refused");
  r = await A.call("/api/auth/email/start", { method: "POST", body: { email: "  Duan@Example.com ", intent: "signup" } });
  ok(r.status === 200 && r.data.resend_after === 1, "a code is sent");
  const code = await codeFor();
  ok(/^\d{6}$/.test(code), "a six-digit code is printed while there is no email service");
  ok(!out.includes("duan@example.com") && out.includes("d***@example.com"), "the log masks the address");
  r = await A.call("/api/auth/email/start", { method: "POST", body: { email: "duan@example.com" } });
  ok(r.status === 429 && r.data.code === "SLOW_DOWN", "a second code at once is refused");
  const wrong = code === "000000" ? "111111" : "000000";
  r = await A.call("/api/auth/email/verify", { method: "POST", body: { email: "duan@example.com", code: wrong } });
  ok(r.status === 400 && r.data.code === "CODE_WRONG" && r.data.tries_left === 4, "a wrong code says how many tries are left");
  r = await A.call("/api/auth/email/verify", { method: "POST", body: { email: "duan@example.com", code, remember: true, intent: "signup" } });
  ok(r.status === 200 && r.data.created === true && r.data.account.email === "duan@example.com", "the right code creates the account");
  const sc = r.set.find((c) => c.startsWith("pfa_session=")) || "";
  ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=2592000/.test(sc), "session cookie: script cannot read it, never sent from other sites, 30 days when remembered");
  r = await A.call("/api/auth/email/verify", { method: "POST", body: { email: "duan@example.com", code } });
  ok(r.status === 400 && r.data.code === "CODE_EXPIRED", "a code works once");
  r = await A.call("/api/auth/status");
  ok(r.data.signedIn && r.data.account.email === "duan@example.com" && !Object.hasOwn(r.data.ai,'cap_usd') && r.data.ai.estimated_usd === 0 && r.data.ai.estimate_complete, "signed in, read-only monthly estimate without dollar allowance");

  const deviceA = authenticator(ORIGIN);
  ok(r.data.account.id && !r.data.deviceVerified, "email verifies identity only, and exposes a stable public owner ID");
  r = await A.call("/api/ai", { method: "POST", body: { task: "test", tier: "cheap", schema: {} } });
  ok(r.status === 403 && r.data.code === "DEVICE_REQUIRED", "email alone cannot call AI");
  r = await A.call("/api/account/recovery", { method: "POST", body: { fingerprint: "0".repeat(64) } });
  ok(r.status === 403 && r.data.code === "DEVICE_REQUIRED", "email alone cannot replace recovery access");
  const identityToken = A.jar.get("pfa_session");
  r = await enroll(A, deviceA);
  ok(r.status === 200 && A.jar.get("pfa_session") !== identityToken, "first device enrollment verifies a signed credential and rotates the identity-only session");
  const oldSession = browser(); oldSession.jar.set("pfa_session", identityToken);
  ok(!(await oldSession.call("/api/auth/status")).data.signedIn, "the pre-approval session token is retired");
  r = await A.call("/api/auth/status");
  ok(r.data.deviceVerified && r.data.account.credentialIds.includes(deviceA.id), "status identifies an approved account credential");
  r = await A.call("/api/account/passkeys/options", { method: "POST", body: {}, accountIdHeader: "another-account" });
  ok(r.status === 403 && r.data.code === "ACCOUNT_CHANGED", "a stale tab cannot manage credentials under another account's cookie");
  r = await A.call("/api/ai", { method: "POST", body: { task: "test", tier: "cheap", schema: {} }, accountIdHeader: "another-account" });
  ok(r.status === 403 && r.data.code === "ACCOUNT_CHANGED", "stale financial context cannot reach AI under another account's cookie");

  // Five wrong codes and the code is gone.
  const B = browser();
  await sleep(1100);
  await B.call("/api/auth/email/start", { method: "POST", body: { email: "five@example.com" } });
  const fiveCode = await codeFor();
  for (let i = 0; i < 5; i++) r = await B.call("/api/auth/email/verify", { method: "POST", body: { email: "five@example.com", code: fiveCode === "000000" ? "111111" : "000000" } });
  ok(r.data.code === "CODE_EXPIRED", "the fifth wrong code ends it");
  r = await B.call("/api/auth/email/verify", { method: "POST", body: { email: "five@example.com", code: fiveCode } });
  ok(r.status === 400, "even the right code is refused after five wrong ones");

  // Signing in again with the same address finds the same account.
  const A2 = browser();
  await sleep(1100);
  ({ v: r } = await signIn(A2, "duan@example.com", false));
  ok(r.status === 200 && r.data.created === false, "a second sign-in finds the account instead of making another");
  ok(!(r.set.find((c) => c.startsWith("pfa_session=")) || "").includes("Max-Age"), "not remembered: the cookie ends with the browser");
  r = await A.call("/api/auth/status");
  ok(r.data.account.sessions === 2, "two devices, two sessions");

  r = await A2.call("/api/account/passkeys/options", { method: "POST", body: {} });
  ok(r.status === 403 && r.data.code === "DEVICE_REQUIRED", "a returning email session cannot enroll an attacker credential");
  r = await approve(A2, deviceA, { uv: false });
  ok(r.status === 401, "a credential without device user verification is refused");
  const crossed = await A2.call("/api/account/device/options", { method: "POST", body: {} });
  r = await A.call("/api/account/device/verify", { method: "POST", body: { flow: crossed.data.flow, response: deviceA.assert(crossed.data.options) } });
  ok(r.status === 400 && r.data.code === "EXPIRED", "device challenges are bound to the original session, even for the same account");
  r = await approve(A2, deviceA);
  ok(r.status === 200 && !r.set.some((c) => /Max-Age=2592000/.test(c)), "email plus device approval opens access and preserves the short-session choice");

  // ---------- the AI guard ----------
  const C = browser();
  const aiBody = (input = "hello") => ({ task: "test", tier: "cheap", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, input: { text: input } });
  r = await C.call("/api/ai", { method: "POST", body: aiBody() });
  ok(r.status === 401 && r.data.code === "SIGN_IN", "the AI connection refuses anyone not signed in");
  r = await A.call("/api/ai", { method: "POST", body: aiBody() });
  ok(r.status === 200 && r.data.output?.ok === true, "signed in, a call goes through");
  for (let i = 0; i < 4; i++) r = await A.call("/api/ai", { method: "POST", body: aiBody() });
  ok(r.status === 200, "up to the hourly limit, calls go through");
  r = await A.call("/api/ai", { method: "POST", body: aiBody() });
  ok(r.status === 429 && r.data.code === "RATE_LIMIT", "one past the hourly limit is refused");
  r = await A.call("/api/auth/status");
  ok(r.data.ai.calls_this_hour === 5 && r.data.ai.spent_usd > 0 && r.data.ai.spent_usd < 0.01, "usage counted from token counts");

  const D = browser();
  await sleep(1100);
  await signIn(D, "big@example.com", true, "signup");
  const deviceD = authenticator(ORIGIN);
  ok((await enroll(D, deviceD)).status === 200, "another account enrolls its own credential");
  for (let i = 0; i < 5; i++) r = await D.call("/api/ai", { method: "POST", body: aiBody("BIG") });
  ok(r.status === 200, "five $2 calls remain allowed without a dollar allowance");
  r = await D.call("/api/ai", { method: "POST", body: aiBody("BIG") });
  ok(r.status === 429 && r.data.code === "RATE_LIMIT", "technical hourly guard still applies, not a dollar cap");
  r = await D.call("/api/auth/status");
  ok(r.data.ai.spent_usd === 10.000125, "Haiku 5.5 long-prompt cost: 5 × (4,000,000 in × $0.50 + 10 out × $2.50) a million; no dollar denial");
  const dbFile = fs.readFileSync(path.join(DATA, "accounts.db"));
  ok(!dbFile.includes("hello") && !dbFile.includes("BIG"), "nothing sent to the AI is kept");

  // ---------- recovery key ----------
  const proof = crypto.randomBytes(32).toString("hex"), fp = crypto.createHash("sha256").update(proof).digest("hex");
  r = await C.call("/api/account/recovery", { method: "POST", body: { fingerprint: fp } });
  ok(r.status === 401, "setting a recovery fingerprint needs a session");
  r = await A.call("/api/account/recovery", { method: "POST", body: { fingerprint: fp } });
  ok(r.status === 200, "the recovery fingerprint is stored");
  ok(!fs.readFileSync(path.join(DATA, "accounts.db")).includes(proof), "the proof itself is never stored");
  r = await C.call("/api/auth/recovery", { method: "POST", body: { email: "duan@example.com", proof: crypto.randomBytes(32).toString("hex") } });
  ok(r.status === 401 && r.data.code === "WRONG", "the wrong recovery key is refused");
  r = await C.call("/api/auth/recovery", { method: "POST", body: { email: "duan@example.com", proof } });
  ok(r.status === 200 && r.data.account.email === "duan@example.com", "the right recovery key signs in");
  r = await A2.call("/api/auth/recovery", { method: "POST", body: { email: "duan@example.com", proof, remember: true } });
  ok(r.status === 200 && !r.set.some((c) => /Max-Age=2592000/.test(c)), "emergency unlock preserves an existing short-session choice");

  // ---------- passkeys ----------
  r = await C.call("/api/auth/passkey/options", { method: "POST", body: {} });
  ok(r.status === 200 && r.data.flow && r.data.options.challenge && r.data.options.userVerification === "required", "passkey sign-in asks for Face ID or a fingerprint");
  r = await C.call("/api/auth/passkey/verify", { method: "POST", body: { flow: r.data.flow, response: { id: "nope", rawId: "nope", type: "public-key", response: {} } } });
  ok(r.status === 401 && r.data.code === "UNKNOWN_PASSKEY", "an unknown passkey is refused");
  r = await C.call("/api/auth/passkey/verify", { method: "POST", body: { flow: "made-up", response: {} } });
  ok(r.status === 400 && r.data.code === "EXPIRED", "a made-up challenge is refused");
  r = await A.call("/api/account/passkeys/options", { method: "POST", body: {} });
  ok(r.status === 200 && r.data.options.user.name === "duan@example.com" && r.data.options.authenticatorSelection.residentKey === "required", "adding a passkey names it after the account");
  r = await B.call("/api/account/passkeys/options", { method: "POST", body: {} });
  ok(r.status === 401, "adding a passkey needs a session");
  const P = browser();
  r = await P.call("/api/auth/passkey/options", { method: "POST", body: {} });
  const signed = { flow: r.data.flow, response: deviceA.assert(r.data.options), remember: true };
  r = await P.call("/api/auth/passkey/verify", { method: "POST", body: signed });
  ok(r.status === 200 && r.data.account.email === "duan@example.com" && (await P.call("/api/auth/status")).data.deviceVerified, "one signed passkey assertion establishes approved account access");
  r = await P.call("/api/auth/passkey/verify", { method: "POST", body: signed });
  ok(r.status === 400 && r.data.code === "EXPIRED", "a passkey assertion cannot be replayed");

  // ---------- Google ----------
  const G = browser();
  r = await G.call("/api/auth/google/start?remember=1");
  const loc = new URL(r.headers.get("location"));
  const state = loc.searchParams.get("state"), nonce = loc.searchParams.get("nonce");
  ok(r.status === 302 && loc.origin === "https://google.test" && loc.searchParams.get("scope") === "openid email" && loc.searchParams.get("code_challenge_method") === "S256", "Google: sent to Google, asking for the email address only");
  ok(/SameSite=Lax/.test(r.set.join()) && G.jar.get("pfa_oauth") === state, "Google: the hand-off is tied to this browser");
  googleClaims = { iss: "https://accounts.google.com", aud: "test-client", sub: "g-123", email: "duan@example.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, nonce };
  const H = browser();
  r = await H.call(`/api/auth/google/callback?state=${state}&code=good-code`);
  ok(r.status === 302 && r.headers.get("location").includes("error=google"), "Google: a different browser cannot finish the hand-off");
  r = await G.call(`/api/auth/google/callback?state=${state}&code=good-code`);
  ok(r.status === 302 && r.headers.get("location") === "/#/signin?done=google", "Google: back to the app, signed in");
  r = await G.call("/api/auth/status");
  ok(r.data.signedIn && r.data.account.email === "duan@example.com" && r.data.account.google && !r.data.deviceVerified, "Google: the same email joins the account but does not approve device access");
  r = await G.call("/api/ai", { method: "POST", body: aiBody() });
  ok(r.status === 403 && r.data.code === "DEVICE_REQUIRED", "Google alone cannot call AI");
  r = await approve(G, deviceD);
  ok(r.status === 401 && r.data.code === "UNKNOWN_PASSKEY", "another account's signed credential cannot approve Google access");
  r = await approve(G, deviceA, { atOrigin: "https://evil.example" });
  ok(r.status === 401, "a signed assertion for another origin is refused");
  r = await approve(G, deviceA);
  ok(r.status === 200 && (await G.call("/api/auth/status")).data.deviceVerified, "Google plus the enrolled device completes access");
  r = await G.call(`/api/auth/google/callback?state=${state}&code=good-code`);
  ok(r.headers.get("location").includes("error=google"), "Google: a hand-off works once");
  const G2 = browser();
  r = await G2.call("/api/auth/google/start");
  const nonce2 = new URL(r.headers.get("location")).searchParams.get("nonce"), state2 = new URL(r.headers.get("location")).searchParams.get("state");
  googleClaims = { ...googleClaims, sub: "g-999", email: "unverified@example.com", email_verified: false, nonce: nonce2 };
  r = await G2.call(`/api/auth/google/callback?state=${state2}&code=good-code`);
  ok(r.headers.get("location").includes("error=google"), "Google: an unverified email is refused");

  // Verified Google identity does not permit a Sign in flow to silently register.
  const GN = browser();
  r = await GN.call("/api/auth/google/start");
  let newFlow = new URL(r.headers.get("location"));
  googleClaims = { iss: "https://accounts.google.com", aud: "test-client", sub: "g-new", email: "new-google@example.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, nonce: newFlow.searchParams.get("nonce") };
  r = await GN.call(`/api/auth/google/callback?state=${newFlow.searchParams.get("state")}&code=good-code&intent=signup`);
  ok(r.headers.get("location") === "/#/signin?error=account_missing" && !r.set.some(c => c.startsWith("pfa_session=")), "Google: callback cannot change Sign in into registration");
  r = await GN.call("/api/auth/status");
  ok(!r.data.signedIn, "Google: unknown Sign in creates no session");
  r = await GN.call("/api/auth/google/start?intent=signup");
  newFlow = new URL(r.headers.get("location"));
  googleClaims = { ...googleClaims, nonce: newFlow.searchParams.get("nonce") };
  r = await GN.call(`/api/auth/google/callback?state=${newFlow.searchParams.get("state")}&code=good-code&intent=signin`);
  ok(r.headers.get("location") === "/#/signin?done=google", "Google: explicit signup is bound to its original flow");
  r = await GN.call("/api/auth/status");
  ok(r.data.signedIn && r.data.account.email === "new-google@example.com", "Google: verified signup registers and signs in");
  await GN.call("/api/auth/signout", { method: "POST", body: {} });
  r = await GN.call("/api/auth/google/start");
  newFlow = new URL(r.headers.get("location"));
  googleClaims = { ...googleClaims, nonce: newFlow.searchParams.get("nonce") };
  r = await GN.call(`/api/auth/google/callback?state=${newFlow.searchParams.get("state")}&code=good-code`);
  ok(r.headers.get("location") === "/#/signin?done=google", "Google: new signup is later an existing Sign in account");
  r = await GN.call("/api/auth/google/start?intent=auto");
  ok(r.status === 400 && r.data.code === "INTENT", "Google: invalid entry purpose is refused");
  const GX = browser();
  r = await GX.call("/api/auth/google/start?intent=signup");
  newFlow = new URL(r.headers.get("location"));
  r = await GX.call(`/api/auth/google/callback?state=${newFlow.searchParams.get("state")}&error=access_denied`);
  ok(r.headers.get("location") === "/#/signup?error=google", "Google: cancelled signup returns to the right page");

  await GN.call("/api/auth/status"); // Match the app's boot after Google's redirect before naming the account.
  ok((await enroll(GN, authenticator(ORIGIN))).status === 200, "the Google-created account enrolls its own first device");
  // Malformed private payloads must neither reach the provider nor be echoed/logged by parsing.
  r = await fetch(BASE + "/api/ai", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Hodos-Account": GN.accountId(), Cookie: [...GN.jar].map(([k,v]) => `${k}=${v}`).join("; ") }, body: "PRIVATE_JSON_MARKER not JSON" });
  const invalid = await r.json();
  ok(r.status === 400 && invalid.code === "INVALID_REQUEST" && !JSON.stringify(invalid).includes("PRIVATE_JSON_MARKER") && !out.includes("PRIVATE_JSON_MARKER"), "invalid JSON has a generic private error, without logging its body");

  // ---------- signing out ----------
  r = await A2.call("/api/auth/signout", { method: "POST", body: {} });
  r = await A2.call("/api/auth/status");
  ok(r.data.signedIn === false, "sign out ends this device's session");
  r = await A.call("/api/auth/status");
  ok(r.data.signedIn === true, "and leaves the other device signed in");
  r = await A.call("/api/auth/signout-all", { method: "POST", body: {} });
  r = await G.call("/api/auth/status");
  ok(r.data.signedIn === false, "sign out everywhere ends every session");

  // ---------- deleting the account ----------
  await sleep(1100);
  await signIn(A, "duan@example.com");
  r = await A.call("/api/account/delete", { method: "POST", body: { confirm: "duan@example.com" } });
  ok(r.status === 403 && r.data.code === "DEVICE_REQUIRED", "email alone cannot delete the account");
  ok((await approve(A, deviceA)).status === 200, "the enrolled device approves deletion access");
  r = await A.call("/api/account/delete", { method: "POST", body: { confirm: "someone@else.com" } });
  ok(r.status === 400, "deleting needs the email typed exactly");
  r = await A.call("/api/account/delete", { method: "POST", body: { confirm: "Duan@example.com" } });
  ok(r.status === 200, "the account is deleted");
  await sleep(1100);
  ({ v: r } = await signIn(A, "duan@example.com", true, "signup"));
  ok(r.data.created === true, "and everything held about it went with it");

// ---------- the server's own front door (design/2026-09-20-vm.md) ----------
// Two rules the VM depends on, checked by starting a second server of its own.
{
  const boot = (env) => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfa-boot-"));
    const p = spawn(process.execPath, [path.join(here, "..", "server.js")],
      { env: { ...process.env, DATA_DIR: dir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
    const done = (code) => { fs.rmSync(dir, { recursive: true, force: true }); resolve({ code, text }); };
    p.on("exit", done);
    setTimeout(() => { p.kill(); }, 3000);
  });

  // HOST: on the VM the server must answer only inside the machine, so nothing can reach it
  // around Caddy.
  const port = 8900 + Math.floor(Math.random() * 90);
  const local = await boot({ PORT: String(port), HOST: "127.0.0.1", AUTH: "off" });
  ok(local.text.includes(`127.0.0.1:${port}`), "HOST: the server says which address it listens on");
  const reachable = async (host) => {
    try { await fetch(`http://${host}:${port}/api/auth/status`, { signal: AbortSignal.timeout(1500) }); return true; }
    catch { return false; }
  };
  const p2 = spawn(process.execPath, [path.join(here, "..", "server.js")],
    { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", AUTH: "off", DATA_DIR: DATA }, stdio: "ignore" });
  await sleep(700);
  ok(await reachable("127.0.0.1"), "HOST=127.0.0.1: reachable from inside the machine");
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  ok(!lan || !(await reachable(lan.address)), "HOST=127.0.0.1: not reachable from the network");
  p2.kill();

  // EMAIL_MODE=log prints sign-in codes. In production that would put them in the system log.
  const bad = await boot({ PORT: String(port + 1), NODE_ENV: "production", EMAIL_MODE: "log", APP_ORIGIN: "https://x.test" });
  ok(bad.code === 1 && /EMAIL_MODE=log is refused in production/.test(bad.text),
    "production refuses EMAIL_MODE=log, so codes can never land in the log");
}
} catch (e) {
  fail++; console.log("FAIL (threw)", e);
} finally {
  server.kill(); provider.close(); google.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (fail) console.log(out);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

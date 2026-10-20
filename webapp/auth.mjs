// Sign-in: a passkey, a code sent by email, or Google. No passwords anywhere.
// Google/email establish identity; a verified account-owned device completes access. Passkey
// access combines both in one assertion. Device PRF secrets stay in the browser, never here.
// Explicit Create account remains required. design/2026-10-06-device-access.md.
import crypto from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { json, readJson, cookies, cookie, isHttps, clientIp } from "./http-util.mjs";
import { sha256 } from "./accounts.mjs";
import { createEmailSender } from "./email.mjs";

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const CODE_TTL = 10 * MIN, CODE_TRIES = 5, FLOW_TTL = 5 * MIN;
const LONG_SESSION = 30 * DAY, SHORT_SESSION = 12 * HOUR;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// Published list prices checked 2026-10-15; estimates, not invoice charges.
// https://platform.claude.com/docs/en/about-claude/pricing (USD per million tokens).
export const PRICES = { "claude-haiku-4-5": [1, 5], "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5": [2, 10], "claude-sonnet-5-5": [2, 10], "claude-opus-5": [5, 25], "claude-opus-5-5": [4, 20] };
export function costMicro(model, usage) {
  if (!Object.hasOwn(PRICES, model) || !usage) return null;
  const { input_tokens, output_tokens, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } = usage;
  if (![input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const promptTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
  if (!Number.isSafeInteger(promptTokens)) return null;
  const [pin, pout] = model === "claude-haiku-5-5" && promptTokens > 100000 ? [0.5, 2.5] : PRICES[model];
  let five = cache_creation_input_tokens, hour = 0;
  if (usage.cache_creation) {
    five = usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
    hour = usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
    if (![five, hour].every(n => Number.isSafeInteger(n) && n >= 0) || five + hour !== cache_creation_input_tokens) return null;
  }
  const readDivisor = ["claude-sonnet-5-5", "claude-opus-5-5"].includes(model) ? 20n : 10n;
  // Thousandths of a micro-dollar keep Haiku's fractional rates exact before one final ceil.
  const inputRate = BigInt(Math.round(pin * 1000)), outputRate = BigInt(Math.round(pout * 1000));
  const total = BigInt(input_tokens) * inputRate + BigInt(output_tokens) * outputRate
    + BigInt(five) * inputRate * 5n / 4n + BigInt(hour) * inputRate * 2n
    + BigInt(cache_read_input_tokens) * inputRate / readDivisor;
  const rounded = (total + 999n) / 1000n;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}
export const monthOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);

// A sliding window of attempts per key: an email address, a connection, an account.
function limiter(windowMs, max) {
  const hits = new Map();
  const recent = (key) => { const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < windowMs); hits.set(key, list); return list; };
  return {
    allow(key) { const list = recent(key); if (list.length >= max) return false; list.push(Date.now()); return true; },
    count: (key) => recent(key).length,
    // Seconds until the oldest attempt in the window drops out.
    wait(key) { const list = recent(key); return list.length ? Math.ceil((windowMs - (Date.now() - list[0])) / 1000) : 0; },
  };
}
// Short-lived things held in memory only: codes, passkey challenges, Google hand-offs. A restart
// forgets them, which costs a user one more tap and nothing else.
function shortStore(ttl) {
  const m = new Map();
  return {
    put(key, value) { m.set(key, { ...value, expires: Date.now() + ttl }); for (const [k, v] of m) if (v.expires < Date.now()) m.delete(k); },
    take(key) { const v = m.get(key); m.delete(key); return v && v.expires > Date.now() ? v : null; },
    peek(key) { const v = m.get(key); return v && v.expires > Date.now() ? v : null; },
    drop: (key) => m.delete(key),
  };
}
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export function createAuth({ accounts, env = process.env, port, fetchEmail = fetch }) {
  const origins = String(env.APP_ORIGIN || `http://localhost:${port},http://127.0.0.1:${port}`).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  let rpID = env.RP_ID;
  if (!rpID) {
    try { rpID = new URL(origins[0]).hostname; }
    catch { throw new Error("APP_ORIGIN must include a valid app URL."); }
  }
  const mail = createEmailSender({ env, fetchImpl: fetchEmail });
  const emailMode = mail.mode;
  const resend = Number(env.AUTH_RESEND_SECONDS ?? 60);
  const google = env.GOOGLE_CLIENT_ID ? {
    id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET || "",
    authUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  } : null;
  const ai = { hourly: Number(env.AI_HOURLY_LIMIT || 30) };

  const codeKey = crypto.randomBytes(32); // codes never outlive this process, so neither does their key
  const codeHash = (email, code, intent) => crypto.createHmac("sha256", codeKey).update(`${intent}:${email}:${code}`).digest("hex");
  const entryIntent = (value) => value === undefined ? "signin" : ["signin", "signup"].includes(value) ? value : null;
  const codes = shortStore(CODE_TTL), flows = shortStore(FLOW_TTL), googleFlows = shortStore(10 * MIN);
  const limits = {
    sendPerEmail: limiter(HOUR, 5), sendGap: limiter(resend * 1000, 1), sendPerIp: limiter(HOUR, 20),
    recoverPerEmail: limiter(HOUR, 5), recoverPerIp: limiter(HOUR, 20),
    signinPerIp: limiter(10 * MIN, 30), aiPerAccount: limiter(HOUR, ai.hourly),
  };

  const cookieName = (req) => (isHttps(req) ? "__Host-pfa_session" : "pfa_session");
  const tokenOf = (req) => { const c = cookies(req); return c["__Host-pfa_session"] || c.pfa_session || null; };
  const accountFor = (req) => accounts.sessions.account(tokenOf(req));

  // Every request that changes something must come from this app's own page. A form or script on
  // another site cannot send the Origin header of this one.
  const originOk = (req) => origins.includes(String(req.headers.origin || ""));

  function startSession(req, res, account, remember, deviceVerified = false) {
    accounts.sessions.end(tokenOf(req));
    const token = accounts.sessions.create(account.id, remember ? LONG_SESSION : SHORT_SESSION, deviceVerified);
    res.setHeader("Set-Cookie", cookie(cookieName(req), token, { secure: isHttps(req), maxAge: remember ? LONG_SESSION / 1000 : null }));
  }
  const clearSession = (req, res) => res.setHeader("Set-Cookie", cookie(cookieName(req), "", { secure: isHttps(req), maxAge: 0 }));

  function findOrCreate(email, intent) {
    const found = accounts.byEmail(email);
    if (found) return { account: found, created: false };
    return intent === "signup" ? { account: accounts.create(email), created: true } : { account: null, created: false };
  }
  const describe = (a) => ({
    id: a.id, credentialIds: accounts.passkeys.list(a.id).map((p) => p.id), email: a.email, since: new Date(a.created_at).toISOString().slice(0, 10),
    passkeys: accounts.passkeys.list(a.id).length, google: Boolean(a.google_sub), recovery: Boolean(a.recovery_fp),
    sessions: accounts.sessions.count(a.id),
  });
  function aiState(a) {
    const u = accounts.usage.get(a.id, monthOf());
    const estimated = u.unknown_calls && !u.cost_micro ? null : u.cost_micro / 1e6;
    return { month: monthOf(), estimated_usd: estimated, spent_usd: estimated, unavailable_calls: u.unknown_calls, calls: u.calls, estimate_complete: u.unknown_calls === 0, calls_this_hour: limits.aiPerAccount.count(a.id), hourly_limit: ai.hourly };
  }
  function status(req) {
    const a = accountFor(req);
    return { enabled: true, email: emailMode, google: Boolean(google), passkey: true, signedIn: Boolean(a), deviceVerified: Boolean(a && accounts.sessions.verified(tokenOf(req))), account: a ? describe(a) : null, ai: a ? aiState(a) : null };
  }

  // ---------- email code ----------
  async function emailStart(req, res) {
    const body = await readJson(req);
    const email = String(body?.email || "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return json(res, 400, { code: "EMAIL", message: "That doesn't look like an email address." });
    const intent = entryIntent(body?.intent);
    if (!intent) return json(res, 400, { code: "INTENT", message: "Choose Sign in or Create account and try again." });
    if (emailMode === "off") return json(res, 503, { code: "NO_EMAIL", message: "Email sign-in isn't connected on this server yet. Use a passkey or Google." });
    if (!limits.sendGap.allow(email)) return json(res, 429, { code: "SLOW_DOWN", message: `A code was just sent. You can ask for another in ${limits.sendGap.wait(email)} seconds.`, retry_after: limits.sendGap.wait(email) });
    if (!limits.sendPerEmail.allow(email) || !limits.sendPerIp.allow(clientIp(req))) return json(res, 429, { code: "SLOW_DOWN", message: "Too many codes asked for. Try again in an hour." });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    codes.drop(email);
    try {
      const purpose = intent === "signup" ? "account creation" : "sign-in";
      await mail.send(email, `Your Hodos ${purpose} code`, `Your ${purpose} code is ${code}. It works for 10 minutes, once.\nIf you didn't ask for it, ignore this email.`);
    } catch {
      return json(res, 503, { code: "EMAIL_FAILED", message: "We couldn't send a code. Try again in a minute, or use Google or a passkey.", retryable: true });
    }
    // A failed or pending send must never leave a code that can sign anyone in.
    codes.put(email, { hash: codeHash(email, code, intent), intent, tries: 0 });
    // The same answer whether or not the address has an account, so nobody can use this to find out.
    json(res, 200, { ok: true, resend_after: resend });
  }
  async function emailVerify(req, res) {
    const body = await readJson(req);
    const email = String(body?.email || "").trim().toLowerCase(), code = String(body?.code || "").replace(/\D/g, "");
    if (!limits.signinPerIp.allow(clientIp(req))) return json(res, 429, { code: "SLOW_DOWN", message: "Too many tries. Wait a few minutes." });
    const entry = codes.peek(email);
    if (!entry) return json(res, 400, { code: "CODE_EXPIRED", message: "That code has expired or was never sent. Ask for a new one." });
    if (!same(entry.hash, codeHash(email, code, entry.intent))) {
      entry.tries += 1;
      if (entry.tries >= CODE_TRIES) { codes.drop(email); return json(res, 400, { code: "CODE_EXPIRED", message: "Too many wrong codes. Ask for a new one." }); }
      return json(res, 400, { code: "CODE_WRONG", message: `That code isn't right. ${CODE_TRIES - entry.tries} tries left.`, tries_left: CODE_TRIES - entry.tries });
    }
    const intent = entryIntent(body?.intent);
    if (!intent) return json(res, 400, { code: "INTENT", message: "Choose Sign in or Create account and try again." });
    if (intent !== entry.intent) return json(res, 400, { code: "CODE_PURPOSE", message: "Use this code on the page where you requested it, or ask for a new code." });
    codes.drop(email);
    const { account, created } = findOrCreate(email, intent);
    if (!account) return json(res, 409, { code: "ACCOUNT_NOT_FOUND", message: "That email has no Hodos account yet. Choose Create account to get started." });
    startSession(req, res, account, body.remember !== false);
    json(res, 200, { ok: true, created, account: describe(account) });
  }
  // ---------- passkeys ----------
  async function passkeySigninOptions(_req, res) {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
    const flow = b64url(crypto.randomBytes(16));
    flows.put(flow, { kind: "signin", challenge: options.challenge });
    json(res, 200, { flow, options });
  }
  async function deviceOptions(req, res, account) {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: accounts.passkeys.list(account.id).map((p) => ({ id: p.id })) });
    if (!options.allowCredentials.length) return json(res, 409, { code: "ENROLL_DEVICE", message: "Set up device access first." });
    const flow = b64url(crypto.randomBytes(16));
    const session = tokenOf(req);
    flows.put(flow, { kind: "device", challenge: options.challenge, accountId: account.id, sessionHash: sha256(session), remember: accounts.sessions.remembered(session) });
    json(res, 200, { flow, options });
  }
  async function passkeySignin(req, res, expectedAccount = null) {
    const body = await readJson(req);
    if (!limits.signinPerIp.allow(clientIp(req))) return json(res, 429, { code: "SLOW_DOWN", message: "Too many tries. Wait a few minutes." });
    const f = flows.take(String(body?.flow || ""));
    const kind = expectedAccount ? "device" : "signin";
    if (!f || f.kind !== kind || (expectedAccount && (f.accountId !== expectedAccount.id || f.sessionHash !== sha256(tokenOf(req))))) return json(res, 400, { code: "EXPIRED", message: "That took too long. Try again." });
    const cred = accounts.passkeys.get(String(body.response?.id || ""));
    if (!cred || (expectedAccount && cred.account_id !== expectedAccount.id)) return json(res, 401, { code: "UNKNOWN_PASSKEY", message: "That passkey does not belong to the selected account." });
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: f.challenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports || "[]") } });
    } catch { v = null; }
    if (!v?.verified) return json(res, 401, { code: "PASSKEY_FAILED", message: "That passkey couldn't be checked. Try again." });
    accounts.passkeys.used(cred.id, v.authenticationInfo.newCounter);
    const account = accounts.byId(cred.account_id);
    startSession(req, res, account, expectedAccount ? f.remember : body.remember !== false, true);
    json(res, 200, { ok: true, created: false, account: describe(account) });
  }
  async function passkeyAddOptions(_req, res, account) {
    const existing = accounts.passkeys.list(account.id).map((p) => {
      let transports = [];
      try { const saved = JSON.parse(p.transports || "[]"); if (Array.isArray(saved)) transports = saved; }
      catch { /* A damaged hint must not prevent adding another passkey. */ }
      return { id: p.id, transports };
    });
    const options = await generateRegistrationOptions({
      rpName: "Hodos", rpID, userName: account.email, userDisplayName: account.email,
      userID: new TextEncoder().encode(account.id), attestationType: "none", excludeCredentials: existing,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const flow = b64url(crypto.randomBytes(16));
    flows.put(flow, { kind: "add", challenge: options.challenge, accountId: account.id, sessionHash: sha256(tokenOf(_req)), remember: accounts.sessions.remembered(tokenOf(_req)) });
    json(res, 200, { flow, options });
  }
  async function passkeyAdd(req, res, account) {
    const body = await readJson(req);
    const f = flows.take(String(body?.flow || ""));
    if (!f || f.kind !== "add" || f.accountId !== account.id || f.sessionHash !== sha256(tokenOf(req))) return json(res, 400, { code: "EXPIRED", message: "That took too long. Try again." });
    let v;
    try { v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: f.challenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true }); } catch { v = null; }
    if (!v?.verified) return json(res, 400, { code: "PASSKEY_FAILED", message: "That passkey couldn't be checked. Try again." });
    const c = v.registrationInfo.credential;
    if (accounts.passkeys.get(c.id)) return json(res, 409, { code: "EXISTS", message: "That passkey is already linked." });
    accounts.passkeys.add({ id: c.id, accountId: account.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports });
    startSession(req, res, account, f.remember, true);
    json(res, 200, { ok: true, account: describe(accounts.byId(account.id)) });
  }

  // ---------- the recovery key ----------
  // The device works two keys out of the 12 words. One unlocks the data and never leaves the device.
  // The other is the "proof" below; the server keeps only its fingerprint, set while signed in.
  async function recoverySet(req, res, account) {
    const body = await readJson(req);
    const fp = String(body?.fingerprint || "");
    if (!HEX64.test(fp)) return json(res, 400, { code: "INVALID_REQUEST", message: "fingerprint: 64 hex characters" });
    accounts.setRecovery(account.id, fp);
    json(res, 200, { ok: true });
  }
  async function recoverySignin(req, res) {
    const body = await readJson(req);
    const email = String(body?.email || "").trim().toLowerCase(), proof = String(body?.proof || "");
    if (!limits.recoverPerIp.allow(clientIp(req)) || !limits.recoverPerEmail.allow(email)) return json(res, 429, { code: "SLOW_DOWN", message: "Too many tries. Try again in an hour." });
    const account = accounts.byEmail(email);
    if (!account?.recovery_fp || !HEX64.test(proof) || !same(sha256(proof), account.recovery_fp)) return json(res, 401, { code: "WRONG", message: "That email and those 12 words don't match an account." });
    // Temporary emergency access must not extend an existing short session into a remembered one.
    const sameAccount = accountFor(req)?.id === account.id;
    const remember = body.remember !== false && (!sameAccount || accounts.sessions.remembered(tokenOf(req)));
    startSession(req, res, account, remember, true);
    json(res, 200, { ok: true, created: false, account: describe(account) });
  }

  // ---------- Google ----------
  // The whole exchange runs through this server, so the page loads no script from Google and the
  // browser rules stay strict. The server asks Google for the email address and nothing else.
  function googleStart(req, res, url) {
    if (!google) return json(res, 404, { code: "NO_GOOGLE", message: "Google sign-in isn't set up on this server." });
    const intent = entryIntent(url.searchParams.get("intent") ?? undefined);
    if (!intent) return json(res, 400, { code: "INTENT", message: "Choose Sign in or Create account and try again." });
    const state = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32)), nonce = b64url(crypto.randomBytes(16));
    googleFlows.put(state, { verifier, nonce, intent, remember: url.searchParams.get("remember") !== "0" });
    const q = new URLSearchParams({ client_id: google.id, redirect_uri: `${origins[0]}/api/auth/google/callback`, response_type: "code", scope: "openid email", state, nonce, prompt: "select_account",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    // Lax, not Strict: this cookie must come back on the return trip from Google's page.
    res.writeHead(302, { Location: `${google.authUrl}?${q}`, "Set-Cookie": cookie("pfa_oauth", state, { sameSite: "Lax", secure: isHttps(req), maxAge: 600, path: "/api/auth/google" }), "Cache-Control": "no-store" });
    res.end();
  }
  async function googleCallback(req, res, url) {
    const back = (hash) => { res.writeHead(302, { Location: `/#/${hash}`, "Cache-Control": "no-store", "Set-Cookie": [cookie("pfa_oauth", "", { sameSite: "Lax", secure: isHttps(req), maxAge: 0, path: "/api/auth/google" }), ...[].concat(res.getHeader("Set-Cookie") || [])] }); res.end(); };
    const state = url.searchParams.get("state") || "";
    // The browser's cookie is checked before the hand-off is used up, so a stranger who learns the
    // state cannot spend it for the real user.
    const f = google && state && cookies(req).pfa_oauth === state ? googleFlows.take(state) : null;
    const page = f?.intent === "signup" ? "signup" : "signin";
    if (!f || url.searchParams.get("error") || !url.searchParams.get("code")) return back(`${page}?error=google`);
    let claims = null;
    try {
      const r = await fetch(google.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: google.id, client_secret: google.secret, redirect_uri: `${origins[0]}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: f.verifier }) });
      const t = r.ok ? await r.json() : null;
      // Received straight from Google's token endpoint over HTTPS, so the token's own signature need
      // not be checked (OpenID Connect Core §3.1.3.7); every claim that matters still is.
      claims = t?.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString("utf8")) : null;
    } catch { claims = null; }
    const ok = claims && ["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) && (claims.aud === google.id || (Array.isArray(claims.aud) && claims.aud.includes(google.id)))
      && claims.exp * 1000 > Date.now() && claims.nonce === f.nonce && claims.email_verified === true && EMAIL.test(String(claims.email || "")) && claims.sub;
    if (!ok) return back(`${page}?error=google`);
    const email = String(claims.email).toLowerCase();
    let account = accounts.byGoogle(String(claims.sub));
    if (!account) {
      account = findOrCreate(email, f.intent).account;
      if (!account) return back("signin?error=account_missing");
      accounts.linkGoogle(account.id, String(claims.sub));
    }
    startSession(req, res, account, f.remember);
    back("signin?done=google");
  }

  // ---------- the AI connection's guard ----------
  // Signed in, enrolled device, expected owner and technical hourly protection. No dollar allowance.
  const accountChanged = (req, a, required = false) => {
    const expected = req.headers["x-hodos-account"];
    if (expected === undefined) return required;
    return expected !== a.id;
  };
  const changedAccountError = { code: "ACCOUNT_CHANGED", message: "The account changed in another tab. Sign in again.", retryable: false };
  function aiGuard(req) {
    const a = accountFor(req);
    if (!a) return { status: 401, body: { code: "SIGN_IN", message: "Sign in to use AI. Every form still works without it.", retryable: false } };
    if (accountChanged(req, a, true)) return { status: 403, body: changedAccountError };
    if (!accounts.sessions.verified(tokenOf(req))) return { status: 403, body: { code: "DEVICE_REQUIRED", message: "Approve access with your enrolled device first.", retryable: false } };
    if (!limits.aiPerAccount.allow(a.id)) return { status: 429, body: { code: "RATE_LIMIT", message: `That's ${ai.hourly} AI requests this hour. Try again in ${Math.ceil(limits.aiPerAccount.wait(a.id) / 60)} minutes.`, retryable: false } };
    return { account: a };
  }
  const aiCharge = (account, model, usage) => accounts.usage.add(account.id, monthOf(), costMicro(model, usage));

  // ---------- routes ----------
  async function handle(req, res, url) {
    const p = url.pathname, post = req.method === "POST";
    if (p === "/api/auth/status") return json(res, 200, status(req));
    if (p === "/api/auth/google/start") return googleStart(req, res, url);
    if (p === "/api/auth/google/callback") return googleCallback(req, res, url);
    if (!post) return json(res, 405, { code: "METHOD" });
    if (p === "/api/auth/email/start") return emailStart(req, res);
    if (p === "/api/auth/email/verify") return emailVerify(req, res);
    if (p === "/api/auth/passkey/options") return passkeySigninOptions(req, res);
    if (p === "/api/auth/passkey/verify") return passkeySignin(req, res);
    if (p === "/api/auth/recovery") return recoverySignin(req, res);
    const currentAccount = accountFor(req);
    if (currentAccount && accountChanged(req, currentAccount, p.startsWith("/api/account/"))) return json(res, 403, changedAccountError);
    if (p === "/api/auth/signout") { accounts.sessions.end(tokenOf(req)); clearSession(req, res); return json(res, 200, { ok: true }); }
    const account = accountFor(req);
    if (!account) return json(res, 401, { code: "SIGN_IN", message: "Sign in first." });
    if (p === "/api/auth/signout-all") { accounts.sessions.endAll(account.id); clearSession(req, res); return json(res, 200, { ok: true }); }
    if (p === "/api/account/device/options") return deviceOptions(req, res, account);
    if (p === "/api/account/device/verify") return passkeySignin(req, res, account);
    const verified = accounts.sessions.verified(tokenOf(req));
    const firstEnrollment = accounts.passkeys.list(account.id).length === 0;
    if (p === "/api/account/passkeys/options" || p === "/api/account/passkeys/verify") {
      if (!verified && !firstEnrollment) return json(res, 403, { code: "DEVICE_REQUIRED", message: "Approve access with an existing device before adding another." });
      return p.endsWith("options") ? passkeyAddOptions(req, res, account) : passkeyAdd(req, res, account);
    }
    if (!verified) return json(res, 403, { code: "DEVICE_REQUIRED", message: "Approve access with your enrolled device first." });
    if (p === "/api/account/recovery") return recoverySet(req, res, account);
    if (p === "/api/account/delete") {
      const body = await readJson(req);
      if (String(body?.confirm || "").trim().toLowerCase() !== account.email) return json(res, 400, { code: "CONFIRM", message: "Type your email address exactly to confirm." });
      accounts.remove(account.id); clearSession(req, res);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { code: "NOT_FOUND" });
  }

  setInterval(() => accounts.sessions.sweep(), HOUR).unref();
  return { handle, originOk, accountFor, aiGuard, aiCharge, aiState, config: { origins, rpID, emailMode, google: Boolean(google) } };
}

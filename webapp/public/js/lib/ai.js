// AI layer client. Every call: named task, schema, tier. Structured output only. Code validates.
import { store } from "./store.js";
import { taskDefinition, LIMITS, validateInput, validateOutput } from "./assistant-tasks.js";
import { validateProtectedContext } from "./assistant-privacy.js";

import { apiUrl } from "./api.js";
import * as account from "./account.js";
import * as vault from "./vault.js";
import { esc } from "./ui.js";

let serverStatus = null;
export async function refreshStatus() {
  try { const r = await fetch(apiUrl("api/ai/status")); serverStatus = r.ok ? await r.json() : { configured: false }; } catch { serverStatus = { configured: false }; }
  return serverStatus;
}
export const serverConfigured = () => Boolean(serverStatus?.configured);
// The server asks who is calling before it spends anything (security note §4).
export const needsSignIn = () => Boolean(serverStatus?.sign_in_required) && !account.state.signedIn;
// Consent alone. The bottom-bar entry follows this, not whether the server happens to hold a key.
export function consented() { return Boolean(store.one("profile")?.consent?.ai_provider); }
export function enabled() {
  const p = store.one("profile");
  return Boolean(p?.consent?.ai_provider) && serverConfigured() && !needsSignIn();
}
// Said to the person using the app, so in their words. Whoever runs the server reads its own window,
// which says what is missing there.
export function whyDisabled() {
  const p = store.one("profile");
  if (!p?.consent?.ai_provider) return "AI help is off. You can turn it on in Settings.";
  if (!serverConfigured()) return "AI help isn't available on this copy of the app.";
  if (needsSignIn()) return "Sign in to use AI help.";
  return null;
}
// The same, as a line of a page, with a way to fix it where there is one.
export function offHtml() {
  const why = whyDisabled();
  if (!why) return "";
  const fix = !consented() ? ' <a href="#/settings?enable-ai=1">Enable Allow AI help in Settings</a>' : serverConfigured() && needsSignIn() ? ' <a href="#/signin">Sign in</a>' : "";
  return `<p class="muted">${esc(why)}${fix} Every form still works without it.</p>`;
}

export class AiError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

// ---------- confidentiality: scrubbed before anything leaves the device ----------
// Every piece of text sent to an AI has personal numbers masked, whichever feature built it. The model
// needs amounts, dates and shop names; it never needs a phone number, an email address, a card, an
// account or an ID number. Ids the model hands back (lever ids, subscription ids) are left alone,
// because code checks them on the way back. A photo cannot be scrubbed; it goes as it is.
const COMPACT_DATE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
const MASKS = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b[STFGM]\d{7}[A-Z]\b/gi, "[id]"],                                  // Singapore NRIC / FIN
  [/\b\d{17}[\dX]\b/gi, "[id]"],                                         // mainland China resident ID
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]"],                                // 13 to 19 digits, grouped like a card
  [/\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g, "[phone]"], // nine digits and more, international
  [/\b\d{4}[ -]?\d{4}\b/g, (m) => (COMPACT_DATE.test(m) ? m : "[phone]")], // eight digits: 9123 4567, but not 20260901
  [/\b\d{9,}\b(?![.,]\d)/g, "[number]"],                                 // any other long run: accounts, references
];
// Characters that can hide or reorder text on screen, and control characters, carry no meaning for a
// shop name and are a favourite of injected instructions. Every string is also capped in length.
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
export const MAX_FIELD = 1000;
export function scrubText(s) {
  let t = String(s).replace(HIDDEN, "");
  if (t.length > MAX_FIELD) t = t.slice(0, MAX_FIELD);
  for (const [re, to] of MASKS) t = t.replace(re, to);
  return t;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_ID_KEY = /^(?:id|ids|key)$|_ids?$/;
export function scrub(value, key = "") {
  if (typeof value === "string") return IS_ID_KEY.test(key) || UUID.test(value) ? value.replace(HIDDEN, "") : scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === "object") { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k); return out; }
  return value;
}

// Fallback ladder: call → validate → retry once → manual (throw).
export async function call(task, { tier, system, input, images, documents, schema, validate, max_tokens, signal } = {}) {
  if (!enabled()) throw new AiError("AI_FAILED", whyDisabled(), false);
  if (taskDefinition(task)) return callAssistant(task, { input, images, documents, validate, signal });
  const revision = vault.accessRevision(), owner = vault.ownerId();
  const checkAccess = () => { signal?.throwIfAborted(); if (revision !== vault.accessRevision() || owner !== vault.ownerId()) throw new AiError("ACCOUNT_CHANGED", "Access changed while AI was working. Nothing was saved.", false); };
  input = scrub(input);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    checkAccess();
    let res;
    try {
      res = await fetch(apiUrl("api/ai"), { method: "POST", headers: { "Content-Type": "application/json", "X-Hodos-Account": owner }, body: JSON.stringify({ task, tier, system, input, images, schema, max_tokens }), signal });
    } catch {
      checkAccess();
      throw new AiError("OFFLINE", "No connection. Manual entry still works.", true);
    }
    checkAccess();
    const data = await res.json();
    checkAccess();
    if (!res.ok) {
      if (data.code === "SIGN_IN" || data.code === "ACCOUNT_CHANGED") account.refresh();
      if (data.code === "AI_SCHEMA" && attempt === 0) { lastErr = new AiError(data.code, data.message, true); continue; }
      throw new AiError(data.code || "AI_FAILED", data.message || "AI could not read this", Boolean(data.retryable));
    }
    const problem = validate ? validate(data.output) : (checkSchema(data.output, schema) ? null : "schema mismatch");
    if (!problem) return data.output;
    lastErr = new AiError("AI_SCHEMA", `AI output rejected: ${problem}`, true);
  }
  throw lastErr;
}

// Assistant alone preserves explicitly prepared raw-user fields and has no hidden retry/fallback.
async function callAssistant(task, { input, images, documents, validate, signal }) {
  const problem = validateInput(task, input) || (input?.context != null ? validateProtectedContext(input.context) : null);
  if (problem) throw new AiError("INVALID_REQUEST", problem, false);
  const revision = vault.accessRevision(), owner = vault.ownerId();
  const timeout = AbortSignal.timeout(LIMITS.timeoutMs);
  const pendingSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const checkAccess = () => {
    signal?.throwIfAborted();
    if (revision !== vault.accessRevision() || owner !== vault.ownerId() || !enabled()) throw new AiError("ACCOUNT_CHANGED", "Access or AI permission changed. Nothing was saved.", false);
  };
  checkAccess();
  let response;
  try {
    response = await fetch(apiUrl("api/ai"), { method: "POST", headers: { "Content-Type": "application/json", "X-Hodos-Account": owner }, body: JSON.stringify({ task, tier: "strong", input, images, documents }), signal: pendingSignal });
  } catch {
    checkAccess();
    if (timeout.aborted) throw new AiError("AI_TIMEOUT", "AI timed out. Retry this step or use the normal form.", true);
    throw new AiError("OFFLINE", "No connection. Retry or use the normal form.", true);
  }
  checkAccess();
  let result;
  try { result = await response.json(); }
  catch { throw new AiError("AI_SCHEMA", "The AI reply could not be read. Retry or use the normal form.", true); }
  checkAccess();
  if (!response.ok) {
    if (["SIGN_IN", "ACCOUNT_CHANGED", "DEVICE_REQUIRED"].includes(result.code)) account.refresh();
    throw new AiError(result.code || "AI_FAILED", result.message || "AI could not complete this request.", Boolean(result.retryable));
  }
  let invalid = validateOutput(task, result.output);
  if (!invalid && validate) invalid = validate(result.output, input);
  if (invalid) throw new AiError("AI_SCHEMA", "The AI reply was rejected. Retry or use the normal form.", true);
  return result.output;
}

// Small JSON-schema checker: types, required, enums, nullable via ["string","null"].
export function checkSchema(value, schema) {
  if (!schema) return true;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  if (value === null) return !types || types.includes("null");
  if (types) {
    const t = Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
    if (!ok) return false;
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object" || schema.properties) {
    for (const k of schema.required || []) if (!(k in value)) return false;
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value && !checkSchema(value[k], sub)) return false;
  }
  if (schema.items && Array.isArray(value)) for (const v of value) if (!checkSchema(v, schema.items)) return false;
  return true;
}

// Principle 4: "should" refused in AI prose.
const FORBIDDEN = /\b(should|must|need to|have to|ought to)\b/i;
export const hasOrder = (text) => FORBIDDEN.test(text || "");

// Principle 3: every digit string in prose must exist in the input the model saw.
export function digitsNotInInput(prose, input) {
  const inputStr = JSON.stringify(input);
  const inputNums = new Set((inputStr.match(/\d[\d,]*\.?\d*/g) || []).map(norm));
  const bad = [];
  for (const n of prose.match(/\d[\d,]*\.?\d*/g) || []) {
    if (!inputNums.has(norm(n))) bad.push(n);
  }
  return bad;
}
const norm = (s) => s.replace(/,/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

// Prompt injection's likeliest payload is a way to reach someone: a link, a site, an email address,
// a phone number. AI words may carry none the app did not send. A shop called Amazon.com that the
// app sent is fine; a site the model came up with is not.
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;
const DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|sg|cn|hk|me|app|xyz|info|biz|ly|gl|to|uk|us)\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
export function contactNotInInput(prose, input) {
  if (LINK.test(prose)) return "a link";
  if (EMAIL.test(prose)) return "an email address";
  const sent = JSON.stringify(input).toLowerCase();
  for (const d of prose.match(DOMAIN) || []) if (!sent.includes(d.toLowerCase())) return `a web address (${d})`;
  if (scrubText(prose).includes("[phone]")) return "a phone number";
  return null;
}

export function validateProse(prose, input) {
  if (typeof prose !== "string") return "prose missing";
  if (hasOrder(prose)) return "contains an order word (should/must)";
  const contact = contactNotInInput(prose, input);
  if (contact) return `contains ${contact}`;
  const bad = digitsNotInInput(prose, input);
  if (bad.length) return `numbers not in input: ${bad.slice(0, 3).join(", ")}`;
  return null;
}

export async function fileToImage(file, { signal } = {}) {
  signal?.throwIfAborted();
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    const finish = (error, value) => { signal?.removeEventListener("abort", cancel); if (error) rej(error); else res(value); };
    const cancel = () => { r.abort(); finish(new DOMException("Image read cancelled", "AbortError")); };
    r.onload = () => finish(null, r.result.split(",")[1]);
    r.onerror = () => finish(r.error || new Error("Image could not be read."));
    r.onabort = () => finish(new DOMException("Image read cancelled", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    try { r.readAsDataURL(file); } catch (error) { finish(error); }
  });
  signal?.throwIfAborted();
  return { media_type: file.type || "image/jpeg", data };
}

export async function fileToText(file, { signal } = {}) {
  signal?.throwIfAborted();
  const text = await new Promise((res, rej) => {
    const r = new FileReader();
    const finish = (error, value) => { signal?.removeEventListener("abort", cancel); if (error) rej(error); else res(value); };
    const cancel = () => { r.abort(); finish(new DOMException("File read cancelled", "AbortError")); };
    r.onload = () => finish(null, String(r.result));
    r.onerror = () => finish(r.error || new Error("File could not be read."));
    r.onabort = () => finish(new DOMException("File read cancelled", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    try { r.readAsText(file); } catch (error) { finish(error); }
  });
  signal?.throwIfAborted();
  return text;
}

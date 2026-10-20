// The account, as this device sees it. design/2026-09-19-security.md §1.
// The server knows an email address and how to recognise its owner; it never knows anything about
// money. Passkey access uses one device approval for server identity and local decryption.
// Google/email identity alone must be followed by account-owned device approval.
import { apiUrl } from "./api.js";
import * as vault from "./vault.js";
import { session } from "./session.js";

// server: false when no server answers (a static copy, or offline). enabled: false when the server
// runs with sign-in off.
export const state = { server: false, enabled: false, email: "off", google: false, signedIn: false, deviceVerified: false, account: null, ai: null };

async function call(path, body) {
  let r;
  try { r = await fetch(apiUrl(path), body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(state.account?.id ? { "X-Hodos-Account": state.account.id } : {}) }, body: JSON.stringify(body) }); }
  catch { throw Object.assign(new Error("No connection to the app's server. Try again when you are online."), { code: "OFFLINE" }); }
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data?.message || "Something went wrong. Try again."), { code: data?.code || "FAILED", data });
  return data;
}

export async function refresh({ detectChange = true } = {}) {
  const previous = state.account?.id;
  try {
    const s = await call("api/auth/status");
    Object.assign(state, { server: true, enabled: Boolean(s.enabled), email: s.email || "off", google: Boolean(s.google), signedIn: Boolean(s.signedIn), deviceVerified: Boolean(s.deviceVerified), account: s.account || null, ai: s.ai || null });
  } catch { Object.assign(state, { server: false, enabled: false, signedIn: false, deviceVerified: false, account: null, ai: null }); }
  if (detectChange && state.server && state.enabled && previous && previous !== state.account?.id) {
    if (session.accountChanged) await session.accountChanged();
    else await vault.lock();
  }
  return state;
}
// Sign-in is asked for only where there is a server that does it. A static copy of the app has none,
// and works on this device alone.
export const needed = () => state.server && state.enabled && !state.signedIn;
const after = async (r) => { await refresh(); return r; };

export const startEmail = (email, intent = "signin") => call("api/auth/email/start", { email, intent });
export const verifyEmail = (email, code, remember, intent = "signin") => call("api/auth/email/verify", { email, code, remember, intent }).then(after);
export const googleUrl = (remember, intent = "signin") => apiUrl(`api/auth/google/start?${new URLSearchParams({ remember: remember ? "1" : "0", intent })}`);
let entryRevision = 0;
function approvalGuard() {
  const entry = entryRevision, revision = vault.accessRevision();
  return () => {
    if (entry !== entryRevision || revision !== vault.accessRevision()) throw new vault.VaultError("CANCELLED", "Access changed while approval was in progress. Please try again.");
  };
}
const leave = async (r) => { await refresh({ detectChange: false }); await session.accountChanged(); return r; };
const endAccess = async (path, body) => {
  entryRevision++;
  session.signalAccess?.(null);
  // Protect local records immediately, even if ending the server session later fails/offline.
  await session.lockNow?.();
  return leave(await call(path, body));
};
export const signOut = () => endAccess("api/auth/signout", {});
export const signOutEverywhere = () => endAccess("api/auth/signout-all", {});
export const deleteAccount = (confirm) => endAccess("api/account/delete", { confirm });

// ---------- passkeys ----------
// The server speaks WebAuthn's JSON; the browser wants bytes. Converted by hand, so what is sent is
// exactly what is listed here. In particular the secret a passkey releases for the app lock (the PRF
// result) is never sent: the extension results go as an empty object.
const toBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const toB64u = (buf) => { const b = new Uint8Array(buf); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
function creationOptions(o) {
  return { ...o, challenge: toBytes(o.challenge), user: { ...o.user, id: toBytes(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })) };
}
function requestOptions(o) {
  return { ...o, challenge: toBytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })) };
}
const registrationJson = (c) => ({ id: c.id, rawId: toB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined, clientExtensionResults: {},
  response: { clientDataJSON: toB64u(c.response.clientDataJSON), attestationObject: toB64u(c.response.attestationObject), transports: c.response.getTransports?.() || [] } });
const assertionJson = (c) => ({ id: c.id, rawId: toB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined, clientExtensionResults: {},
  response: { clientDataJSON: toB64u(c.response.clientDataJSON), authenticatorData: toB64u(c.response.authenticatorData), signature: toB64u(c.response.signature), userHandle: c.response.userHandle ? toB64u(c.response.userHandle) : undefined } });

function withPrf(options, hints) {
  const publicKey = requestOptions(options);
  if (hints.length) {
    const serverIds = new Set((options.allowCredentials || []).map((c) => c.id));
    const usable = serverIds.size ? hints.filter((h) => serverIds.has(h.id)) : hints;
    if (!usable.length) throw new vault.VaultError("NONE", "No enrolled passkey can open this browser's records. Use another supported device or your recovery key.");
    // Ask only for credentials wrapping this local key, not a replaced/account-only credential.
    publicKey.allowCredentials = usable.map((h) => ({ type: "public-key", id: vault.fromB64url(h.id) }));
    publicKey.extensions = { prf: { evalByCredential: Object.fromEntries(usable.map((h) => [h.id, { first: h.salt }])) } };
  }
  return publicKey;
}
function secretFrom(cred, hint) {
  if (!hint) return null;
  const secret = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!secret || secret.byteLength !== 32) throw new vault.VaultError("NO_PRF", "This passkey cannot unlock encrypted records. Try a supported browser, device or security key.");
  return { passkeySecret: new Uint8Array(secret) };
}
export async function passkeySignIn(remember) {
  const check = approvalGuard();
  const hints = await vault.passkeyHints();
  const { flow, options } = await call("api/auth/passkey/options", {});
  const cred = await navigator.credentials.get({ publicKey: withPrf(options, hints) });
  check();
  const hint = hints.find((h) => h.id === cred.id), factor = secretFrom(cred, hint);
  try {
    const r = await after(await call("api/auth/passkey/verify", { flow, response: assertionJson(cred), remember }));
    check();
    if (hint && hint.owner !== r.account?.id) throw new vault.VaultError("OWNER", "That passkey does not belong to these local records.");
    await vault.selectOwner(r.account.id);
    if (factor) r.unlocked = { data: await vault.unlock(factor), factor };
    return r;
  } catch (e) { factor?.passkeySecret.fill(0); throw e; }
}
export async function unlockDevice() {
  const check = approvalGuard();
  if (!state.server || !state.enabled) {
    const factor = await vault.passkeyFactor();
    try { check(); return { data: await vault.unlock(factor), factor }; }
    catch (e) { factor.passkeySecret.fill(0); throw e; }
  }
  if (!state.signedIn || state.account?.id !== vault.ownerId()) throw new vault.VaultError("OWNER", "Sign in to the account that owns these records first.");
  const hints = (await vault.passkeyHints()).filter((h) => h.owner === state.account.id);
  const { flow, options } = await call("api/account/device/options", {});
  const cred = await navigator.credentials.get({ publicKey: withPrf(options, hints) });
  check();
  const factor = secretFrom(cred, hints.find((h) => h.id === cred.id));
  if (!factor) throw new vault.VaultError("NONE", "That device has no key for the records in this browser.");
  try {
    await after(await call("api/account/device/verify", { flow, response: assertionJson(cred) }));
    check();
    return { data: await vault.unlock(factor), factor };
  } catch (e) { factor.passkeySecret.fill(0); throw e; }
}
// Approve an existing account credential before first setup on an additional browser/device.
// This does not restore missing records or transfer their key.
export async function approveDevice() {
  const check = approvalGuard();
  const { flow, options } = await call("api/account/device/options", {});
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
  check();
  const r = await after(await call("api/account/device/verify", { flow, response: assertionJson(cred) }));
  check(); return r;
}
// One passkey for both jobs: the server's challenge makes it a way to sign in, and the vault asks it
// for the secret that unlocks this device. Signed out, it is made for the lock alone.
export async function newPasskey() {
  const check = approvalGuard();
  if (!state.signedIn) {
    const pk = await vault.registerPasskey();
    try { check(); return { pk, linked: false }; } catch (e) { pk.secret.fill(0); throw e; }
  }
  const { flow, options } = await call("api/account/passkeys/options", {});
  const pk = await vault.registerPasskey({ publicKey: creationOptions(options) });
  try {
    check();
    await call("api/account/passkeys/verify", { flow, response: registrationJson(pk.credential) });
    await refresh(); check();
  } catch (e) { pk.secret.fill(0); throw e; }
  return { pk, linked: true };
}

// ---------- the recovery key ----------
export async function linkRecovery(words) {
  if (!state.signedIn) return false;
  const check = approvalGuard();
  const { fingerprint } = await vault.recoveryProof(words);
  check(); await call("api/account/recovery", { fingerprint });
  await refresh(); check();
  return true;
}
export async function recoverySignIn(email, words, remember) {
  const { proof } = await vault.recoveryProof(words);
  return call("api/auth/recovery", { email, proof, remember }).then(after);
}

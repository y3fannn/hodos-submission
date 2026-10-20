// Browser-side orchestration with mocked credentials/fetch, not real provider compatibility.
import assert from "node:assert/strict";
import * as account from "../public/js/lib/account.js";
import * as vault from "../public/js/lib/vault.js";
import { store } from "../public/js/lib/store.js";
import { session } from "../public/js/lib/session.js";
import * as ai from "../public/js/lib/ai.js";
import { setupPage, lockPage, lockCard } from "../public/js/features/lock.js";
import { openAccounts } from "../accounts.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousFetch = globalThis.fetch, previousState = { ...account.state }, previousChanged = session.accountChanged, previousLock = session.lockNow;
const credDescriptor = Object.getOwnPropertyDescriptor(navigator, "credentials");
const publicKeyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
const snapshot = store.snapshot();
let checks = 0;
const ok = (c, name) => { assert.ok(c, name); checks++; };
const pk = { secret: crypto.getRandomValues(new Uint8Array(32)), credId: crypto.getRandomValues(new Uint8Array(32)), prfSalt: crypto.getRandomValues(new Uint8Array(32)) };
const credential = () => ({ id: vault.b64url(pk.credId), rawId: pk.credId.buffer, type: "public-key", response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer }, getClientExtensionResults: () => ({ prf: { results: { first: pk.secret.buffer.slice(0) } } }) });
let identity = { enabled: true, email: "resend", passkey: true, signedIn: false, deviceVerified: false, account: null };
const owner = { id: "account-A", email: "a@example.com", passkeys: 1, credentialIds: [vault.b64url(pk.credId)] };
let getCount = 0, verifyCount = 0, cancel = false, supported = true, changed = 0;
let holdApproval = null, approvalStarted = () => {};
const requests = [];
try {
  vault.useStorage(vault.memoryStorage()); await vault.selectOwner(owner.id);
  await assert.rejects(vault.create({ passkey: { ...pk, prfSalt: undefined } }), { code: "NO_PRF" }); checks++;
  ok(!(await vault.status()).exists, "a missing PRF salt cannot create an unusable vault");
  await vault.create({ passkey: pk }); await vault.confirmRecovery();
  vault.persist({ schema_version: 1, tables: { transactions: [{ merchant: "PRIVATE_RECORD", user_id: owner.id }] } }); await vault.lock();
  Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: class {} });
  Object.defineProperty(navigator, "credentials", { configurable: true, value: {
    async get({ publicKey }) {
      getCount++;
      if (cancel) throw new DOMException("cancelled", "NotAllowedError");
      ok(publicKey.userVerification === "required", "user verification is required");
      if (supported) {
        ok(publicKey.extensions.prf.evalByCredential[vault.b64url(pk.credId)].first.length === 32, "the stored credential-specific PRF salt is requested");
        ok(publicKey.allowCredentials.length === 1 && vault.b64url(publicKey.allowCredentials[0].id) === vault.b64url(pk.credId), "replaced/account-only credentials cannot be chosen instead of the local encryption credential");
      }
      if (holdApproval) { approvalStarted(); await holdApproval; }
      const cred = credential(); if (!supported) cred.getClientExtensionResults = () => ({});
      return cred;
    },
    async create() { return { ...credential(), getClientExtensionResults: () => ({ prf: { enabled: false } }) }; },
  } });
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ endpoint, body });
    let data = {};
    if (endpoint.endsWith("/status")) data = identity;
    else if (endpoint.endsWith("/options")) data = { flow: "flow", options: { challenge: vault.b64url(new Uint8Array(32)), userVerification: "required", allowCredentials: [{ id: "replaced-account-only-credential", type: "public-key" }, { id: vault.b64url(pk.credId), type: "public-key" }], user: { id: vault.b64url(new Uint8Array(16)), name: owner.email }, rp: { id: "localhost", name: "Hodos" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } };
    else if (endpoint.endsWith("/verify")) {
      verifyCount++;
      identity = { ...identity, signedIn: true, deviceVerified: !endpoint.includes("/email/"), account: owner };
      data = { ok: true, created: false, account: owner };
    } else if (endpoint.endsWith("/signout")) identity = { ...identity, signedIn: false, deviceVerified: false, account: null };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await account.refresh();
  let r = await account.passkeySignIn(true);
  ok(getCount === 1 && r.unlocked.data.tables.transactions[0].merchant === "PRIVATE_RECORD" && account.state.deviceVerified, "one approval signs in and decrypts local records");
  const sent = JSON.stringify(requests);
  ok(!sent.includes("PRIVATE_RECORD") && !sent.includes(vault.b64url(pk.secret)) && !sent.includes('"prf"'), "server requests contain no PRF outputs, encryption keys or records");
  ok(requests.find((r) => r.endpoint.endsWith("passkey/verify")).body.response.clientExtensionResults && Object.keys(requests.find((r) => r.endpoint.endsWith("passkey/verify")).body.response.clientExtensionResults).length === 0, "credential serialization strips extension results");
  r.unlocked.factor.passkeySecret.fill(0);
  await vault.lock(); identity = { ...identity, signedIn: false, deviceVerified: false, account: null }; await account.refresh();
  const before = verifyCount; cancel = true;
  await assert.rejects(account.passkeySignIn(true), { name: "NotAllowedError" }); checks++;
  ok(!vault.isUnlocked() && verifyCount === before, "cancelled approval creates neither session nor unlocked vault"); cancel = false;
  supported = false;
  await assert.rejects(account.passkeySignIn(true), { code: "NO_PRF" }); checks++;
  ok(!vault.isUnlocked() && verifyCount === before, "ordinary passkey support without PRF has no silent fallback"); supported = true;
  await account.verifyEmail(owner.email, "123456", false);
  ok(account.state.signedIn && !account.state.deviceVerified && !vault.isUnlocked(), "email checks identity but does not open records");
  const beforeGet = getCount; r = await account.unlockDevice();
  ok(getCount === beforeGet + 1 && account.state.deviceVerified && r.data.tables.transactions[0].merchant === "PRIVATE_RECORD", "email then one enrolled-device approval opens records");
  r.factor.passkeySecret.fill(0);
  store.open(r.data, vault.persist, owner.id);
  const row = store.insert("accounts", { name: "A", user_id: "account-B" });
  ok(row.user_id === owner.id, "rows cannot override the selected account owner");
  store.update("accounts", row.id, { user_id: "account-B" });
  ok(row.user_id === owner.id, "row updates cannot change account ownership");
  session.accountChanged = async () => { changed++; await vault.lock(); store.close(); await vault.selectOwner("local-device"); };
  await account.signOut();
  ok(changed === 1 && !vault.isUnlocked() && store.all("accounts").length === 0 && !account.state.signedIn, "sign-out drops keys and readable records immediately");
  assert.throws(() => store.insert("accounts", { name: "Late async write" }), /Unlock/); checks++;
  let resumeApproval;
  holdApproval = new Promise((r) => { resumeApproval = r; });
  const started = new Promise((r) => { approvalStarted = r; });
  const beforeLate = verifyCount, lateLogin = account.passkeySignIn(true);
  await started; await account.signOut(); holdApproval = null; resumeApproval();
  await assert.rejects(lateLogin, { code: "CANCELLED" }); checks++;
  ok(!vault.isUnlocked() && !account.state.signedIn && verifyCount === beforeLate, "a device prompt completed after sign-out cannot sign back in or reopen records");
  identity = { ...identity, signedIn: true, account: { ...owner, id: "account-B", passkeys: 0, credentialIds: [] } }; await account.refresh(); await vault.selectOwner("account-B");
  const beforeRegister = verifyCount;
  await assert.rejects(account.newPasskey(), { code: "NO_PRF" }); checks++;
  ok(!(await vault.status()).exists && verifyCount === beforeRegister, "unsupported enrollment never registers server access or creates a vault");
  const setupHtml = setupPage({ onCreated() {} }).html;
  ok(setupHtml.includes("Your records stay encrypted in this browser."), "device setup keeps the local encryption explanation");
  ok(!setupHtml.includes("There is no Hodos password or passphrase") && !setupHtml.includes("This is a new local setup") && !setupHtml.includes("Signing in does not transfer records"), "device setup omits redundant password and transfer explanations");
  ok(!setupHtml.includes('type="password"') && !lockPage({ status: { passkey: true }, onUnlocked() {} }).html.includes('data-form="pass"') && !lockCard().includes('data-lock="pass"'), "setup, unlock and Settings have no passphrase fields");
  await vault.selectOwner(owner.id);
  const opening = vault.unlock({ passkeySecret: pk.secret });
  await vault.lock();
  await assert.rejects(opening, { code: "CANCELLED" }); checks++;
  ok(!vault.isUnlocked(), "a late unlock cannot reopen records after lock/sign-out");
  const switching = vault.unlock({ passkeySecret: pk.secret });
  await vault.selectOwner("account-B");
  await assert.rejects(switching, { code: "CANCELLED" }); checks++;
  ok(!vault.isUnlocked() && !(await vault.status()).exists, "a late approval cannot open the newly selected account");
  const failedStorage = vault.memoryStorage(); failedStorage.put = async () => { throw new Error("Storage unavailable"); };
  vault.useStorage(failedStorage);
  await assert.rejects(vault.create({ passkey: pk }), /Storage unavailable/); checks++;
  ok(!vault.isUnlocked() && !(await vault.status()).exists, "failed initial storage leaves no opened or phantom vault");
  const writeFailure = vault.memoryStorage(); vault.useStorage(writeFailure); await vault.create({ passkey: pk });
  writeFailure.put = async () => { throw new Error("Storage unavailable"); };
  const failedWrite = vault.persist({ tables: { transactions: [{ merchant: "PRIVATE_RECORD" }] } });
  // The adapter now returns a truthful write promise. Observe rejection immediately as well as
  // the lock's flush failure; neither may be swallowed or left as an unhandled rejection.
  const rejectedWrite = assert.rejects(failedWrite, /Storage unavailable/);
  const log = console.error; console.error = () => {};
  try { await Promise.all([rejectedWrite, assert.rejects(vault.lock(), /Storage unavailable/)]); checks += 2; }
  finally { console.error = log; }
  ok(!vault.isUnlocked(), "even a failed final save cannot keep the encryption key open after lock");
  // The live app uses a parent-domain RP ID. Both registration follow-up and offline unlock
  // must keep it, rather than silently defaulting to the app subdomain.
  const credentials = navigator.credentials;
  credentials.create = async () => ({ ...credential(), getClientExtensionResults: () => ({ prf: { enabled: true } }) });
  credentials.get = async ({ publicKey }) => { ok(publicKey.rpId === "hodos.consulting", "local PRF requests preserve the registration's parent-domain RP ID"); return credential(); };
  const parentPk = await vault.registerPasskey({ publicKey: { rp: { id: "hodos.consulting", name: "Hodos" } } });
  vault.useStorage(vault.memoryStorage()); await vault.create({ passkey: parentPk }); await vault.lock();
  const parentFactor = await vault.passkeyFactor(); await vault.unlock(parentFactor); parentFactor.passkeySecret.fill(0); parentPk.secret.fill(0);
  ok(vault.isUnlocked() && (await vault.sealedRecord()).wraps.find(w => w.kind === "passkey").rp_id === "hodos.consulting", "offline access retains the live deployment's RP scope");
  store.open(null, vault.persist); store.insert("accounts", { name: "PRIVATE_RECORD" });
  account.state.account = { id: "local-device" }; account.state.signedIn = true;
  globalThis.fetch = async () => new Response(JSON.stringify({ enabled: true, signedIn: true, deviceVerified: true, account: { id: "account-B" } }));
  await account.refresh();
  ok(!vault.isUnlocked() && store.all("accounts").length === 0, "discovering another tab's account clears the previous account's key and readable records");
  await vault.unlock({ passkeySecret: pk.secret }); store.open(null, vault.persist); store.insert("accounts", { name: "PRIVATE_RECORD" });
  session.lockNow = async () => { await vault.lock(); store.close(); };
  globalThis.fetch = async () => { throw new Error("offline fixture"); };
  await assert.rejects(account.signOut(), { code: "OFFLINE" }); checks++;
  ok(!vault.isUnlocked() && store.all("accounts").length === 0, "offline sign-out still locks and clears local records before the failed server request");
  await vault.selectOwner(owner.id); store.open(null, vault.persist, owner.id);
  store.insert("profile", { consent: { ai_provider: true } });
  let finishAi, aiStarted;
  const startedAi = new Promise((r) => { aiStarted = r; }), reply = new Promise((r) => { finishAi = r; });
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith("/status")) return new Response(JSON.stringify({ configured: true }));
    ok(options.headers["X-Hodos-Account"] === owner.id, "AI requests carry the financial context's expected account");
    aiStarted(); return { ok: true, json: () => reply };
  };
  await ai.refreshStatus();
  const lateAi = ai.call("scope-test", { tier: "cheap", input: { source: "account A" }, schema: { type: "object" } });
  await startedAi; await vault.lock(); finishAi({ output: { ok: true } });
  await assert.rejects(lateAi, { code: "ACCOUNT_CHANGED" }); checks++;
  // Restore the default fixture configuration without a real network request.
  globalThis.fetch = async () => new Response(JSON.stringify({ configured: false })); await ai.refreshStatus();
} finally {
  globalThis.fetch = previousFetch; Object.assign(account.state, previousState); session.accountChanged = previousChanged; session.lockNow = previousLock;
  if (credDescriptor) Object.defineProperty(navigator, "credentials", credDescriptor); else delete navigator.credentials;
  if (publicKeyDescriptor) Object.defineProperty(globalThis, "PublicKeyCredential", publicKeyDescriptor); else delete globalThis.PublicKeyCredential;
  await vault.lock(); vault.useStorage(vault.memoryStorage()); store.open(snapshot);
}
// Existing server sessions are upgraded as identity-only, never silently trusted.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hodos-session-migration-"));
try {
  const filename = path.join(dir, "accounts.sqlite"), db = new DatabaseSync(filename);
  db.exec("CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  const tokenHash = crypto.randomUUID();
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(tokenHash, "existing", Date.now(), Date.now() + 60000); db.close();
  const accounts = openAccounts(filename); accounts.close();
  const updated = new DatabaseSync(filename);
  ok(updated.prepare("SELECT device_verified FROM sessions WHERE token_hash = ?").get(tokenHash).device_verified === 0, "old sessions require new device verification"); updated.close();
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${checks} device-access checks passed`);

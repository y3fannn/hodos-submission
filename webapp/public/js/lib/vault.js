// The vault: everything this app stores on the device, encrypted, and the ways it is unlocked.
// One random data key encrypts the store. It is wrapped by an encryption-capable passkey and the
// temporary recovery words. No app passphrase. Each verified account selects its own local vault.
// None of them, and nothing readable, leaves the device. design/2026-09-19-security.md §2 and §3.
import { WORDS } from "./words.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();

export class VaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- bytes ----------
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
function b64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- keys ----------
const aesKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
async function seal(key, bytes) {
  const iv = rand(12);
  return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)) };
}
async function unseal(key, box) {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct)));
}
// The recovery key and a passkey's secret are already random, so one step of HKDF is enough. Each
// use gets its own label, so the key that opens the data is never the key that opens a backup.
async function secretKey(secret, purpose) {
  const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("pfa-vault-v1"), info: enc.encode(purpose) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ---------- the recovery key: 12 words (BIP-39, 128 random bits and a 4-bit check) ----------
export async function entropyToWords(entropy) {
  const hash = new Uint8Array(await subtle.digest("SHA-256", entropy));
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, "0")).join("") + hash[0].toString(2).padStart(8, "0").slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
}
export const newRecoveryWords = () => entropyToWords(rand(16));
// Typing the first four letters of each word is enough: no two words in the list share them.
export function normaliseWords(input) {
  return (Array.isArray(input) ? input.join(" ") : String(input)).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
}
export async function wordsToEntropy(input) {
  const list = normaliseWords(input);
  if (list.length !== 12) throw new VaultError("WORDS", `The recovery key is 12 words; that was ${list.length}.`);
  const idx = list.map((w, i) => {
    let n = WORDS.indexOf(w);
    if (n < 0 && w.length >= 4) { const hits = WORDS.filter((x) => x.startsWith(w.slice(0, 4))); if (hits.length === 1) n = WORDS.indexOf(hits[0]); }
    if (n < 0) throw new VaultError("WORDS", `Word ${i + 1}, "${w}", is not in the list. Check the spelling.`);
    return n;
  });
  const bits = idx.map((n) => n.toString(2).padStart(11, "0")).join("");
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 16; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const hash = new Uint8Array(await subtle.digest("SHA-256", entropy));
  if (hash[0].toString(2).padStart(8, "0").slice(0, 4) !== bits.slice(128)) throw new VaultError("WORDS", "Those 12 words do not check out. One of them is wrong, or two are swapped.");
  return entropy;
}

// ---------- where the sealed record lives ----------
export const memoryStorage = () => {
  const rows = new Map(), copy = (x) => x ? structuredClone(x) : null;
  return { get: async (id) => copy(rows.get(id)), put: async (x, id) => { rows.set(id, copy(x)); }, del: async (id) => { rows.delete(id); }, all: async () => [...rows.values()].map(copy) };
};
function idbStorage() {
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open("pfa-vault", 2);
    r.onupgradeneeded = () => {
      const s = r.result.objectStoreNames.contains("vault") ? r.transaction.objectStore("vault") : r.result.createObjectStore("vault");
      // Duan explicitly retires the old shared, passphrase-based test vault. No migration.
      s.delete("main");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction("vault", mode); const req = fn(t.objectStore("vault"));
      t.oncomplete = () => { res(req.result ?? null); db.close(); };
      t.onabort = () => { rej(t.error || new Error("Device storage transaction aborted.")); db.close(); };
      t.onerror = () => { rej(t.error || new Error("Device storage transaction failed.")); db.close(); };
    });
  };
  return { get: (id) => tx("readonly", (s) => s.get(`account:${id}`)), put: (v, id) => tx("readwrite", (s) => s.put(v, `account:${id}`)), del: (id) => tx("readwrite", (s) => s.delete(`account:${id}`)), all: () => tx("readonly", (s) => s.getAll()) };
}
let storage = typeof indexedDB === "undefined" ? memoryStorage() : idbStorage();
let owner = "local-device";
export const useStorage = (s) => { accessEpoch++; storage = s; record = null; dataKey = null; owner = "local-device"; };
export const ownerId = () => owner;
export async function selectOwner(id = "local-device") {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new VaultError("OWNER", "No verified account was selected.");
  if (id === owner) return status();
  await lock(); owner = id; record = null;
  return status();
}
// Public credential hints only: never expose a PRF result, data key or financial record.
export async function passkeyHints() {
  const rows = await storage.all();
  return rows.filter((r) => r.v === 2 && r.owner).flatMap((r) => r.wraps.filter((w) => w.kind === "passkey").map((w) => ({ owner: r.owner, id: b64url(unb64(w.cred)), salt: unb64(w.prf_salt) })));
}
export const b64url = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

// ---------- state ----------
let record = null;   // {v, wraps: [...], data: {iv, ct} | null, recovery_confirmed, created_at, updated_at}
let dataKey = null;  // present only while unlocked; dropped on lock
let accessEpoch = 0;
export const accessRevision = () => accessEpoch;
const stillCurrent = (epoch, id) => {
  if (epoch !== accessEpoch || id !== owner) throw new VaultError("CANCELLED", "Access changed while approval was in progress. Please try again.");
};

export async function status() {
  // While unlocked the record in memory is the truth, and a write may be on its way; never swap it.
  if (!dataKey || !record) record = await storage.get(owner);
  if (record && (record.v !== 2 || record.owner !== owner)) throw new VaultError("OWNER", "This vault does not belong to the selected account.");
  return { exists: Boolean(record), owner, unlocked: Boolean(dataKey), passkey: Boolean(record?.wraps.some((w) => w.kind === "passkey")), recoveryConfirmed: Boolean(record?.recovery_confirmed) };
}
export const isUnlocked = () => Boolean(dataKey);

async function wrapRecovery(raw, words) { return { kind: "recovery", ...(await seal(await secretKey(await wordsToEntropy(words), "data-key"), raw)) }; }
function checkPasskey(pk) {
  if (pk?.secret?.length !== 32 || !pk.credId?.length || pk.prfSalt?.length !== 32) throw new VaultError("NO_PRF", "Use an encryption-capable passkey on a supported browser, device or security key.");
}
async function wrapPasskey(raw, pk) {
  checkPasskey(pk);
  return { kind: "passkey", cred: b64(pk.credId), prf_salt: b64(pk.prfSalt), rp_id: pk.rpId || null, ...(await seal(await secretKey(pk.secret, "passkey"), raw)) };
}

// A factor is {words} or {passkeySecret}. It yields the raw data key, briefly.
async function rawKeyFrom(factor, source = record) {
  if (!source) throw new VaultError("NONE", "Nothing is set up on this device yet.");
  let want = null;
  if (factor.words != null) want = "recovery";
  else if (factor.passkeySecret) want = "passkey";
  const w = source.wraps.find((x) => x.kind === want);
  if (!w) throw new VaultError("NONE", want === "passkey" ? "No passkey is set up on this device." : "That way in is not set up.");
  let kek;
  if (want === "recovery") kek = await secretKey(await wordsToEntropy(factor.words), "data-key");
  else kek = await secretKey(factor.passkeySecret, "passkey");
  try { return await unseal(kek, w); } catch {
    throw new VaultError("WRONG", want === "recovery" ? "Those 12 words do not open this app." : "That passkey does not open this app.");
  }
}

// First set-up. Returns the recovery words, to be shown once and never stored.
export async function create({ passkey = null } = {}) {
  checkPasskey(passkey);
  const targetOwner = owner, epoch = accessEpoch;
  if ((await status()).exists) throw new VaultError("EXISTS", "Records already exist for this account. Unlock them instead.");
  const raw = rand(32);
  try {
    const words = await newRecoveryWords();
    const wraps = [await wrapRecovery(raw, words), await wrapPasskey(raw, passkey)];
    const key = await aesKey(raw), now = new Date().toISOString();
    const created = { v: 2, owner: targetOwner, wraps, data: null, recovery_confirmed: false, created_at: now, updated_at: now };
    stillCurrent(epoch, targetOwner);
    await storage.put(created, targetOwner);
    stillCurrent(epoch, targetOwner);
    record = created; dataKey = key;
    return { words };
  } finally { raw.fill(0); }
}
export async function confirmRecovery() { record.recovery_confirmed = true; await storage.put(record, owner); }

export async function unlock(factor) {
  const epoch = accessEpoch, targetOwner = owner, source = record;
  const raw = await rawKeyFrom(factor, source);
  try {
    const key = await aesKey(raw), data = await readData(key, source);
    stillCurrent(epoch, targetOwner);
    dataKey = key;
    return data;
  } finally { raw.fill(0); }
}
async function readData(key, source) {
  if (!source.data) return null;
  try { return JSON.parse(dec.decode(await unseal(key, source.data))); }
  catch { throw new VaultError("FORMAT", "These encrypted records could not be opened. Nothing was replaced."); }
}

// Changing a way in needs a way in that already works, so a phone left unlocked on a table cannot
// have its device key replaced by whoever picks it up.
async function rewrap(factor, kind, make) {
  const epoch = accessEpoch, targetOwner = owner, source = record;
  const raw = await rawKeyFrom(factor, source);
  try {
    const w = await make(raw);
    stillCurrent(epoch, targetOwner);
    source.wraps = [...source.wraps.filter((x) => x.kind !== kind), w];
    source.updated_at = new Date().toISOString();
    await storage.put(source, targetOwner);
    stillCurrent(epoch, targetOwner);
  } finally { raw.fill(0); }
}
export const addPasskey = (factor, pk) => rewrap(factor, "passkey", (raw) => wrapPasskey(raw, pk));
export async function replaceRecovery(factor) {
  const words = await newRecoveryWords();
  await rewrap(factor, "recovery", (raw) => wrapRecovery(raw, words));
  record.recovery_confirmed = false; await storage.put(record, owner);
  return words;
}

// ---------- saving: every write is sealed before it touches storage ----------
let pending = null, pendingWaiters = [], chain = Promise.resolve(), timer = null, flushing = null;
export function persist(db, { ownerGeneration = null, revision = null } = {}) {
  if (!dataKey || !record) return Promise.reject(new VaultError("LOCKED", "The encrypted vault is not open."));
  const snapshot = structuredClone(db), key = dataKey, target = record, targetOwner = owner;
  pending = { snapshot, key, target, targetOwner, ownerGeneration, revision };
  clearTimeout(timer);
  const result = new Promise((resolve, reject) => pendingWaiters.push({ resolve, reject, ownerGeneration, revision }));
  timer = setTimeout(() => { flush().catch(() => {}); }, 300);
  return result;
}
export function flush() {
  clearTimeout(timer);
  if (flushing) return flushing.then(() => pending ? flush() : undefined);
  flushing = (async () => {
    while (pending) {
      const batch = pending, waiters = pendingWaiters;
      pending = null; pendingWaiters = [];
      const { snapshot, key, target, targetOwner } = batch, json = JSON.stringify(snapshot);
      const write = chain.then(async () => {
        const data = await seal(key, enc.encode(json));
        const candidate = { ...target, data, updated_at: new Date().toISOString() };
        await storage.put(candidate, targetOwner);
        // Do not expose a candidate as stored until IndexedDB reports transaction completion.
        target.data = candidate.data; target.updated_at = candidate.updated_at;
        if (record === target) record = target;
      });
      chain = write.catch(() => {});
      try {
        await write;
        for (const waiter of waiters) waiter.resolve({ ownerGeneration: waiter.ownerGeneration, revision: waiter.revision });
      } catch (error) {
        for (const waiter of waiters) waiter.reject(error);
        for (const waiter of pendingWaiters.splice(0)) waiter.reject(error);
        pending = null;
        throw error;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
export async function lock() { accessEpoch++; try { await flush(); } finally { dataKey = null; } }
export async function destroy() {
  accessEpoch++; clearTimeout(timer); pending = null;
  const error = new VaultError("CANCELLED", "Access ended before saving finished.");
  for (const waiter of pendingWaiters.splice(0)) waiter.reject(error);
  dataKey = null; await chain; await storage.del(owner); record = null;
}
// For tests and for the "is anything readable?" check: the record exactly as stored.
export const sealedRecord = () => storage.get(owner);

// ---------- passkeys: Face ID or a fingerprint releases a secret (WebAuthn PRF) ----------
export const passkeysPossible = () => typeof PublicKeyCredential !== "undefined" && typeof navigator !== "undefined" && typeof navigator.credentials?.create === "function";
async function passkeySecret(credId, prfSalt, rpId = null) {
  const a = await navigator.credentials.get({ publicKey: { ...(rpId ? { rpId } : {}), challenge: rand(32), allowCredentials: [{ type: "public-key", id: credId }], userVerification: "required", extensions: { prf: { eval: { first: prfSalt } } } } });
  const r = a?.getClientExtensionResults?.().prf?.results?.first;
  if (!r) throw new VaultError("NO_PRF", "This passkey cannot unlock encrypted records. Try a supported browser, device or security key.");
  return new Uint8Array(r);
}
// Signed in, the server's own options are passed in, so the one passkey both unlocks the app and signs
// the account in. The secret it releases for the lock stays here; only the public half goes to the server.
export async function registerPasskey({ publicKey = null } = {}) {
  if (!passkeysPossible()) throw new VaultError("NO_PRF", "This browser cannot use passkeys. Open Hodos in a supported browser or use another device.");
  const prfSalt = rand(32);
  const base = publicKey || {
    rp: { name: "Hodos" }, user: { id: rand(16), name: "App lock", displayName: "Hodos app lock" }, challenge: rand(32),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
  };
  const cred = await navigator.credentials.create({ publicKey: { ...base, extensions: { ...(base.extensions || {}), prf: { eval: { first: prfSalt } } } } });
  const ext = cred?.getClientExtensionResults?.() || {};
  if (!ext.prf?.enabled && !ext.prf?.results?.first) throw new VaultError("NO_PRF", "This passkey cannot unlock encrypted records. Try a supported browser, device or security key.");
  const credId = new Uint8Array(cred.rawId);
  const rpId = base.rp.id || globalThis.location?.hostname || null;
  const secret = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : await passkeySecret(credId, prfSalt, rpId);
  return { credId, prfSalt, rpId, secret, credential: cred };
}
export async function passkeyFactor() {
  const w = record?.wraps.find((x) => x.kind === "passkey");
  if (!w) throw new VaultError("NONE", "No passkey is set up on this device.");
  return { passkeySecret: await passkeySecret(unb64(w.cred), unb64(w.prf_salt), w.rp_id) };
}

// ---------- the recovery key, as a way to sign in ----------
// A second key is worked out of the same 12 words, under a different label, so it can never open the
// data. The server keeps only a fingerprint of it, and checks the key itself at sign-in.
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function recoveryProof(words) {
  const base = await subtle.importKey("raw", await wordsToEntropy(words), "HKDF", false, ["deriveBits"]);
  const proof = hex(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("pfa-account-v1"), info: enc.encode("sign-in") }, base, 256));
  return { proof, fingerprint: hex(await subtle.digest("SHA-256", enc.encode(proof))) };
}

// ---------- temporary manual backups: sealed with recovery words, never plain ----------
export async function sealBackup(obj, { words = null }) {
  const body = enc.encode(JSON.stringify(obj));
  return { format: "pfa-backup", v: 1, kdf: { kind: "recovery" }, ...(await seal(await secretKey(await wordsToEntropy(words), "backup"), body)), created_at: new Date().toISOString() };
}
export const isSealedBackup = (x) => x?.format === "pfa-backup" && x?.v === 1 && Boolean(x?.ct && x?.iv && x?.kdf?.kind === "recovery");
export async function openBackup(file, { words = null }) {
  if (!isSealedBackup(file)) throw new VaultError("FORMAT", "Use an encrypted recovery-key backup. Old test backups are not imported.");
  const key = await secretKey(await wordsToEntropy(words ?? ""), "backup");
  try { return JSON.parse(dec.decode(await unseal(key, file))); } catch {
    throw new VaultError("WRONG", "Those 12 words do not open this backup.");
  }
}

// D3 receipt and encrypted-vault durability regressions. Uses disposable in-memory storage only.
import assert from "node:assert/strict";
assert.ok(globalThis.crypto, "Web Crypto is required by the vault test");

const P = new URL("../public/js/", import.meta.url).href;
const { store } = await import(P + "lib/store.js");
const vault = await import(P + "lib/vault.js");

// In-memory preparation tracks changes without copying a growing database per row.
// Explicit action receipts still capture immutable rollback/save snapshots and never claim durability.
store.open(null);
const clone = globalThis.structuredClone;
let preparationCopies = 0, preparationNotices = 0;
const stopPreparationObserver = store.subscribe(() => preparationNotices++);
try {
  globalThis.structuredClone = (...args) => { preparationCopies++; return clone(...args); };
  for (let i = 0; i < 100; i++) store.insert('accounts', { name: `Prepared ${i}` });
  assert.equal(preparationCopies, 0, 'adapter-free preparation must not copy the full database for every row');
  assert.equal(preparationNotices, 100, 'ordinary observers still see in-memory changes');
  assert.deepEqual(store.persistenceState(), { dirty: true, revision: 100, durableRevision: 0 });
  assert.equal(store.hasPendingCommit(), false);
  const inMemoryAction = store.captureAction('memory-only-action', () => store.insert('accounts', { name: 'Captured' }));
  assert.equal(preparationCopies, 2, 'explicit actions retain rollback and immutable receipt snapshots');
  await store.commit(inMemoryAction);
  assert.equal(inMemoryAction.state, 'applied', 'no adapter means no durable acknowledgement');
  store.update('accounts', inMemoryAction.value.id, { name: 'Later' });
  assert.equal(inMemoryAction.snapshot.tables.accounts.at(-1).name, 'Captured');
} finally { globalThis.structuredClone = clone; stopPreparationObserver(); store.close(); }

// Action capture batches nested synchronous store writes and commits one immutable snapshot.
let persisted = [], rejectNext = false;
store.open(null, async (snapshot, meta) => {
  if (rejectNext) { rejectNext = false; throw new Error("storage rejected"); }
  persisted.push({ snapshot, meta });
}, "test-owner");
let notifications = 0;
const unsubscribe = store.subscribe(() => notifications++);
const receipt = store.captureAction("one-action", () => {
  const first = store.insert("accounts", { name: "Test" });
  store.insert("transactions", { account_id: first.id, amount: 10 });
  return first.id;
});
assert.equal(persisted.length, 0, "capture does not persist halfway through the action");
assert.equal(notifications, 1, "capture publishes one coherent mutation");
assert.equal(receipt.state, "applied");
await store.commit(receipt);
assert.equal(receipt.state, "durable");
assert.equal(persisted.length, 1);
assert.equal(persisted[0].snapshot.tables.transactions.length, 1);
assert.equal(persisted[0].meta.revision, receipt.revision);

// A rejected write keeps the same receipt for persistence-only retry.
const failed = store.captureAction("retry-same-action", () => store.insert("accounts", { name: "Retry me" }));
rejectNext = true;
await assert.rejects(store.commit(failed), /storage rejected/);
assert.equal(failed.state, "failed");
assert.equal(store.all("accounts").filter((x) => x.name === "Retry me").length, 1);
assert.throws(() => store.insert("accounts", { name: "Blocked until retry" }), /Retry saving/);
await store.retryPending();
assert.equal(failed.state, "durable");
assert.equal(store.all("accounts").filter((x) => x.name === "Retry me").length, 1, "retry does not rerun mutation");

// Synchronous multi-table failures roll back before observers or persistence see them.
const before = store.snapshot();
assert.throws(() => store.captureAction("rollback", () => {
  store.insert("accounts", { name: "Must roll back" });
  throw new Error("mutation failed");
}), /mutation failed/);
assert.deepEqual(store.snapshot(), before);

// A receipt cannot be applied to another open/closed owner generation.
const stale = store.captureAction("stale", () => store.insert("accounts", { name: "Old owner" }));
store.close(); store.open(null, async () => {}, "other-owner");
await assert.rejects(store.commit(stale), /previous access session/);
assert.equal(store.persistenceState().dirty, false);
unsubscribe(); store.close();

// Revisions cannot run backwards: completing/retrying an old receipt never writes an old snapshot.
let savedSnapshot, writes = 0;
store.open(null, async (snapshot) => { savedSnapshot = snapshot; writes++; });
const older = store.captureAction("older", () => store.insert("accounts", { name: "First" }));
const newer = store.captureAction("newer", () => store.insert("accounts", { name: "Second" }));
await store.commit(newer);
await store.commit(older);
assert.deepEqual(savedSnapshot.tables.accounts.map((row) => row.name), ["First", "Second"], "an older commit cannot erase newer saved data");
assert.equal(older.state, "durable", "a newer complete snapshot also acknowledges the included older action");
assert.equal(writes, 1, "an already-included old receipt does not cause another device write");
await store.retry(older);
assert.equal(writes, 1, "retry of a durable receipt is idempotent");
store.close();

// Adapters run in order; a failed newer save cannot be unblocked by an older completion.
const deferred = [];
store.open(null, (snapshot, meta) => new Promise((resolve, reject) => deferred.push({ snapshot, meta, resolve, reject })));
store.insert("accounts", { name: "Earlier background write" });
await new Promise((resolve) => setImmediate(resolve));
store.insert("accounts", { name: "Later background write" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deferred.length, 1, "only one adapter write is in flight");
deferred[0].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deferred.length, 2);
deferred[1].reject(new Error("later write failed"));
await new Promise((resolve) => setImmediate(resolve));
assert.match(store.persistenceState().error.message, /later write failed/);
assert.throws(() => store.captureAction("blocked", () => store.insert("accounts", { name: "Blocked" })), /Retry saving/);
const retryLatest = store.retryPending();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deferred[2].snapshot.tables.accounts.length, 2);
deferred[2].resolve(); await retryLatest;
assert.equal(store.persistenceState().dirty, false);
store.close();

// A retry of the first failed action must include subsequent, already-applied changes too.
let failAll = true;
store.open(null, async (snapshot) => { if (failAll) throw new Error("device unavailable"); savedSnapshot = snapshot; });
const firstFailed = store.captureAction("first-failed", () => store.insert("accounts", { name: "Confirmed first" }));
store.insert("accounts", { name: "Already applied later" });
await assert.rejects(store.commit(firstFailed), /device unavailable/);
failAll = false;
await store.retry(firstFailed);
assert.equal(savedSnapshot.tables.accounts.length, 2, "an old-action retry persists the latest complete snapshot");
assert.equal(store.persistenceState().dirty, false);
store.close();

// Device adapter: the sealed record changes only after storage.put completes; retry remains safe.
const memory = vault.memoryStorage();
let failPut = false;
vault.useStorage({
  get: memory.get, del: memory.del, all: memory.all,
  put: async (row, id) => { if (failPut) throw new Error("device put failed"); await memory.put(row, id); },
});
const setup = await vault.create({ passkey: { secret: new Uint8Array(32).fill(7), credId: new Uint8Array(16).fill(8), prfSalt: new Uint8Array(32).fill(9) } });
await vault.confirmRecovery();
store.open(null, vault.persist, vault.ownerId());
const deviceReceipt = store.captureAction("device-write", () => store.insert("accounts", { name: "Encrypted" }));
const sealedBefore = await vault.sealedRecord();
failPut = true;
await assert.rejects(store.commit(deviceReceipt), /device put failed/);
assert.deepEqual(await vault.sealedRecord(), sealedBefore, "failed device transaction never publishes candidate ciphertext");
failPut = false;
await store.retry(deviceReceipt);
assert.equal(deviceReceipt.state, "durable");
store.insert("accounts", { name: "Coalesced one" });
store.insert("accounts", { name: "Coalesced two" });
await vault.flush();
await vault.lock();
const opened = await vault.unlock({ words: setup.words });
assert.deepEqual(opened.tables.accounts.map((row) => row.name), ["Encrypted", "Coalesced one", "Coalesced two"], "coalesced background revisions preserve the latest full snapshot");
// Check ordering against actual ciphertext and reopen, not just an adapter mock.
const encryptedOlder = store.captureAction("encrypted-old", () => store.insert("accounts", { name: "Older action" }));
const encryptedNewer = store.captureAction("encrypted-new", () => store.insert("accounts", { name: "Newer action" }));
await store.commit(encryptedNewer); await store.retry(encryptedOlder);
await vault.lock();
const reopened = await vault.unlock({ words: setup.words });
assert.deepEqual(reopened.tables.accounts.slice(-2).map((row) => row.name), ["Older action", "Newer action"], "old retry cannot erase a newer encrypted save");
store.close(); await vault.lock();
console.log("PASS persistence receipts, revision ordering, rollback, owner generation, encrypted commit and retry");

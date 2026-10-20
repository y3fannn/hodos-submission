// On-device storage. One table per entity, held in memory while open, sealed by the vault on write.
// Every row: id (UUIDv7), user_id, created_at, updated_at, deleted_at?.
// The old shared test-data key is discarded, never migrated. Demo data has a separate key.
export const LEGACY_KEY = "pfa.db";
export const DEMO_KEY = "pfa.demo";
const SCHEMA_VERSION = 1;
let userId = "local-device";

const TABLES = [
  "profile", "accounts", "transactions", "categories", "merchant_rules", "recurring_rules",
  "alerts", "fx_rates", "budget_settings", "budgets", "nw_extras", "nw_snapshots",
  "goals", "goal_contributions", "debts", "debt_payments", "policies",
  "holdings", "trades", "cash_flows", "valuations", "briefings", "insight_settings",
  "conversations", "reconciliations", "import_batches", "home_layout",
  "nw_settings", "insurance_settings", "debt_settings", "recurring_ignores", "backup_state",
];

// The store holds everything in memory while the app is open. It never reads or writes storage
// itself: whoever opens it says where its writes go. Unlocked, that is the vault, which seals every
// write before it touches the device (lib/vault.js). In demo mode it is plain browser storage,
// because demo data is sample data. Closed, the store is empty.
const empty = () => { const fresh = { schema_version: SCHEMA_VERSION, tables: {} }; for (const t of TABLES) fresh.tables[t] = []; return fresh; };
let db = empty();
let persist = null;
let closed = false; // Blocks late asynchronous writes after lock/sign-out.
let ownerGeneration = 0, revision = 0, durableRevision = 0, failedRevision = 0, persistenceError = null;
let activeAction = null, unresolvedReceipt = null, latestReceipt = null;
let queuedWrite = null, runningWrite = null;
const receipts = new Set(), listeners = new Set(), commitListeners = new Set();
function assertWritable() {
  if (closed) throw new Error("Unlock your records before making changes.");
  if (persistenceError) throw new Error("A previous save has not finished. Retry saving it before making other changes.");
}
function publish(subscribers, event) {
  for (const fn of subscribers) {
    try { fn(event); } catch (error) { console.error("STORE_LISTENER", error); }
  }
}
function trackReceipt(receipt) {
  // Headless/demo preparation has no adapter and no durability waiters. Do not retain one full
  // database snapshot per seed row; only device-backed, unacknowledged receipts need tracking.
  if (persist) receipts.add(receipt);
  latestReceipt = receipt; unresolvedReceipt = receipt;
}
function invalidateWrites() {
  const error = new Error("This save belongs to a previous access session.");
  for (const write of [runningWrite, queuedWrite]) {
    for (const waiter of write?.waiters.splice(0) || []) waiter.reject(error);
  }
  runningWrite = queuedWrite = null; receipts.clear();
}

// One adapter write at a time. Pending requests share the newest complete snapshot, never an
// older action's snapshot; success acknowledges every included revision for this generation.
function drainWrites() {
  if (runningWrite || !queuedWrite) return;
  const write = queuedWrite; queuedWrite = null; runningWrite = write;
  (async () => {
    try {
      await write.adapter(write.snapshot, { ownerGeneration: write.ownerGeneration, revision: write.revision });
      if (write.ownerGeneration !== ownerGeneration) throw new Error("Access changed before saving finished.");
      durableRevision = Math.max(durableRevision, write.revision);
      for (const receipt of receipts) if (receipt.revision <= durableRevision) {
        receipt.state = "durable"; delete receipt.error; receipts.delete(receipt);
      }
      if (durableRevision >= failedRevision) { persistenceError = null; failedRevision = 0; }
      if (unresolvedReceipt?.revision <= durableRevision) unresolvedReceipt = null;
      for (const waiter of write.waiters.splice(0)) waiter.resolve(waiter.receipt);
      publish(commitListeners, { ownerGeneration: write.ownerGeneration, revision: write.revision });
    } catch (error) {
      if (write.ownerGeneration === ownerGeneration) {
        persistenceError = error; failedRevision = revision;
        for (const receipt of receipts) { receipt.state = "failed"; receipt.error = error; }
        unresolvedReceipt = latestReceipt;
        // Failure pauses automatic writes, including newer queued changes; Retry saves them all.
        for (const waiter of queuedWrite?.waiters.splice(0) || []) waiter.reject(error);
        queuedWrite = null;
        publish(listeners);
      }
      for (const waiter of write.waiters.splice(0)) waiter.reject(error);
    } finally {
      if (runningWrite === write) { runningWrite = null; queueMicrotask(drainWrites); }
    }
  })();
}
function persistReceipt(receipt) {
  if (!receipt || receipt.ownerGeneration !== ownerGeneration) return Promise.reject(new Error("This save belongs to a previous access session."));
  if (!receipt.changed || !persist) return Promise.resolve(receipt); // Explicitly in-memory, not a device acknowledgement.
  if (receipt.revision <= durableRevision) { receipt.state = "durable"; delete receipt.error; return Promise.resolve(receipt); }
  const target = latestReceipt?.revision >= receipt.revision ? latestReceipt : receipt;
  return new Promise((resolve, reject) => {
    const waiter = { receipt, resolve, reject };
    if (runningWrite?.revision >= target.revision) { runningWrite.waiters.push(waiter); return; }
    if (!queuedWrite || target.revision > queuedWrite.revision) {
      queuedWrite = { snapshot: structuredClone(target.snapshot), ownerGeneration, revision: target.revision, adapter: persist, waiters: queuedWrite?.waiters || [] };
    }
    queuedWrite.waiters.push(waiter);
    drainWrites();
  });
}
function notify() {
  if (activeAction) { activeAction.changed = true; return; }
  revision++;
  // Adapter-free preparation is memory-only: track revisions/observers, not a database-sized
  // copy per seed row. Explicit actions still capture rollback and immutable receipt snapshots.
  if (persist) {
    const receipt = { operationId: `background:${ownerGeneration}:${revision}`, ownerGeneration, revision, snapshot: structuredClone(db), state: "applied", changed: true };
    trackReceipt(receipt);
    persistReceipt(receipt).catch(() => {});
  }
  publish(listeners);
}

export function uuidv7() {
  const now = BigInt(Date.now());
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] = Number((now >> 40n) & 0xffn); b[1] = Number((now >> 32n) & 0xffn); b[2] = Number((now >> 24n) & 0xffn);
  b[3] = Number((now >> 16n) & 0xffn); b[4] = Number((now >> 8n) & 0xffn); b[5] = Number(now & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const nowIso = () => new Date().toISOString();

export const store = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  onCommitted(fn) { commitListeners.add(fn); return () => commitListeners.delete(fn); },
  generation() { return ownerGeneration; },
  // Open with what was stored (or nothing, for a first run), and where writes go from now on.
  open(parsed, persistTo = null, owner = "local-device") {
    invalidateWrites();
    ownerGeneration++; revision = durableRevision = failedRevision = 0; persistenceError = null; activeAction = null; unresolvedReceipt = latestReceipt = null;
    const next = parsed && parsed.tables ? parsed : empty();
    for (const t of TABLES) next.tables[t] ||= [];
    db = next; persist = persistTo; userId = owner; closed = false;
    for (const fn of listeners) fn();
  },
  close() { invalidateWrites(); ownerGeneration++; persist = null; db = empty(); userId = "local-device"; closed = true; activeAction = null; unresolvedReceipt = latestReceipt = null; revision = durableRevision = failedRevision = 0; persistenceError = null; },
  persistenceState() { return { dirty: revision > durableRevision, revision, durableRevision, ...(persistenceError ? { error: persistenceError } : {}) }; },
  hasPendingCommit() { return Boolean(persist && unresolvedReceipt?.state === "applied" && revision > durableRevision); },
  retryPending() { return unresolvedReceipt ? this.retry(unresolvedReceipt) : Promise.resolve(null); },
  captureAction(operationId, mutateSync) {
    assertWritable();
    if (activeAction) throw new Error("Another save action is already being applied.");
    if (typeof mutateSync !== "function" || mutateSync.constructor.name === "AsyncFunction") throw new TypeError("An action must provide a synchronous mutation.");
    const before = structuredClone(db), generation = ownerGeneration;
    activeAction = { operationId, changed: false };
    let value;
    try {
      value = mutateSync();
      if (value && typeof value.then === "function") throw new TypeError("Action mutation must be synchronous.");
    } catch (error) {
      if (generation === ownerGeneration) { db = before; activeAction = null; }
      throw error;
    }
    if (generation !== ownerGeneration) throw new Error("Access changed while saving. Please try again.");
    const changed = activeAction.changed;
    activeAction = null;
    const currentRevision = changed ? ++revision : revision;
    const receipt = { operationId, ownerGeneration: generation, revision: currentRevision, value, state: "applied", snapshot: structuredClone(db), changed };
    if (changed) {
      trackReceipt(receipt);
      publish(listeners, { type: "action-applied", operationId, ownerGeneration: generation, revision: currentRevision });
    }
    return receipt;
  },
  commit(receipt) { return persistReceipt(receipt); },
  retry(receipt) {
    if (!receipt || receipt.ownerGeneration !== ownerGeneration) return Promise.reject(new Error("This save belongs to a previous access session."));
    if (receipt.revision > durableRevision) receipt.state = "applied";
    return persistReceipt(receipt);
  },
  isEmpty() { return TABLES.every((t) => !db.tables[t].length); },
  all(table, { includeDeleted = false } = {}) {
    const rows = db.tables[table] || [];
    return includeDeleted ? rows : rows.filter((r) => !r.deleted_at);
  },
  get(table, id) { return (db.tables[table] || []).find((r) => r.id === id && !r.deleted_at) || null; },
  insert(table, row) {
    assertWritable();
    const ts = nowIso();
    const full = { id: uuidv7(), created_at: ts, updated_at: ts, deleted_at: null, ...row, user_id: userId };
    db.tables[table].push(full);
    notify();
    return full;
  },
  update(table, id, patch) {
    assertWritable();
    const row = db.tables[table].find((r) => r.id === id);
    if (!row) throw new Error(`${table}:${id} not found`);
    Object.assign(row, patch, { user_id: userId, updated_at: nowIso() });
    notify();
    return row;
  },
  softDelete(table, id) { return this.update(table, id, { deleted_at: nowIso() }); },
  // Single-row tables
  one(table) { return this.all(table)[0] || null; },
  upsertOne(table, patch) {
    const row = this.one(table);
    return row ? this.update(table, row.id, patch) : this.insert(table, patch);
  },
  exportJson() { return JSON.stringify(db, null, 2); },
  snapshot() { return structuredClone(db); },
  importJson(text) {
    assertWritable();
    let parsed;
    try { parsed = typeof text === "string" ? JSON.parse(text) : structuredClone(text); }
    catch { throw new Error("Not a Hodos export"); }
    if (!parsed.tables || typeof parsed.schema_version !== "number") throw new Error("Not a Hodos export");
    for (const t of TABLES) parsed.tables[t] ||= [];
    for (const table of TABLES) for (const row of parsed.tables[table]) row.user_id = userId;
    db = parsed;
    notify();
  },
  wipe() {
    assertWritable();
    db = empty();
    notify();
  },
  counts() { const c = {}; for (const t of TABLES) c[t] = this.all(t).length; return c; },
  tables() { return [...TABLES]; },
};

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      if (persisted) return true;
      return await navigator.storage.persist();
    }
  } catch {}
  return false;
}

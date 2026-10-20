// Technical chat persistence only; never financial mutations or provider calls.
import { store, nowIso } from "./store.js";
const pending = new Map();
export const conversation = () => store.one("conversations") || store.insert("conversations", { messages: [], epoch: 0, started_at: nowIso(), last_at: nowIso() });
export const history = () => conversation().messages || [];
export const epoch = () => `${store.generation()}:${conversation().id}:${conversation().epoch || 0}`;
export async function appendMessage(role, text, extra = {}, { id = crypto.randomUUID(), expected = epoch(), retry = false, replace = false } = {}) {
  if (epoch() !== expected) return null;
  const existing = history().find(m => m.id === id);
  const key = `${expected}:${id}`;
  let receipt = pending.get(key);
  if (existing && !receipt && !replace) return existing;
  if (!receipt) {
    const row = conversation();
    receipt = store.captureAction(`chat:${id}`, () => {
      const message = { id, role, text, at: nowIso(), ...extra };
      store.update("conversations", row.id, { messages: existing ? (row.messages || []).map(m => m.id === id ? message : m) : [...(row.messages || []), message], last_at: nowIso() });
      return message;
    });
    pending.set(key, receipt);
  }
  try {
    if (receipt.state === "failed" && !retry) throw new Error("Message save failed. Retry saving before sending it to AI.");
    if (receipt.state !== "durable") { if (retry) await store.retry(receipt); else await store.commit(receipt); }
    if (receipt.state !== "durable") throw new Error("Device storage has not confirmed this message.");
    pending.delete(key);
    return epoch() === expected ? receipt.value : null;
  } catch (error) { error.receipt = receipt; throw error; }
}
export async function clearConversation() {
  const row = conversation(), generation = store.generation();
  const receipt = store.captureAction(`chat-clear:${crypto.randomUUID()}`, () => store.update("conversations", row.id, { messages: [], epoch: (row.epoch || 0) + 1, last_at: nowIso() }));
  // Epoch changes immediately, preventing late replies even while this clear is being saved.
  pending.clear();
  await store.commit(receipt);
  if (generation !== store.generation() || receipt.state !== "durable") throw new Error("Conversation clearing was not confirmed on this device.");
  return true;
}
export function discardPendingAccess() { pending.clear(); }

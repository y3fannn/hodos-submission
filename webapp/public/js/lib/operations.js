// Owner-bound lifecycle for visible asynchronous work. Store receipts survive view disposal;
// disposing an operation only stops unfinished preparation and prevents late UI effects.
import { store } from "./store.js";

const RUNNING = new Set(["preparing", "reading", "generating", "saving"]);
const STATES = new Set(["idle", ...RUNNING, "success", "failed", "cancelled"]);
const liveOperations = new Map();
const operationKey = (generation, key) => JSON.stringify([generation, key]);
const plainText = (value, fallback) => String(value?.message || value || fallback).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500);

function region(root, selector, role, hidden = false) {
  if (!root) return null;
  let node = root.querySelector(selector);
  if (!node) {
    node = document.createElement("div");
    node.className = selector === "[data-operation-status]" ? "operation-status" : "operation-error";
    if (selector === "[data-operation-status]") node.dataset.operationStatus = "";
    else node.dataset.operationError = "";
    if (role) { node.setAttribute("role", role); node.setAttribute("aria-live", role === "status" ? "polite" : "assertive"); }
    node.hidden = hidden;
    root.append(node);
  }
  return node;
}

export function disposeAllOperations(reason = "access changed") {
  for (const operation of [...liveOperations.values()]) operation.dispose(reason);
}

export function createOperation({ root = null, key, ownerGeneration = store.generation(), getGeneration = () => store.generation(), onDispose = () => {} } = {}) {
  if (!key) throw new TypeError("An operation needs a stable key.");
  const registryKey = operationKey(ownerGeneration, key);
  const existing = liveOperations.get(registryKey);
  if (existing?.active()) { if (root) existing.attach(root); return existing; }
  existing?.dispose("access changed");

  const id = crypto.randomUUID(), controller = new AbortController();
  let state = "idle", disposed = false, errorMessage = "", nextStep = "", statusMessage = "";
  let attachedRoot = null, status = null, error = null;
  const active = () => !disposed && !controller.signal.aborted && ownerGeneration === getGeneration();
  const setBusy = (busy) => {
    if (!attachedRoot) return;
    if (busy) attachedRoot.setAttribute("aria-busy", "true"); else attachedRoot.removeAttribute("aria-busy");
  };
  const showError = () => {
    if (!error) return;
    error.replaceChildren();
    const message = document.createElement("span"); message.textContent = errorMessage; error.append(message);
    if (nextStep) { const step = document.createElement("span"); step.textContent = ` ${nextStep}`; error.append(step); }
    const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => operation.dismissError(), { once: true });
    error.append(dismiss); error.hidden = false;
  };
  const operation = {
    id, key, ownerGeneration, signal: controller.signal,
    get state() { return state; },
    active,
    attach(nextRoot) {
      if (!nextRoot || !active()) return false;
      attachedRoot = nextRoot;
      status = region(attachedRoot, "[data-operation-status]", "status");
      error = region(attachedRoot, "[data-operation-error]", "alert", true);
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      setBusy(RUNNING.has(state));
      if (state === "failed") showError();
      return true;
    },
    start(label, phase = "preparing") {
      if (!active() || !RUNNING.has(phase) || (state !== "idle" && state !== "failed")) return false;
      const current = liveOperations.get(registryKey);
      if (current && current !== operation && current.active()) return false;
      liveOperations.set(registryKey, operation);
      state = phase; errorMessage = ""; nextStep = ""; statusMessage = String(label || "Working…");
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      if (error) { error.replaceChildren(); error.hidden = true; }
      setBusy(true); return true;
    },
    progress(label, phase) {
      if (!active() || !RUNNING.has(state) || !RUNNING.has(phase)) return false;
      state = phase; statusMessage = String(label || "Working…");
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      setBusy(true); return true;
    },
    pause(message = "Ready") {
      if (!active() || !RUNNING.has(state)) return false;
      state = "idle"; statusMessage = String(message); setBusy(false);
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      return true;
    },
    fail(problem, next = "") {
      if (!active() || !RUNNING.has(state)) return false;
      state = "failed"; errorMessage = plainText(problem, "This action could not be completed."); nextStep = next ? plainText(next, "") : "";
      statusMessage = "Not saved"; setBusy(false);
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      showError(); return true;
    },
    succeed(message = "Done") {
      if (!active() || !RUNNING.has(state)) return false;
      state = "success"; statusMessage = String(message); setBusy(false);
      if (liveOperations.get(registryKey) === operation) liveOperations.delete(registryKey);
      if (error) { error.replaceChildren(); error.hidden = true; }
      if (status) { status.textContent = statusMessage; status.hidden = false; }
      return true;
    },
    dismissError() {
      if (!error) return false;
      error.replaceChildren(); error.hidden = true; return state === "failed";
    },
    dispose(reason = "navigation") {
      if (disposed) return;
      disposed = true;
      if (liveOperations.get(registryKey) === operation) liveOperations.delete(registryKey);
      if (RUNNING.has(state) || state === "idle") state = "cancelled";
      controller.abort(reason); setBusy(false);
      if (status) { status.textContent = ""; status.hidden = false; }
      if (error) { error.replaceChildren(); error.hidden = true; }
      try { onDispose(reason); } catch (cause) { console.error("OPERATION_DISPOSE", cause); }
    },
  };
  if (!STATES.has(state)) throw new Error("Invalid operation state.");
  if (root) operation.attach(root);
  return operation;
}

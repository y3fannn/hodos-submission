// Tiny render helpers. Strings in, DOM out. Delegated events by data-action.
import { rateUrl } from "./fx.js";
import { store } from "./store.js";
import { session } from "./session.js";
import { featurePaused } from "./feature-policy.js";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? render(vals[i]) : ""), "");
}
function render(v) {
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Raw) return v.s;
  return esc(v);
}
// toString matters: a Raw dropped into a plain template literal instead of an html`` one used to
// print "[object Object]" on the page. It carries HTML that is already trusted, so handing that HTML
// back is both correct and the safe answer. Caught live on the first-run screen, 2026-09-21.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export const absent = (why) => raw(`<span class="absent" title="${esc(why || "")}">—${why ? ` <small>(${esc(why)})</small>` : ""}</span>`);
export const rateLink = (from, to, date, label = "Update rate") => `<a class="btn small" href="${esc(rateUrl(from, to, date))}">${esc(label)}</a>`;
export function rateLinks(reasons) {
  const pairs = new Map();
  for (const reason of reasons) for (const m of String(reason).matchAll(/Exchange rate missing: ([A-Z]{3}) → ([A-Z]{3})(?: for (\d{4}-\d{2}-\d{2}))?/g)) pairs.set(`${m[1]}:${m[2]}:${m[3] || ""}`, m);
  return pairs.size ? `<div class="actions">${[...pairs.values()].map((m) => rateLink(m[1], m[2], m[3], `Update rate · ${m[1]} → ${m[2]}`)).join("")}</div>` : "";
}

// One house rule for every word the app offers or prints back: it starts with a capital.
// Stored values stay lower case; only what the eye reads is changed, and underscores become spaces.
const ACRONYMS = { etf: "ETF", reit: "REIT", cpf: "CPF", srs: "SRS", hdb: "HDB", ai: "AI", p2p: "P2P" };
export const cap = (s) => {
  const t = String(s ?? "").replace(/_/g, " ");
  if (ACRONYMS[t.toLowerCase()]) return ACRONYMS[t.toLowerCase()];
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

export function option(list, selected, labelFn = (x) => x, valueFn = (x) => x) {
  return raw(list.map((x) => `<option value="${esc(valueFn(x))}"${valueFn(x) === selected ? " selected" : ""}>${esc(cap(labelFn(x)))}</option>`).join(""));
}

let toastTimer, actionToast = null, actionCaptureDepth = 0;
function showToast(msg, ms) {
  const root = document.getElementById("toast-root");
  const item = document.createElement("div"); item.className = "toast"; item.textContent = msg;
  root.replaceChildren(item);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.replaceChildren(), ms);
}
export function toast(msg, ms = 2600) {
  if (actionCaptureDepth) { actionToast = { message: msg, duration: ms }; return; }
  showToast(msg, ms);
}

// Await one synchronous domain action at UI entry points outside a dialog. Global Retry
// retains the same captured receipt if this write fails; it never reruns the mutation.
export async function commitAction(mutateSync, operationId = crypto.randomUUID()) {
  const generation = store.generation(), mode = session.mode, hash = location.hash;
  const active = () => generation === store.generation() && mode === session.mode && hash === location.hash;
  let receipt, queued;
  actionCaptureDepth++;
  try { receipt = store.captureAction(operationId, mutateSync); }
  finally { actionCaptureDepth--; queued = actionToast; actionToast = null; }
  try {
    if (receipt.changed && receipt.state !== "durable") {
      if (receipt.state === "failed") await store.retry(receipt);
      else await store.commit(receipt);
      if (receipt.state !== "durable") throw new Error("Device storage did not confirm this save.");
    }
    if (active() && queued) showToast(queued.message, queued.duration);
    return receipt;
  } catch (error) {
    // Keep the exact receipt available to operations that must resume after global Retry.
    if (error && typeof error === "object") error.receipt = receipt;
    // The global storage warning owns persistent failure messaging and retry.
    throw error;
  }
}

// Use after asynchronous preparation is complete. Retry reuses the captured mutation and snapshot.
export async function commitFormAction(form, operationId, mutateSync, receipt = null) {
  const action = receipt || store.captureAction(operationId, mutateSync);
  if (action.operationId !== operationId) throw new Error("This retry belongs to a different action.");
  if (!action.changed || action.state === "durable") return action;
  form?.setAttribute("aria-busy", "true");
  const status = form?.querySelector("[data-modal-status]"); if (status) status.textContent = "Saving…";
  try {
    if (action.state === "failed") await store.retry(action);
    else await store.commit(action);
    if (action.state !== "durable") throw new Error("Device storage did not confirm this save.");
    return action;
  } catch (error) {
    if (action.changed && form?.isConnected) {
      form.querySelectorAll("input,select,textarea").forEach((control) => { control.disabled = true; });
      const submit = form.querySelector('button[type="submit"]'); if (submit) submit.textContent = "Retry saving";
    }
    throw error;
  } finally {
    form?.setAttribute("aria-busy", "false");
    if (status) status.textContent = "";
  }
}

// Modal: body is trusted app-template HTML only; callers must escape data, never pass raw AI HTML.
// Returns {el, form, close}. onSubmit receives FormData of the first form.
let activeModal = null, modalSequence = 0;
function restoreModalBackground(state) {
  for (const [node, inert, ariaHidden] of state.background) {
    node.inert = inert;
    if (ariaHidden == null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", ariaHidden);
  }
}
export function modal({ title, body, onSubmit, onSuccess, onCancel, submitLabel = "Confirm", cancelLabel = "Cancel", danger = false, extraButtons = "", dismissOnBackdrop = false, initialFocus = null, returnFocus = null, onClose = null, description = null }) {
  const root = document.getElementById("modal-root");
  if (activeModal) activeModal.dispose("replace", { restoreFocus: false });
  const id = `hodos-dialog-${++modalSequence}`, trigger = returnFocus || document.activeElement;
  const background = [...document.body.children].filter((node) => node !== root).map((node) => [node, node.inert, node.getAttribute("aria-hidden")]);
  for (const [node] of background) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
  const descriptionAttr = description ? ` aria-describedby="${esc(description)}"` : "";
  const submitClass = danger ? "danger" : "primary";
  const submitHtml = onSubmit ? `<button type="submit" class="${submitClass}">${esc(submitLabel)}</button>` : "";
  const lockHtml = session.mode === "open" ? '<button type="button" data-modal-lock>Lock records</button>' : "";
  // Trusted form templates; title and description are escaped. The heading is the dialog's accessible name.
  // pi-lens-ignore: no-inner-html-js
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title"${descriptionAttr} tabindex="-1">
    <h2 id="${id}-title" tabindex="-1">${esc(title)}</h2>
    <form data-modal-form>${body}
      <div class="actions right">
        ${extraButtons}
        ${lockHtml}
        <button type="button" data-action="modal-cancel">${esc(cancelLabel)}</button>
        ${submitHtml}
      </div>
      <div class="operation-status" data-modal-status role="status" aria-live="polite"></div>
      <div class="error" data-modal-error></div>
    </form></div></div>`;
  const backdrop = root.querySelector(".modal-backdrop"), dialog = root.querySelector('[role="dialog"]');
  const form = root.querySelector("form"), cancelButton = root.querySelector("[data-action=modal-cancel]"), lockButton = root.querySelector("[data-modal-lock]");
  const state = { root, backdrop, dialog, background, trigger, disposed: false, onClose };
  state.dispose = (reason = "close", { restoreFocus = true } = {}) => {
    if (state.disposed) return;
    state.disposed = true;
    backdrop.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKeydown, true);
    cancelButton.removeEventListener("click", onCancelClick);
    lockButton?.removeEventListener("click", onLock);
    form.validation?.dispose();
    if (backdrop.parentElement === root) root.replaceChildren();
    restoreModalBackground(state);
    if (activeModal === state) activeModal = null;
    try { onClose?.(reason); } finally {
      if (restoreFocus) {
        const target = typeof returnFocus === "function" ? returnFocus() : trigger;
        const fallback = document.querySelector("#app h1, #app h2, #app [data-page-heading]");
        const focusTarget = target?.isConnected && target !== document.body && target !== document.documentElement ? target : fallback;
        if (focusTarget) { if (!focusTarget.hasAttribute("tabindex")) focusTarget.setAttribute("tabindex", "-1"); focusTarget.focus({ preventScroll: true }); }
      }
    }
  };
  const close = (reason = "close") => state.dispose(reason);
  // Disposal stops this view/unfinished work, not an already-confirmed store commit.
  const cancel = (reason = "cancel") => { if (state.disposed || activeModal !== state) return; close(reason); onCancel?.(); };
  state.cancel = cancel;
  const onCancelClick = (event) => { event.preventDefault(); cancel(); };
  const onBackdrop = (event) => {
    if (event.target.closest('a[href^="#/"]')) { cancel(); return; }
    if (dismissOnBackdrop && event.target === backdrop) cancel();
  };
  const focusables = () => [...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((node) => node.getClientRects().length && !node.closest('[hidden],[inert]'));
  const onKeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.key !== "Tab") return;
    const nodes = focusables();
    if (!nodes.length) { event.preventDefault(); dialog.focus(); return; }
    const first = nodes[0], last = nodes.at(-1), current = document.activeElement;
    if (event.shiftKey && (current === first || !dialog.contains(current))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || !dialog.contains(current))) { event.preventDefault(); first.focus(); }
  };
  const onLock = async () => {
    lockButton.disabled = true;
    try { await session.lockNow(); }
    catch { toast("Could not lock records. Try again."); }
    finally { if (!state.disposed) lockButton.disabled = false; }
  };
  cancelButton.addEventListener("click", onCancelClick);
  lockButton?.addEventListener("click", onLock);
  backdrop.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKeydown, true);
  activeModal = state;
  const operationId = crypto.randomUUID();
  const generation = store.generation(), mode = session.mode, hash = location.hash;
  const active = () => !state.disposed && activeModal === state && generation === store.generation() && mode === session.mode && hash === location.hash;
  let submitting = false, pendingReceipt = null, pendingToast = null;
  const setActionBusy = (busy) => {
    form.setAttribute("aria-busy", String(busy));
    form.querySelector("[data-modal-status]").textContent = busy ? "Saving…" : "";
    cancelButton.disabled = false;
    for (const control of form.querySelectorAll("input,select,textarea,button")) {
      if (control !== cancelButton && control !== lockButton && control !== form.querySelector('button[type="submit"]')) control.disabled = busy || pendingReceipt?.state === "failed";
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!onSubmit || submitting || !active()) return;
    // An applied receipt retries persistence, never validation or mutation again.
    if (!pendingReceipt && !form.validation.validateSubmit().valid) return;
    submitting = true;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const err = form.querySelector("[data-modal-error]");
    err.textContent = "";
    try {
      let result;
      if (onSubmit.constructor.name === "AsyncFunction") result = await onSubmit(new FormData(form), form);
      else {
        if (!pendingReceipt) {
          actionCaptureDepth++;
          try { pendingReceipt = store.captureAction(operationId, () => onSubmit(new FormData(form), form)); }
          finally { actionCaptureDepth--; pendingToast = actionToast; actionToast = null; }
        }
        result = pendingReceipt.value;
        if (pendingReceipt.changed && pendingReceipt.state !== "durable") {
          setActionBusy(true);
          if (pendingReceipt.state === "failed") await store.retry(pendingReceipt);
          else await store.commit(pendingReceipt);
          if (pendingReceipt.state !== "durable") throw new Error("Device storage did not confirm this save. It is not marked as saved.");
        }
        if (!active()) { pendingToast = null; return; }
        if (pendingToast) showToast(pendingToast.message, pendingToast.duration);
        pendingToast = null; pendingReceipt = null;
      }
      if (!active()) return;
      if (result !== false) { onSuccess?.(result); close("submit"); }
    } catch (error) {
      pendingToast = null;
      if (!active()) return;
      if (pendingReceipt?.changed) {
        setActionBusy(false);
        for (const control of form.querySelectorAll("input,select,textarea,button")) {
          if (control !== cancelButton && control !== lockButton && control !== form.querySelector('button[type="submit"]')) control.disabled = true;
        }
        if (submit) submit.textContent = "Retry saving";
      }
      if (error instanceof ValidationError) {
        form.validation.show(error);
        return;
      }
      err.textContent = error.message || String(error);
      if (error.rate_pair) {
        const { from, to, date } = error.rate_pair;
        const actions = document.createElement("div"), link = document.createElement("a");
        actions.className = "actions"; link.className = "btn small";
        link.href = rateUrl(from, to, date); link.textContent = "Update rate";
        actions.append(link); err.append(actions);
      }
    } finally {
      submitting = false;
      if (active() && submit) submit.disabled = false;
    }
  };
  bindValidation(form);
  let requested = initialFocus;
  if (typeof initialFocus === "function") requested = initialFocus({ dialog, form });
  else if (typeof initialFocus === "string") requested = dialog.querySelector(initialFocus);
  const firstEdit = focusables().find((node) => node.matches('input:not([type="hidden"]),select,textarea'));
  const first = requested || (danger ? cancelButton : firstEdit) || root.querySelector(`#${id}-title`);
  setTimeout(() => { if (!state.disposed && activeModal === state) first?.focus?.({ preventScroll: true }); }, 0);
  return { el: dialog, form, close };
}

export function cancelModal(reason = "cancel") { activeModal?.cancel(reason); }

export function confirm(title, bodyText, { submitLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (settled) return; settled = true; resolve(value); };
    modal({ title, body: `<p>${esc(bodyText)}</p>`, submitLabel, danger, initialFocus: "h2", onSubmit: () => { settle(true); }, onClose: () => settle(false) });
  });
}

// A hero amount: the unit recedes so the number leads. Caller passes the split parts.
export const heroAmount = ({ unit, text }) => `<span class="money"><span class="money-unit">${esc(unit)}</span><span class="money-value">${esc(text)}</span></span>`;
// Anything whose words came from a model says so. The figures inside are still the app's own: code
// does the maths, the model only describes it, and the mark is what tells the two apart on screen.
export const aiMade = (label = "Generated by AI") =>
  `<span class="ai-made"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="spark-ic" d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path class="spark-ic" d="M18.4 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>${esc(label)}</span>`;
export class ValidationError extends Error {
  constructor({ fields = {}, form = "", rate_pair } = {}) {
    super(form || Object.values(fields)[0] || "Check the highlighted fields.");
    this.name = "ValidationError"; this.fields = fields; this.form = form;
    if (rate_pair) this.rate_pair = rate_pair;
  }
}

let validationSequence = 0;
// Validation has no store/AI side effects. Domain issues are named, never guessed from prose.
export function bindValidation(form, { validate = () => ({}), dependencies = {} } = {}) {
  form.validation?.dispose();
  const scope = `hodos-form-${++validationSequence}`;
  form.noValidate = true;
  const controls = () => [...form.querySelectorAll('input[name],select[name],textarea[name]')];
  const fields = {}, errors = new Map();
  let attempted = false;
  const summary = form.querySelector('[data-validation-summary]') || document.createElement('div');
  summary.className = 'error'; summary.dataset.validationSummary = ''; summary.setAttribute('role', 'status'); summary.hidden = true;
  if (!summary.parentElement) (form.querySelector('[data-modal-error]') || form.lastElementChild)?.before(summary);
  const controlFor = (name) => controls().find((control) => control.name === name);
  for (const [index, control] of controls().entries()) {
    if (!control.id) control.id = `${scope}-${index}`;
    const label = control.closest('label');
    const hints = label ? [...label.querySelectorAll('.hint')] : [];
    for (const [hintIndex, hint] of hints.entries()) {
      if (!hint.id) hint.id = `${control.id}-hint-${hintIndex}`;
      const ids = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      ids.add(hint.id); control.setAttribute('aria-describedby', [...ids].join(' '));
    }
  }
  const applicable = (control) => !control.disabled && control.type !== 'hidden' && !control.closest('[hidden]');
  const collect = () => {
    const values = new FormData(form), issues = { fields: {} };
    for (const control of controls()) {
      if (!applicable(control)) continue;
      const v = control.validity;
      if (v.valueMissing) issues.fields[control.name] = 'This field is required.';
      else if (v.badInput || v.typeMismatch) issues.fields[control.name] = 'Enter a valid value.';
      else if (v.rangeUnderflow) issues.fields[control.name] = `Enter ${control.min} or more.`;
      else if (v.rangeOverflow) issues.fields[control.name] = `Enter ${control.max} or less.`;
      else if (v.stepMismatch) issues.fields[control.name] = 'Enter a value in the allowed steps.';
      else if (v.patternMismatch) issues.fields[control.name] = 'Enter a value in the required format.';
    }
    const domain = validate(values) || {};
    Object.assign(issues.fields, domain.fields || {});
    issues.form = domain.form || '';
    issues.rate_pair = domain.rate_pair;
    return { values, issues };
  };
  const render = () => {
    for (const name of new Set([...errors.keys(), ...Object.keys(fields)])) {
      const control = controlFor(name); if (!control) continue;
      let node = errors.get(name);
      if (!node && fields[name]) {
        node = document.createElement('div'); node.id = `${control.id}-error`; node.className = 'error';
        node.dataset.fieldError = name; control.after(node); errors.set(name, node);
      }
      if (!node) continue;
      node.textContent = fields[name] || ''; node.hidden = !fields[name];
      const ids = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      if (fields[name]) { control.setAttribute('aria-invalid', 'true'); ids.add(node.id); }
      else { control.removeAttribute('aria-invalid'); ids.delete(node.id); }
      if (ids.size) control.setAttribute('aria-describedby', [...ids].join(' ')); else control.removeAttribute('aria-describedby');
    }
  };
  const updateRateLink = (pair) => {
    let link = summary.querySelector('[data-validation-rate]');
    if (!pair) { link?.remove(); return; }
    if (!link) {
      link = document.createElement('a'); link.className = 'btn small';
      link.dataset.validationRate = ''; link.textContent = 'Update rate'; summary.append(link);
    }
    link.href = rateUrl(pair.from, pair.to, pair.date);
  };
  const show = (issues = {}) => {
    attempted = true;
    for (const name of Object.keys(fields)) delete fields[name];
    Object.assign(fields, issues.fields || {}); render();
    const count = Object.keys(fields).length;
    let message = '';
    if (count === 1) message = 'Check the highlighted field.';
    else if (count) message = `Check the ${count} highlighted fields.`;
    summary.textContent = issues.form || message;
    updateRateLink(issues.rate_pair);
    summary.hidden = !summary.textContent;
    const first = controls().find((control) => fields[control.name] && applicable(control) && control.getClientRects().length);
    first?.focus({ preventScroll: false });
  };
  const onEdit = (event) => {
    if (!attempted || !event.target.name || form.getAttribute('aria-busy') === 'true') return;
    const { issues } = collect();
    const affected = new Set([event.target.name]);
    for (const name of affected) for (const dependant of dependencies[name] || []) affected.add(dependant);
    for (const name of affected) {
      if (issues.fields[name]) fields[name] = issues.fields[name]; else delete fields[name];
    }
    render();
    updateRateLink(issues.rate_pair);
    // Editing is quiet; announce only another submitted failure, not every keystroke.
    if (!Object.keys(fields).length && !issues.form) { summary.textContent = ''; summary.hidden = true; }
  };
  form.addEventListener('input', onEdit); form.addEventListener('change', onEdit);
  const controller = {
    validateSubmit() {
      const { values, issues } = collect();
      const valid = !Object.keys(issues.fields).length && !issues.form;
      if (!valid) show(issues); else controller.clear();
      return { valid, values };
    },
    show,
    clear() { for (const name of Object.keys(fields)) delete fields[name]; render(); summary.textContent = ''; summary.hidden = true; attempted = false; },
    dispose() { form.removeEventListener('input', onEdit); form.removeEventListener('change', onEdit); if (form.validation === controller) form.validation = null; },
  };
  form.validation = controller;
  return controller;
}

export const field = (label, input, hint) => `<label>${esc(label)}${input}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</label>`;
export const inp = (name, { type = "text", value = "", placeholder = "", required = false, step, min, max, list } = {}) =>
  `<input name="${esc(name)}" type="${type}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}"${required ? " required" : ""}${step ? ` step="${step}"` : ""}${min != null ? ` min="${min}"` : ""}${max != null ? ` max="${max}"` : ""}${list ? ` list="${list}"` : ""} />`;
export const sel = (name, list, selected, labelFn, valueFn) => `<select name="${esc(name)}">${option(list, selected, labelFn, valueFn).s}</select>`;
export const moneyInput = (name, value = "", placeholder = "0.00") => inp(name, { type: "text", value, placeholder, step: "any" }).replace("type=\"text\"", "type=\"text\" inputmode=\"decimal\"");

// Up to three whole numbers, one box each: alert points. No free text, nothing to mistype.
// Empty boxes mean fewer alerts; all empty means none.
export const numberBoxes = (prefix, values = [], { min = 1, max = 365, placeholder = "", label = "Reminder", legend = "Reminders" } = {}) =>
  `<fieldset class="number-boxes"><legend>${esc(legend)}</legend><div class="inline">${[0, 1, 2].map((i) => field(`${label} ${i + 1}`, inp(`${prefix}${i}`, { type: 'number', min, max, step: 1, value: values[i] ?? '', placeholder }).replace('type="number"', 'type="number" inputmode="numeric"'))).join('')}</div></fieldset>`;
export function readNumberBoxes(f, prefix, { min = 1, max = 365 } = {}) {
  const fields = {}, out = [];
  for (const i of [0, 1, 2]) {
    const name = `${prefix}${i}`, text = String(f.get(name) ?? '').trim();
    if (!text) continue;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) fields[name] = `Enter a whole number from ${min} to ${max}.`;
    else out.push(n);
  }
  if (Object.keys(fields).length) throw new ValidationError({ fields });
  return [...new Set(out)].sort((a, b) => b - a);
}
export function pctClass(p) {
  if (p == null) return "";
  if (p >= 100) return "over";
  if (p >= 80) return "near";
  return "";
}
export const bar = (p) => `<div class="bar"><i class="${pctClass(p)}" style="width:${Math.min(100, Math.max(0, p ?? 0))}%"></i></div>`;

export function navigate(hash) { location.hash = hash; }

// SVG line chart with crosshair tooltip. points: [{x: label, y: number|null}]
export function lineChart(points, { height = 160, fmtY = (v) => v, id = "chart" } = {}) {
  // Axis labels are short; the tooltip carries the full formatted value.
  const w = 600, h = height, pad = { l: 64, r: 12, t: 12, b: 24 };
  const ys = points.map((p) => p.y).filter((v) => v != null);
  if (!ys.length) return `<div class="empty">No points yet</div>`;
  const min = Math.min(...ys, 0), max = Math.max(...ys);
  const span = max - min || 1;
  const X = (i) => pad.l + (points.length === 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (points.length - 1));
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / span);
  const path = points.map((p, i) => (p.y == null ? null : `${i === 0 || points[i - 1].y == null ? "M" : "L"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`)).filter(Boolean).join(" ");
  const ticks = [min, min + span / 2, max];
  const grid = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(shortNum(t))}</text>`).join("");
  // A dot a point reads on a short series; on a long one the dots merge into beads and hide the line,
  // so past two years only the latest keeps its dot and the rest become crosshair anchors.
  const last = points.length - 1, dense = points.length > 24;
  const dots = points.map((p, i) => (p.y == null ? "" : `<circle class="dot${dense && i !== last ? " ghost" : ""}" cx="${X(i)}" cy="${Y(p.y)}" r="4" data-i="${i}"/>`)).join("");
  const step = Math.ceil(points.length / 4);
  const labels = points.map((p, i) => {
    // First and last always; interior ones on a regular step, unless one lands close enough to the
    // last label to sit on top of it, which is what a long series does to a fixed step.
    if (!(i === 0 || i === last || (i % step === 0 && last - i >= step * 0.6))) return "";
    // First and last hug the plot edges so neither is clipped.
    const anchor = i === 0 ? "start" : i === last ? "end" : "middle";
    const x = i === 0 ? pad.l : i === last ? w - pad.r : X(i);
    return `<text class="axis" x="${x}" y="${h - 6}" text-anchor="${anchor}">${esc(p.x)}</text>`;
  }).join("");
  const hit = points.map((_p, i) => `<rect data-i="${i}" x="${X(i) - (w - pad.l - pad.r) / (2 * Math.max(1, points.length - 1))}" y="0" width="${(w - pad.l - pad.r) / Math.max(1, points.length - 1)}" height="${h}" fill="transparent"/>`).join("");
  const data = esc(JSON.stringify(points.map((p) => ({ x: p.x, y: p.y == null ? null : fmtY(p.y), note: p.note }))));
  return `<div class="viz-wrap" data-chart="${id}" data-points="${data}"><svg class="viz" viewBox="0 0 ${w} ${h}" role="img" aria-label="Line chart">${grid}<path class="line" d="${path}"/>${dots}${labels}<line class="cross" data-cross x1="0" x2="0" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"/>${hit}</svg><div class="viz-tip" hidden></div></div>`;
}
// Progress towards a target, on a real time axis. Across runs from the start to the target date, so
// the empty stretch to the right of the line is the time still left. Up is the amount. The target is
// a dotted horizontal line, labelled where it ends; dotted because it is a level to reach, not data.
// points: [{date, y}] in date order; y in major units.
export function goalChart(points, { start, end, target, today, height = 180, fmtY = (v) => v, fmtX = (d) => d, id = "goal" } = {}) {
  if (!points.length) return `<div class="empty">Nothing saved towards it yet</div>`;
  const w = 600, h = height, pad = { l: 52, r: 12, t: 22, b: 26 };
  const t0 = Date.parse(start), t1 = Math.max(Date.parse(end), t0 + 86400000);
  const ys = points.map((p) => p.y);
  const min = Math.min(0, ...ys), max = Math.max(target, ...ys) * 1.04, span = max - min || 1;
  const X = (d) => pad.l + ((Math.min(t1, Math.max(t0, Date.parse(d))) - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / span);
  const ticks = [min, target / 2, target].filter((v, i, a) => a.indexOf(v) === i && v >= min);
  const grid = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="axis" x="${pad.l - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${esc(shortNum(t))}</text>`).join("");
  const goalLine = `<line class="target" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(target).toFixed(1)}" y2="${Y(target).toFixed(1)}"/><text class="target-label" x="${w - pad.r}" y="${(Y(target) - 6).toFixed(1)}" text-anchor="end">Target ${esc(fmtY(target))}</text>`;
  const path = points.map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  // One end-dot, on today. The rest are invisible anchors the crosshair snaps to: a dot on every
  // contribution breaks the line into dashes, and dashes are the target's mark, not the data's.
  const dots = points.map((p, i) => `<circle class="dot${i === points.length - 1 ? "" : " ghost"}" cx="${X(p.date).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4" data-i="${i}"/>`).join("");
  // Start and target date always; today only where it has room between them.
  const xs = [[start, "start"], [end, "end"]];
  const tx = X(today);
  if (tx - X(start) > 70 && X(end) - tx > 70) xs.push([today, "middle", "Today"]);
  const labels = xs.map(([d, a, text]) => {
    let x = tx;
    if (a === "start") x = pad.l;
    else if (a === "end") x = w - pad.r;
    return `<text class="axis" x="${x}" y="${h - 6}" text-anchor="${a}">${esc(text || fmtX(d))}</text>`;
  }).join("");
  const xsPts = points.map((p) => X(p.date));
  const hit = points.map((_p, i) => { const l = i ? (xsPts[i - 1] + xsPts[i]) / 2 : pad.l, r = i < points.length - 1 ? (xsPts[i] + xsPts[i + 1]) / 2 : xsPts[i] + 12; return `<rect data-i="${i}" x="${l.toFixed(1)}" y="0" width="${Math.max(24, r - l).toFixed(1)}" height="${h}" fill="transparent"/>`; }).join("");
  const data = esc(JSON.stringify(points.map((p) => ({ x: fmtX(p.date), y: fmtY(p.y) }))));
  return `<div class="viz-wrap" data-chart="${id}" data-points="${data}"><svg class="viz" viewBox="0 0 ${w} ${h}" role="img" aria-label="Saved so far against the target, over time">${grid}${goalLine}<path class="line" d="${path}"/>${dots}${labels}<line class="cross" data-cross x1="0" x2="0" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"/>${hit}</svg><div class="viz-tip" hidden></div></div>`;
}
// Compact axis label: 45739.7 -> "45.7k". Full value lives in the tooltip.
function shortNum(v) {
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = `${(v / 1e9).toFixed(1)}b`;
  else if (a >= 1e6) s = `${(v / 1e6).toFixed(1)}m`;
  else if (a >= 1e4) s = `${(v / 1e3).toFixed(0)}k`;
  else if (a >= 1e3) s = `${(v / 1e3).toFixed(1)}k`;
  else s = String(Math.round(v * 100) / 100);
  return s.replace(".0k", "k").replace(".0m", "m");
}
// Sparkline: shape only, no axes, never a substitute for the number beside it.
export function sparkline(values, { height = 34, id: _id = "spark" } = {}) {
  const ys = values.filter((v) => v != null);
  if (ys.length < 2) return "";
  const w = 120, pad = 3;
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const X = (i) => pad + (i * (w - pad * 2)) / (values.length - 1);
  const Y = (v) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const d = values.map((v, i) => (v == null ? null : `${i === 0 || values[i - 1] == null ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const lastI = values.length - 1, last = values[lastI];
  return `<svg class="spark" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/>${last == null ? "" : `<circle cx="${X(lastI).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2.5"/>`}</svg>`;
}

// Ranked horizontal bars: position in the order is the point, so sort by value and label directly.
// One hue for every bar - length already encodes the magnitude, so colour would say it twice.
export function rankedBars(items, { limit = 8, otherLabel = "Everything else", fmt = (v) => String(v) } = {}) {
  const rows = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (!rows.length) return `<div class="empty">Nothing to show yet</div>`;
  let shown = rows;
  if (rows.length > limit) {
    const tail = rows.slice(limit - 1);
    shown = [...rows.slice(0, limit - 1), { label: otherLabel, value: tail.reduce((s, r) => s + r.value, 0), isOther: true, count: tail.length }];
  }
  const max = Math.max(...shown.map((r) => r.value));
  return `<div class="rbars">${shown.map((r) => `<div class="rbar${r.isOther ? " other" : ""}">
      <span class="rbar-l" title="${esc(r.label)}">${esc(r.label)}${r.isOther && r.count ? ` (${r.count})` : ""}</span>
      <span class="rbar-t"><i style="width:${Math.max(2, (r.value / max) * 100)}%"></i></span>
      <span class="rbar-v">${esc(fmt(r.value))}</span>
    </div>`).join("")}</div>`;
}

// Part-to-whole: one proportional bar, never a pie. Pie segments of similar size cannot be compared.
export function partBar(segments, { legend = true } = {}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!total) return `<div class="empty">Nothing to divide up yet</div>`;
  const hues = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];
  const rows = segments.filter((x) => x.value > 0).slice(0, 6);
  return `<div class="pbar">${rows.map((x, i) => `<i style="width:${(x.value / total) * 100}%;background:var(${hues[i % hues.length]})" title="${esc(x.label)}"></i>`).join("")}</div>
    ${legend ? `<div class="legend">${rows.map((x, i) => `<span><i style="background:var(${hues[i % hues.length]})"></i>${esc(x.label)} ${esc(x.text ?? "")}</span>`).join("")}</div>` : ""}`;
}

// Net worth over time. Assets stack up from zero, what is owed stacks down from it, both
// held back to a wash so the solid net-worth line stays the thing you read. One scale, one axis.
export function stackedNetWorthChart(points, { height = 190, fmtY = (v) => String(v), id = "nwstack" } = {}) {
  if (points.length < 2) return "";
  const w = 600, pad = { l: 46, r: 12, t: 12, b: 26 };
  const up = points[0].up.map((b) => b.label), down = points[0].down.map((b) => b.label);
  const topAt = (p) => p.up.reduce((t, b) => t + b.value, 0);
  const botAt = (p) => -p.down.reduce((t, b) => t + b.value, 0);
  const max = Math.max(...points.map(topAt), ...points.map((p) => p.net), 0);
  const min = Math.min(...points.map(botAt), ...points.map((p) => p.net), 0);
  const span = max - min || 1;
  const X = (i) => pad.l + (i * (w - pad.l - pad.r)) / (points.length - 1);
  const Y = (v) => pad.t + (height - pad.t - pad.b) * (1 - (v - min) / span);
  // Within a group the parts are ordered, not separate identities, so each group gets one hue
  // at three depths. Six competing hues at 30% read as mud, especially on a dark surface.
  const wash = (sign, _idx) => `var(${sign > 0 ? "--s1" : "--s8"})`;
  const washOpacity = [0.42, 0.28, 0.17];
  const band = (_getter, idx, sign) => {
    const lower = [], upper = [];
    points.forEach((p, i) => {
      const list = sign > 0 ? p.up : p.down;
      let below = 0; for (let k = 0; k < idx; k++) below += list[k].value;
      const v = list[idx].value;
      lower.push([X(i), Y(sign * below)]);
      upper.push([X(i), Y(sign * (below + v))]);
    });
    const d = `M${upper.map((q) => q.map((n) => n.toFixed(1)).join(",")).join("L")}L${lower.reverse().map((q) => q.map((n) => n.toFixed(1)).join(",")).join("L")}Z`;
    return `<path class="nw-band" d="${d}" fill="${wash(sign, idx)}" opacity="${washOpacity[idx % 3]}"/>`;
  };
  const bands = up.map((_, i) => band(null, i, 1)).join("") + down.map((_, i) => band(null, i, -1)).join("");
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.net).toFixed(1)}`).join("");
  const ticks = [min, min + span / 2, max].filter((v, i, a) => a.indexOf(v) === i);
  // Short labels on the axis; the full formatted value rides in the tooltip.
  const grid = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(shortNum(t))}</text>`).join("");
  const zero = min < 0 ? `<line class="nw-zero" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(0)}" y2="${Y(0)}"/>` : "";
  const last = points.length - 1;
  const step = Math.ceil(points.length / 4);
  // Same rule as the line chart: an interior label that lands next to the last one is dropped.
  const labels = points.map((p, i) => (i === 0 || i === last || (i % step === 0 && last - i >= step * 0.6)
    ? `<text class="axis" x="${i === 0 ? pad.l : i === last ? w - pad.r : X(i)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}">${esc(p.x)}</text>` : "")).join("");
  const hit = points.map((_p, i) => `<rect data-i="${i}" x="${X(i) - (w - pad.l - pad.r) / (2 * last)}" y="0" width="${(w - pad.l - pad.r) / last}" height="${height}" fill="transparent"/>`).join("");
  const data = esc(JSON.stringify(points.map((p) => ({ x: p.x, y: fmtY(p.net) }))));
  const key = (l, sign, i) => `<span><i style="background:${wash(sign, i)};opacity:${washOpacity[i % 3]}"></i>${esc(l)}</span>`;
  // One band each side needs no group heading: the band's own name says it.
  const single = up.length === 1 && down.length === 1;
  const legend = `<div class="legend">${single ? "" : '<span class="legend-group">Owned</span>'}${up.map((l, i) => key(l, 1, i)).join("")}${single ? "" : '<span class="legend-group">Owed</span>'}${down.map((l, i) => key(l, -1, i)).join("")}<span><i class="k-net"></i>Net worth</span></div>`;
  return `<div class="viz-wrap" data-chart="${id}" data-points="${data}"><svg class="viz nw-chart" viewBox="0 0 ${w} ${height}" role="img" aria-label="Net worth over time">${grid}${bands}${zero}<path class="nw-line" d="${line}"/><line class="cross" data-cross x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/>${labels}${hit}</svg><div class="viz-tip" hidden></div></div>${legend}`;
}

export function bindCharts(root) {
  if (featurePaused("chartInspection")) return () => {};
  for (const wrap of root.querySelectorAll("[data-chart]")) {
    let pts;
    try { pts = JSON.parse(wrap.dataset.points || "[]"); } catch { continue; }
    const tip = wrap.querySelector(".viz-tip"), cross = wrap.querySelector("[data-cross]"), svg = wrap.querySelector("svg");
    svg.addEventListener("mousemove", (e) => {
      const t = e.target.closest("[data-i]"); if (!t) return;
      const i = Number(t.dataset.i), p = pts[i];
      const dot = svg.querySelector(`circle[data-i="${i}"]`);
      if (dot) { cross.setAttribute("x1", dot.getAttribute("cx")); cross.setAttribute("x2", dot.getAttribute("cx")); cross.setAttribute("visibility", "visible"); }
      tip.hidden = false; tip.textContent = `${p.x}: ${p.y ?? "—"}${p.note ? ` · ${p.note}` : ""}`;
      const r = wrap.getBoundingClientRect();
      tip.style.left = Math.min(r.width - 120, e.clientX - r.left + 10) + "px"; tip.style.top = e.clientY - r.top - 30 + "px";
    });
    svg.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  }
}

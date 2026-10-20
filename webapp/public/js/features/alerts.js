// Alerts: computed on device, deduped by key. Foundations §1.
import { store, nowIso } from "../lib/store.js";
import { html, raw, esc, commitAction } from "../lib/ui.js";
import { fmtDate } from "../lib/dates.js";
import { icon } from "../lib/icons.js";

export function fire({ type, severity = "info", source, dedupe_key, title, body, payload = {} }) {
  if (store.all("alerts", { includeDeleted: true }).some((a) => a.dedupe_key === dedupe_key)) return null;
  return store.insert("alerts", { type, severity, source, dedupe_key, title, body, payload, fired_at: nowIso(), read_at: null, dismissed_at: null });
}
export const unread = () => store.all("alerts").filter((a) => !a.read_at && !a.dismissed_at);
export const markRead = (id) => store.update("alerts", id, { read_at: nowIso() });
export const dismiss = (id) => store.update("alerts", id, { dismissed_at: nowIso() });

const LINK = {
  budget_threshold: "#/budgets", recurring_posted: "#/recurring", recurring_candidate: "#/recurring", price_change: "#/recurring", debt_lockin: "#/debts", debt_maturity: "#/debts",
  insurance_renewal: "#/insurance", goal_done: "#/goals", briefing_ready: "#/briefing", debt_cleared: "#/debts", sync: "#/settings", system: "#/settings",
};

export function alertsPage() {
  const list = store.all("alerts").filter((a) => !a.dismissed_at).sort((a, b) => b.fired_at.localeCompare(a.fired_at));
  return {
    title: "Alerts",
    html: html`<div class="card">${list.length ? raw(list.map((a) => `
      <div class="row alert-row">
        <div class="grow"><div class="title">${a.read_at ? "" : '<i class="dot-new" aria-label="New"></i>'}${esc(a.title)}</div>
        <div class="sub">${esc(a.body || "")}</div><div class="sub">${fmtDate(a.fired_at.slice(0, 10))}</div></div>
        <a class="btn small" href="${LINK[a.type] || "#/home"}" data-read="${a.id}">Open</a>
        <button class="small" data-dismiss="${a.id}">${icon("close", { size: 14 })}</button>
      </div>`).join("")) : raw('<div class="empty">Nothing to show. Alerts appear here when budgets cross a threshold, bills post, renewals come up, and so on.</div>')}</div>`,
    bind(root) {
      root.querySelectorAll("[data-read]").forEach((el) => (el.onclick = () => { void commitAction(() => markRead(el.dataset.read)).catch(() => {}); }));
      root.querySelectorAll("[data-dismiss]").forEach((el) => (el.onclick = () => { void commitAction(() => dismiss(el.dataset.dismiss)).catch(() => {}); }));
    },
  };
}

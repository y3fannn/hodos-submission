// Home: one chosen 4x2 panel, then a fixed four-column grid of function icons.
// Reuses the widget designs below. Drawing Home never calls AI.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, add, sub, exponent } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, esc, field, sel, modal, lineChart, bindCharts, sparkline, rankedBars, stackedNetWorthChart, rateLinks } from "../lib/ui.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as C from "./categories.js";
import * as T from "./transactions.js";
import * as B from "./budgets.js";
import * as NW from "./networth.js";
import * as G from "./goals.js";
import * as DB from "./debts.js";
import * as I from "./insurance.js";
import * as H from "./investments.js";
import * as AL from "./alerts.js";
import { session } from "../lib/session.js";
import * as BK from "./backup.js";
import * as INST from "./install.js";
import { icon } from "../lib/icons.js";
import { featurePaused } from "../lib/feature-policy.js";

const b0 = () => money(0, base());
// Compact for a quarter-width tile: 46519.70 -> "46.5k"
function short(m) {
  if (!m) return "—";
  const v = m.amount / 10 ** exponent(m.currency), a = Math.abs(v);
  const s = a >= 1e6 ? (v / 1e6).toFixed(1) + "m" : a >= 1e4 ? Math.round(v / 1e3) + "k" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(a < 100 ? 2 : 0);
  return s.replace(".0k", "k").replace(".0m", "m");
}
const pctTxt = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
// A quarter-width tile has no room for a formatted currency, so the unit rides along in small type.
const tiny = (m) => (m ? `${short(m)}<span class="w-unit">${esc(m.currency)}</span>` : "—");
const miss = (why) => `<div class="w-absent">—<span>${esc(why)}</span>${rateLinks([why])}</div>`;
const bar = (pct, cls = "") => `<div class="bar"><i class="${cls}" style="width:${Math.min(100, Math.max(0, pct ?? 0))}%"></i></div>`;
const rowList = (items, empty) => (items.length ? items.map((i) => `<div class="w-row"><span class="w-row-l">${esc(i.l)}</span><span class="w-row-r">${esc(i.r)}</span></div>`).join("") : `<div class="w-absent">—<span>${esc(empty)}</span></div>`);

// "SGD 161,661.53" at tile size wraps onto two lines and pushes the rows below out of the tile. The
// currency drops to small type in front, the way the hero amounts do, so the number keeps one line.
const splitUnit = (v) => String(v).replace(/^([−-]?)([A-Z]{3}) ([\d,.]+)$/, '<span class="w-cur">$2</span>$1$3');

// ---- catalogue ----
export const CATALOGUE = {
  safe_to_spend: { title: "Safe to spend", feature: "Budgets", href: "#/budgets", sizes: ["1x1", "2x2"], render(size) {
    const statuses = B.status();
    const incomplete = statuses.find((s) => s.reasons.length);
    if (incomplete) return { body: miss(incomplete.reasons[0]) };
    const st = statuses.filter((s) => s.safe);
    if (!st.length) return { body: miss("no category budgets yet") };
    const total = st.reduce((s, x) => add(s, x.safe), b0());
    const bills = st.reduce((n, x) => n + x.upcomingCount, 0);
    if (size === "1x1") return { value: tiny(total) };
    const tight = [...st].sort((a, b) => a.safe.amount - b.safe.amount).slice(0, 3);
    return { value: fmt(total), sub: `after ${bills} bill${bills === 1 ? "" : "s"} still due`, body: rowList(tight.map((x) => ({ l: x.name, r: fmt(x.safe) })), "") };
  } },
  budget: { title: "Budget", feature: "Budgets", href: "#/budgets", sizes: ["2x2", "4x2"], render(size) {
    const a = B.allocation();
    if (!a.expected.money) return { body: miss(a.expected.reason || "no expected income") };
    if (!a.spent) return { body: miss(a.reasons[0]) };
    const inc = a.expected.money;
    const p = (m) => (m && inc.amount > 0 ? Math.max(0, Math.min(100, (m.amount / inc.amount) * 100)) : 0);
    const spent = p(a.spent), committed = Math.max(0, p(a.allocated) - spent), target = p(a.target);
    return { value: fmt(inc), sub: "expected income this month",
      body: `<div class="bt-bar"><i class="seg spent" style="width:${spent}%"></i><i class="seg committed" style="width:${committed}%"></i><i class="seg target" style="width:${target}%"></i><i class="seg free" style="width:${Math.max(0, 100 - spent - committed - target)}%"></i></div>
        ${rowList([{ l: "Spent", r: fmt(a.spent) }, { l: "Allocated", r: fmt(a.allocated) }, ...(size === "4x2" && a.target ? [{ l: "Savings target", r: fmt(a.target) }] : []), { l: a.overAllocated ? "Over-allocated" : "Left to allocate", r: a.leftToAllocate ? fmt(a.leftToAllocate) : "—" }], "")}` };
  } },
  spend_month: { title: "Spent this month", feature: "Transactions", href: "#/transactions", sizes: ["1x1", "2x2"], render(size) {
    const m = B.month(), spent = B.spentIn(m), last = B.spentIn(B.prevMonth(m));
    if (!spent) return { body: miss(T.baseTotals(T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, m))).reasons[0]) };
    if (size === "1x1") return { value: tiny(spent) };
    const byCat = {};
    for (const t of T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, m) && T.baseAmount(t))) { const g = C.groupOf(C.get(t.category_id)); const k = g ? g.name : "Uncategorised"; byCat[k] = (byCat[k] || 0) + T.baseAmount(t).amount; }
    const rows = Object.entries(byCat).map(([label, value]) => ({ label, value }));
    return { value: fmt(spent), sub: `last month ${fmt(last)}`, body: rankedBars(rows, { limit: 4, fmt: (v) => fmt(money(v, base())) }) };
  } },
  savings: { title: "Saved this month", feature: "Budgets", href: "#/budgets", sizes: ["1x1", "2x2"], render(size) {
    const sv = B.savings();
    if (!sv.saved) return { body: miss(sv.reason || "no income received yet") };
    if (size === "1x1") return { value: tiny(sv.saved) };
    const spct = sv.target && sv.target.amount > 0 ? (sv.saved.amount / sv.target.amount) * 100 : null;
    return { value: fmt(sv.saved, { sign: true }), sub: sv.target ? (sv.onTrack ? "at or above target" : "below target") : sv.rate != null ? `${sv.rate}% of income received` : "",
      body: (spct != null ? bar(spct, sv.onTrack ? "" : "near") : "") + rowList([{ l: "Income received", r: fmt(sv.income) }, { l: "Spent", r: fmt(sv.spent) }, ...(sv.target ? [{ l: "Target", r: fmt(sv.target) }] : [])], "") };
  } },
  net_worth: { title: "Net worth", feature: "Net worth", href: "#/networth", sizes: ["1x1", "2x2", "4x2"], render(size) {
    const n = NW.now(), last = NW.priorMonthly();
    if (!n.total) return { body: miss(n.incomplete_reasons[0] || "nothing to add up yet") };
    const change = last?.total && last.base_currency === base() ? sub(n.total, last.total) : null;
    if (size === "1x1") return { value: tiny(n.total) };
    const ser = NW.series("amount");
    const out = { value: fmt(n.total), sub: change ? `${fmt(change, { sign: true })} since ${D.fmtDateShort(last.taken_at.slice(0, 10))}` : "no earlier snapshot yet" };
    if (size === "2x2") out.body = sparkline(ser.points.map((p) => p.y));
    if (size === "4x2") {
      const comp = NW.composition();
      out.body = comp.length > 1
        ? stackedNetWorthChart(comp, { height: 108, fmtY: (v) => fmt(money(Math.round(v * 10 ** exponent(base())), base())), id: "w-nw" })
        : rowList([{ l: "Accounts", r: n.components.accounts ? fmt(n.components.accounts) : "—" }, { l: "Investments", r: n.components.holdings ? fmt(n.components.holdings) : "—" }, { l: "Owed", r: fmt(add(n.components.credit || b0(), n.components.debts || b0())) }], "") + '<div class="w-sub">a line appears once there are two snapshots</div>';
    }
    return out;
  } },
  investments: { title: "Investments", feature: "Investments", href: "#/investments", sizes: ["1x1", "2x2", "4x2"], render(size) {
    const s = H.summary(), r = H.returns();
    if (!s.totalBase) return { body: miss(s.incomplete_reasons[0] || "nothing added yet"), footer: H.DISCLAIMER };
    const total = s.totalBase;
    if (size === "1x1") return { value: tiny(total) };
    const ser = H.series("amount");
    const out = { value: fmt(total), sub: `simple return ${pctTxt(r.simplePct)} · not advice`, footer: H.DISCLAIMER };
    if (size === "2x2") out.body = sparkline(ser.points.map((p) => p.y));
    if (size === "4x2") {
      out.body = ser.points.filter((p) => p.y != null).length > 1
        ? lineChart(ser.points, { height: 88, fmtY: (v) => fmt(money(Math.round(v * 10 ** exponent(base())), base())), id: "w-inv" })
        : rowList([{ l: "Put in", r: r.netContributed ? fmt(r.netContributed) : "—" }, { l: "Worth now", r: r.value ? fmt(r.value) : "—" }, { l: "Dollar-weighted", r: pctTxt(r.dollarWeightedPct) }], "") + '<div class="w-sub">a line appears once there are two valuation dates</div>';
    }
    return out;
  } },
  accounts: { title: "Accounts", feature: "Accounts", href: "#/accounts", sizes: ["2x2", "4x2"], render(size) {
    const rows = A.withBalances().slice(0, size === "4x2" ? 5 : 3);
    const tot = A.totalBase(true);
    if (!tot.total) return { body: miss(tot.reasons[0] || "Account totals incomplete") };
    return { value: fmt(tot.total), sub: "all accounts",
      body: rowList(rows.map((a) => ({ l: a.name, r: fmt(a.balance) })), "no accounts yet") };
  } },
  bills: { title: "Bills due", feature: "Recurring", href: "#/recurring", sizes: ["2x2", "4x2"], render(size) {
    const slots = size === "4x2" ? 5 : 3;
    const m = B.month();
    // How far ahead is the user's to choose, in Settings. 14 days unless changed.
    const days = store.one("insight_settings")?.bills_days ?? 14;
    const all = T.upcoming(today(), D.addDays(today(), days));
    const shown = all.slice(0, slots);
    let total = b0(); const reasons = [];
    for (const u of all) { const c = fx.toBase(u.money, base()); if (c.money) total = add(total, c.money); else reasons.push(c.reason); }
    if (reasons.length) return { body: miss(reasons[0]) };
    if (!all.length) return { value: fmt(total), sub: `next ${days} days`, body: miss(`nothing due in the next ${days} days`) };
    // A short list would leave the tile half empty, so the total and the window close it off.
    const rows = shown.map((u) => ({ l: `${u.rule.name} · ${D.fmtDateShort(u.date)}`, r: fmt(u.money) }));
    if (all.length > slots) rows.push({ l: `and ${all.length - slots} more`, r: "" });
    const later = T.upcoming(D.addDays(today(), days + 1), m.end).length;
    return { value: fmt(total), sub: `${all.length} due in the next ${days} days`,
      body: rowList(rows, "") + `<div class="w-sub">${later ? `then ${later} more before the month ends` : "nothing else due before the month ends"}</div>` };
  } },
  subscriptions: { title: "Subscriptions", feature: "Recurring", href: "#/recurring", sizes: ["1x1", "2x2"], render(size) {
    const subs = T.subscriptions();
    if (!subs.length) return { body: miss("no regular payments set up") };
    const t = T.subscriptionTotals(subs);
    if (size === "1x1") return { value: tiny(t.perYear) };
    const found = subs.filter((x) => x.found).length;
    return { value: fmt(t.perYear), sub: `a year · ${t.count} subscription${t.count === 1 ? "" : "s"}${found ? ` · ${found} not set up` : ""}`, body: rowList(subs.slice(0, 3).map((x) => ({ l: x.name, r: x.perMonth ? `${fmt(x.perMonth)}/mo` : "—" })), "") };
  } },
  goals: { title: "Goals", feature: "Goals", href: "#/goals", sizes: ["2x2", "4x2"], render(size) {
    const all = G.list("active");
    if (!all.length) return { body: miss("no goals set") };
    if (size === "2x2") {
      // One goal in full. A list of one would leave half the tile blank.
      // The goal whose date comes soonest, since that is the one a month's saving matters most to.
      const pick = all.map((x) => ({ g: x, s: G.status(x) })).sort((a, b) => a.g.target_date.localeCompare(b.g.target_date))[0];
      return { value: pick.s.progress ? fmt(pick.s.progress) : "—", sub: `${pick.g.name} · of ${fmt(pick.g.target)}`,
        body: (pick.s.pct === null ? miss(pick.s.reason) : bar(pick.s.pct)) + rowList([{ l: "Per month", r: pick.s.monthlyNeeded ? fmt(pick.s.monthlyNeeded) : pick.s.overdue ? "date passed" : "—" }, { l: "Still to go", r: pick.s.remaining ? fmt(pick.s.remaining) : "—" }, { l: "By", r: D.fmtDateShort(pick.g.target_date) }], "") };
    }
    return { sub: `${all.length} goal${all.length > 1 ? "s" : ""}`, body: all.slice(0, 4).map((x) => { const st = G.status(x); return `<div class="w-goal"><div class="w-row"><span class="w-row-l">${esc(x.name)}</span><span class="w-row-r">${st.monthlyNeeded ? fmt(st.monthlyNeeded) + "/mo" : st.pct == null ? "—" : st.pct + "%"}</span></div>${st.pct === null ? miss(st.reason) : bar(st.pct)}</div>`; }).join("") };
  } },
  debts: { title: "Owed", feature: "Debts", href: "#/debts", sizes: ["1x1", "2x2"], render(size) {
    const ds = DB.list("active");
    if (!ds.length) return { body: miss("no debts tracked") };
    let total = b0(); let partial = false;
    for (const d of ds) { const bal = DB.balanceOf(d); const c = bal && bal.currency === base() ? bal : null; if (c) total = add(total, c); else partial = true; }
    if (size === "1x1") return { value: tiny(total) };
    return { value: fmt(total), sub: `${ds.length} debt${ds.length > 1 ? "s" : ""}${partial ? " · one in another currency not added" : ""}`,
      body: rowList(ds.slice(0, 3).map((d) => { const bal = DB.balanceOf(d); return { l: d.name, r: bal ? fmt(bal) : "—" }; }), "") };
  } },
  insurance: { title: "Next renewal", feature: "Insurance", href: "#/insurance", sizes: ["1x1", "2x2"], render(size) {
    const next = I.list("active").filter((p) => p.renewal_date).sort((a, b) => a.renewal_date.localeCompare(b.renewal_date))[0];
    if (!next) return { body: miss("no policies with a renewal date") };
    const days = D.daysBetween(today(), next.renewal_date);
    if (size === "1x1") return { value: days >= 0 ? `${days}d` : "due" };
    const soon = I.list("active").filter((x) => x.renewal_date).sort((a, b) => a.renewal_date.localeCompare(b.renewal_date)).slice(0, 3);
    return { value: D.fmtDate(next.renewal_date), sub: `${next.insurer} · ${days >= 0 ? days + " days away" : "date has passed"}`,
      body: rowList(soon.map((x) => ({ l: `${x.insurer} ${x.type.replace("_", " ")}`, r: D.fmtDateShort(x.renewal_date) })), "") };
  } },
  alerts: { title: "Alerts", feature: "Alerts", href: "#/alerts", sizes: ["1x1", "2x2"], render(size) {
    const un = AL.unread();
    if (size === "1x1") return { value: String(un.length) };
    return { value: String(un.length), sub: un.length ? "unread" : "nothing needs a look",
      body: rowList(un.slice(0, 3).map((a) => ({ l: a.title, r: a.fired_at.slice(5, 10) })), "nothing needs a look") };
  } },
  briefing: { title: "Briefing", feature: "Insights", href: "#/briefing", sizes: ["2x2", "4x2"], render(size) {
    if (featurePaused("briefings")) return { body: miss("Briefing is temporarily unavailable") };
    const all = store.all("briefings").sort((a, b) => b.period.start.localeCompare(a.period.start));
    if (!all.length) return { body: miss("builds after a full budget month ends") };
    const b = all[0];
    if (b.stats?.incomplete_reasons?.length) return { body: miss(b.stats.incomplete_reasons.join("; ")) };
    const prose = `<p class="w-prose">${esc(b.summary || "Numbers only; the words were not available.")}</p>`;
    if (size === "2x2") return { sub: `${D.fmtDateShort(b.period.start)} – ${D.fmtDateShort(b.period.end)}`, body: prose };
    return { sub: `${D.fmtDateShort(b.period.start)} – ${D.fmtDateShort(b.period.end)}`, body: prose + rowList((b.options || []).slice(0, 3).map((o) => ({ l: o.title, r: "" })), "") };
  } },
  spend_breakdown: { title: "Where it goes", feature: "Budgets", href: "#/deepdive", sizes: ["2x2", "4x2"], render(size) {
    if (featurePaused("deepDive")) return { body: miss("Deep dive is temporarily unavailable") };
    const m = B.month(); const byCat = {};
    const totals = T.baseTotals(T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, m)));
    if (!totals.total) return { body: miss(totals.reasons[0]) };
    for (const t of T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, m) && T.baseAmount(t))) { const g = C.groupOf(C.get(t.category_id)); const k = g ? g.name : "Uncategorised"; byCat[k] = (byCat[k] || 0) + T.baseAmount(t).amount; }
    const rows = Object.entries(byCat).map(([label, value]) => ({ label, value }));
    if (!rows.length) return { body: miss("nothing spent this month yet") };
    return { sub: "this budget month", body: rankedBars(rows, { limit: size === "4x2" ? 7 : 4, fmt: (v) => fmt(money(v, base())) }) };
  } },
  uncategorised: { title: "No category", feature: "Transactions", href: "#/transactions", sizes: ["1x1"], render() {
    return { value: String(T.live().filter((t) => t.kind !== "transfer" && !t.category_id).length) };
  } },
};

// ---- fixed function icons ----
// Object order is display order. The four duplicated functions remain in the bottom bar.
export const SHORTCUTS = {
  budgets: { title: "Budgets", icon: icon("budgets", { size: 26 }), href: "#/budgets" },
  accounts: { title: "Accounts", icon: icon("accounts", { size: 26 }), href: "#/accounts" },
  networth: { title: "Net worth", icon: icon("networth", { size: 26 }), href: "#/networth" },
  investments: { title: "Investments", icon: icon("investments", { size: 26 }), href: "#/investments" },
  goals: { title: "Goals", icon: icon("goals", { size: 26 }), href: "#/goals" },
  debts: { title: "Debts", icon: icon("debts", { size: 26 }), href: "#/debts" },
  insurance: { title: "Insurance", icon: icon("insurance", { size: 26 }), href: "#/insurance" },
  briefing: { title: "Briefing", icon: icon("briefing", { size: 26 }), href: "#/briefing" },
  recurring: { title: "Recurring", icon: icon("recurring", { size: 26 }), href: "#/recurring" },
  categories: { title: "Categories", icon: icon("categories", { size: 26 }), href: "#/categories" },
  alerts: { title: "Alerts", icon: icon("alerts", { size: 26 }), href: "#/alerts" },
};
const DEFAULT_PANEL = "budget";
// Catalogue capability, not today's quantity of data: empty panels remain selectable at 4x2.
const panelPaused = (key) => featurePaused({ briefing: "briefings", spend_breakdown: "deepDive" }[key]);
export const panelChoices = () => Object.keys(CATALOGUE).filter((key) => CATALOGUE[key].sizes.includes("4x2") && !panelPaused(key));
export function panelKey() {
  const key = store.one("home_layout")?.panel_key;
  return panelChoices().includes(key) ? key : DEFAULT_PANEL;
}
export function selectPanel(key) {
  if (!panelChoices().includes(key)) throw new Error("Choose one of the available top panels.");
  store.upsertOne("home_layout", { panel_key: key, widgets: undefined, edited_at: nowIso() });
}
export function layout() {
  return [
    { kind: "widget", key: panelKey(), size: "4x2" },
    ...Object.keys(SHORTCUTS).map((key) => ({ kind: "shortcut", key, size: "1x1" })),
  ];
}

function widgetHtml(w) {
  const c = CATALOGUE[w.key];
  let r = {};
  try { r = c.render(w.size) || {}; } catch (e) { console.error(w.key, e); r = { body: miss("this widget could not be drawn") }; }
  return `<section class="tile widget w-4x2 home-panel" data-wid="widget:${w.key}" data-href="${c.href}" aria-label="${esc(c.title)}">
    <a class="w-title" href="${c.href}">${esc(c.title)} →</a>
    ${r.value != null ? `<div class="w-value">${splitUnit(r.value)}</div>` : ""}
    ${r.sub ? `<div class="w-sub">${esc(r.sub)}</div>` : ""}
    ${r.body || ""}
    ${r.footer ? `<p class="w-disclaimer">${esc(r.footer)}</p>` : ""}
  </section>`;
}
function shortcutHtml(w) {
  const s = SHORTCUTS[w.key];
  // Only the alerts icon carries a count, for the same reason a phone does: it is the one that decays.
  const n = w.key === "alerts" ? AL.unread().length : 0;
  const href = s.href;
  return `<a class="tile shortcut" data-wid="shortcut:${w.key}" data-href="${href}" href="${href}">
    <span class="sc-ic" aria-hidden="true">${s.icon}</span><span class="sc-t">${esc(s.title)}</span>
    ${n ? `<span class="sc-badge">${n}</span>` : ""}</a>`;
}
const tileHtml = (w) => (w.kind === "shortcut" ? shortcutHtml(w) : widgetHtml(w));

export function homePage() {
  const l = layout();
  return {
    title: "Home",
    html: html`${session.mode === "open" ? raw(INST.hintHtml() + BK.nudgeHtml()) : ""}
      <div class="home-head"><span class="muted">Budget month · ${D.fmtDateShort(B.month().start)} – ${D.fmtDateShort(B.month().end)}</span></div>
      <div class="widget-grid home-grid">${raw(l.map(tileHtml).join(""))}</div>`,
    bind(root) {
      bindCharts(root);
      BK.bindNudge(root); INST.bindHint(root, rerender);
      const grid = root.querySelector(".widget-grid");
      const releaseHold = bindPanelHold(root.querySelector(".home-panel"));
      grid?.addEventListener("click", (e) => {
        const el = e.target.closest(".home-panel");
        if (!el || e.target.closest("a, button, input, form, .viz-wrap")) return;
        location.hash = el.dataset.href;
      });
      return releaseHold;
    },
  };
}
function rerender() { window.dispatchEvent(new HashChangeEvent("hashchange")); }

// Shared by the hold gesture and Settings. Only the existing account-owned preference is saved.
export function openPanelPicker({ returnFocus } = {}) {
  const profile = store.one("profile"), hash = location.hash, mode = session.mode, generation = store.generation();
  const available = () => store.generation() === generation && store.one("profile") === profile && location.hash === hash && session.mode === mode;
  const controller = new AbortController();
  const picker = modal({ title: "Home panel", body: field("Panel contents", sel("home_panel", panelChoices(), panelKey(), (key) => CATALOGUE[key].title)),
    dismissOnBackdrop: true, initialFocus: "select",
    returnFocus: returnFocus ? () => document.querySelector('[data-action="home-panel"]') : null,
    onClose: () => controller.abort(),
    submitLabel: "Save", onSubmit: (f) => {
      if (!available()) throw new Error("Access changed. Open the Home panel choice again.");
      selectPanel(f.get("home_panel"));
    } });
  // Shared modal handles Escape, focus containment/return and the picker's explicit backdrop opt-in.
  const close = () => picker.close("cancel");
  window.addEventListener("hashchange", close, { signal: controller.signal });
  // Same-owner redraws can occur on the durable acknowledgement. Keep the saving dialog alive;
  // the shared modal closes it afterwards and resolves return focus against the redrawn page.
  return ({ redraw = false } = {}) => { if (!redraw || !available()) close(); };
}

function bindPanelHold(panel) {
  const controller = new AbortController(), signal = controller.signal;
  let timer, pointer, start, held = false, closePicker;
  const cancel = () => { clearTimeout(timer); timer = null; pointer = null; panel.removeAttribute("data-hold-pending"); };
  const dismiss = () => { cancel(); held = false; closePicker?.(); closePicker = null; };
  panel.addEventListener("pointerdown", (e) => {
    // Inputs/buttons keep their native interaction.
    if (!e.isPrimary || e.button !== 0 || e.target.closest("input, button, select, textarea, form, .viz-wrap")) return;
    dismiss(); pointer = e.pointerId; start = { x: e.clientX, y: e.clientY }; panel.setAttribute("data-hold-pending", "");
    timer = setTimeout(() => {
      timer = null;
      if (!panel.isConnected || !["open", "demo"].includes(session.mode) || document.hidden) return cancel();
      held = true; closePicker = openPanelPicker();
    }, 600);
  });
  window.addEventListener("pointermove", (e) => {
    if (e.pointerId === pointer && !held && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  }, { signal, passive: true });
  window.addEventListener("pointerup", cancel, { signal, passive: true });
  window.addEventListener("pointerdown", (e) => { if (pointer != null && e.pointerId !== pointer) cancel(); held = false; }, { signal, capture: true, passive: true });
  window.addEventListener("pointercancel", dismiss, { signal, passive: true });
  window.addEventListener("scroll", cancel, { signal, capture: true, passive: true });
  window.addEventListener("hashchange", dismiss, { signal });
  window.addEventListener("blur", dismiss, { signal });
  window.addEventListener("pagehide", dismiss, { signal });
  document.addEventListener("visibilitychange", dismiss, { signal });
  // Touch may retarget its finishing click to the newly opened backdrop. Suppress that click
  // in capture; the next pointerdown clears the flag, so ordinary taps are never swallowed.
  window.addEventListener("click", (e) => {
    if (!held || e.detail === 0) return;
    held = false; e.preventDefault(); e.stopPropagation();
  }, { signal, capture: true });
  panel.addEventListener("contextmenu", (e) => { if (timer || held) e.preventDefault(); });
  return () => { cancel(); held = false; closePicker?.({ redraw: true }); closePicker = null; controller.abort(); };
}

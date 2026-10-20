// Budgets: expected income, allocation, category limits, savings target. Overall is derived, never set.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, fmtBare, fmtSplit, parseMoney, isMoney, CURRENCIES, add, sub, toDecimalString } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, absent, moneyInput, esc, heroAmount, rateLinks, ValidationError, bindValidation } from "../lib/ui.js";
import { base, today } from "./profile.js";
import * as C from "./categories.js";
import * as T from "./transactions.js";
import * as AL from "./alerts.js";
import { icon } from "../lib/icons.js";

export const settings = () => store.one("budget_settings") || { start_day: 1, default_thresholds: [80, 100] };
export const month = (date = today()) => D.budgetMonth(date, settings().start_day);
export const prevMonth = (bm) => D.prevBudgetMonth(bm, settings().start_day);
// scope "overall" is retired (ruled 2026-09-18). Never returned, archived on migrate().
export const active = () => store.all("budgets").filter((b) => !b.archived_at && b.scope !== "overall");
export function migrate() {
  for (const b of store.all("budgets").filter((b) => b.scope === "overall" && !b.archived_at)) store.update("budgets", b.id, { archived_at: nowIso() });
}
const b0 = () => money(0, base());

// ---------- expected income ----------
// From the recurring income rules due inside this budget month. Expected, never received.
export function expectedIncome(m = month()) {
  const s = settings();
  if (s.expected_income_override) return { money: s.expected_income_override, source: "user", sources: [], reason: null };
  const rules = T.rules().filter((r) => r.template.kind === "income" && !r.paused_at);
  if (!rules.length) return { money: null, source: "none", sources: [], reason: "no recurring income rules yet" };
  let total = b0(); const sources = []; let reason = null;
  for (const r of rules) {
    const dates = T.dueDates(r, m.end, { from: m.start, ignorePosted: true, limit: 60 });
    if (!dates.length) continue;
    const conv = fx.toBase(r.template.money, base());
    if (!conv.money) { reason = conv.reason; total = null; continue; }
    const amt = money(conv.money.amount * dates.length, base());
    sources.push({ name: r.name, amount: amt, count: dates.length });
    if (total) total = add(total, amt);
  }
  if (!sources.length && !reason) return { money: null, source: "none", sources: [], reason: "no income due inside this budget month" };
  return { money: total, source: "rules", sources, reason };
}
export function setOverride(value) {
  if (value !== null && (!validBaseMoney(value))) throw new ValidationError({ fields: { amount: `Enter a valid amount in ${base()}, or clear the override.` } });
  return store.upsertOne("budget_settings", { ...settings(), expected_income_override: value });
}

// ---------- allocation (the top block) ----------
// allocated sums group limits, plus subcategory limits whose group has no limit. Never counted twice.
export function allocated() {
  const rows = active().filter((b) => b.scope === "category" && b.limit);
  const groupIds = new Set(rows.map((b) => C.get(b.category_id)).filter((c) => c && C.isGroup(c)).map((c) => c.id));
  let total = b0();
  for (const b of rows) {
    const c = C.get(b.category_id); if (!c) continue;
    if (!C.isGroup(c) && groupIds.has(c.parent_id)) continue;
    total = add(total, b.limit);
  }
  return total;
}
export function allocation(m = month()) {
  const ei = expectedIncome(m);
  const alloc = allocated();
  const spent = spentIn(m);
  const sv = savings(m);
  const target = sv.target;
  const leftToAllocate = ei.money ? sub(sub(ei.money, target || b0()), alloc) : null;
  const reasons = [...baseSum(expensesIn(m, null)).reasons];
  if (!ei.money) reasons.push(ei.reason);
  if (sv.reason) reasons.push(sv.reason);
  return { expected: ei, target, allocated: alloc, spent, received: sv.income, leftToAllocate, overAllocated: Boolean(leftToAllocate && leftToAllocate.amount < 0), reasons: reasons.filter(Boolean) };
}

// ---------- per-category ----------
export function limitFor(b, m) {
  if (m.start >= b.active_from) return { limit: b.limit, target: b.target };
  const h = (b.history || []).find((x) => m.start >= x.from && m.start <= x.to);
  return h ? { limit: h.limit, target: h.target } : { limit: null, target: null };
}
const expensesIn = (m, catIds) => T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, m) && (!catIds || catIds.includes(t.category_id)));
const baseSum = T.baseTotals;
export const spentIn = (m = month()) => baseSum(expensesIn(m, null)).total;

export function upcomingBills(m) {
  return T.upcoming(D.addDays(today(), 1), m.end).map((u) => { const c = fx.toBase(u.money, base()); return { ...u, base: c.money, reason: c.reason }; });
}
export function status(m = month()) {
  const bills = upcomingBills(m);
  return active().filter((b) => b.scope === "category").map((b) => {
    const { limit } = limitFor(b, m);
    const cat = b.category_id ? C.get(b.category_id) : null;
    const ids = cat ? C.subtreeIds(cat.id) : null;
    const { total: spent, missing, reasons } = baseSum(expensesIn(m, ids));
    const left = limit ? sub(limit, spent) : null;
    const catBills = cat ? bills.filter((x) => ids.includes(x.rule.template.category_id)) : bills;
    const up = catBills.reduce((s, x) => (s && x.base ? add(s, x.base) : null), b0());
    const safe = left && up ? sub(left, up) : null;
    const pct = limit && spent && limit.amount > 0 ? Math.round((spent.amount / limit.amount) * 100) : null;
    return { budget: b, category: cat, limit, spent, left, upcoming: up, upcomingCount: catBills.length, safe, pct, missing, reasons: [...reasons, ...catBills.map((x) => x.reason).filter(Boolean)], name: cat ? C.label(cat) : "—" };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}
export function savings(m = month()) {
  const inc = T.live().filter((t) => t.kind === "income" && D.inRange(t.date, m));
  const income = baseSum(inc), spent = baseSum(expensesIn(m, null));
  const saved = sub(income.total, spent.total);
  const b = active().find((x) => x.scope === "savings");
  let target = null, reason = null;
  if (b) {
    const { target: t } = limitFor(b, m);
    if (t?.amount) target = t.amount;
    else if (t?.percent_of_income != null) {
      const ei = expectedIncome(m);
      if (!ei.money) reason = `savings target is ${t.percent_of_income}% of expected income, which is ${ei.reason}`;
      else target = money(Math.round((ei.money.amount * t.percent_of_income) / 100), base());
    }
  }
  const reasons = [...income.reasons, ...spent.reasons];
  if (reasons.length) reason = reasons.join("; ");
  const rate = income.total && saved && income.total.amount > 0 ? Math.round((saved.amount / income.total.amount) * 100) : null;
  return { income: inc.length ? income.total : null, spent: spent.total, saved: inc.length ? saved : null, target, reason, reasons, incomeIncomplete: income.missing > 0, onTrack: target && inc.length && saved ? saved.amount >= target.amount : null, rate, budget: b };
}

// ---------- write ----------
export const THRESHOLD_MAX = 3;
const validBaseMoney = (value) => isMoney(value) && Number.isSafeInteger(value.amount) && CURRENCIES.includes(value.currency) && value.currency === base();

export function cleanThresholds(list) {
  if (!Array.isArray(list)) throw new ValidationError({ form: "Alert points must be supplied as a list of up to three numbers." });
  if (list.length > THRESHOLD_MAX) throw new ValidationError({ form: `Choose no more than ${THRESHOLD_MAX} alert points.` });
  const out = [];
  for (const [index, value] of list.entries()) {
    if (value === "") continue;
    const text = typeof value === "string" ? value.trim() : "";
    const n = typeof value === "number" ? value : typeof value === "string" && text ? Number(text) : NaN;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) throw new ValidationError({ fields: { [`th${index}`]: "Enter a whole alert point from 1 to 200, or leave this box empty." } });
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}
export function set(scope, { categoryId, limit, target, thresholds } = {}) {
  const fields = {};
  if (!['category', 'savings'].includes(scope)) throw new ValidationError({ form: "Choose a category budget or savings target." });
  let normalizedLimit = limit ?? null, normalizedTarget = target ?? null;
  if (scope === "category") {
    const category = C.get(categoryId);
    if (!categoryId || !category || category.kind !== "expense" || !C.all().some((item) => item.id === categoryId)) fields.cat = "Choose a live expense category or subcategory.";
    if (!validBaseMoney(limit)) fields.limit = `Enter a valid limit in ${base()}.`;
    normalizedTarget = null;
  } else {
    normalizedLimit = null;
    if (!target || typeof target !== "object" || Array.isArray(target)) fields.target = "Enter a savings amount or a whole percent of expected income.";
    else if (Object.hasOwn(target, "amount")) {
      if (!validBaseMoney(target.amount)) fields.amount = `Enter a valid savings amount in ${base()}.`;
      normalizedTarget = { amount: target.amount };
    } else if (Object.hasOwn(target, "percent_of_income")) {
      const percent = target.percent_of_income;
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) fields.pct = "Enter a whole percent from 1 to 100.";
      normalizedTarget = { percent_of_income: percent };
    } else fields.target = "Enter a savings amount or a whole percent of expected income.";
  }
  let normalizedThresholds, formIssue = "";
  try { normalizedThresholds = thresholds === undefined ? cleanThresholds(settings().default_thresholds) : cleanThresholds(thresholds); }
  catch (error) { if (error instanceof ValidationError) { Object.assign(fields, error.fields); formIssue = error.form; } else throw error; }
  if (Object.keys(fields).length || formIssue) throw new ValidationError({ fields, form: formIssue });
  const cur = month();
  const existing = active().find((b) => b.scope === scope && (scope !== "category" || b.category_id === categoryId));
  const warnings = [];
  if (scope === "category") {
    const c = C.get(categoryId), parent = C.parentOf(c);
    if (parent) {
      const pb = active().find((b) => b.category_id === parent.id);
      if (pb) { const sibs = active().filter((b) => C.get(b.category_id)?.parent_id === parent.id && b.id !== existing?.id).reduce((s, b) => s + b.limit.amount, 0) + limit.amount; if (sibs > pb.limit.amount) warnings.push(`Subcategory limits add up to ${fmt(money(sibs, base()))}, above the ${parent.name} limit of ${fmt(pb.limit)}.`); }
    }
  }
  if (existing) store.update("budgets", existing.id, { active_to: prevMonth(cur).start, archived_at: nowIso() });
  const row = store.insert("budgets", { scope, category_id: categoryId || null, limit: normalizedLimit, target: normalizedTarget, thresholds: normalizedThresholds, active_from: cur.start, active_to: null, archived_at: null, history: existing ? [...(existing.history || []), { limit: existing.limit, target: existing.target, from: existing.active_from, to: prevMonth(cur).end }] : [] });
  const a = allocation(cur);
  if (a.overAllocated) warnings.push(`You are over-allocated by ${fmt(money(-a.leftToAllocate.amount, base()))}. Allowed, and shown on the page.`);
  return { row, warnings };
}
export const remove = (id) => store.update("budgets", id, { archived_at: nowIso() });

export function checkThresholds() {
  const m = month();
  for (const s of status(m)) {
    if (s.pct == null) continue;
    for (const th of s.budget.thresholds || []) if (s.pct >= th) AL.fire({ type: "budget_threshold", severity: th >= 100 ? "warn" : "info", source: { feature: "budgets", entity_id: s.budget.id }, dedupe_key: `budget:${s.budget.id}:${m.start}:${th}`, title: `${s.name} at ${s.pct}% of budget`, body: `Spent ${fmt(s.spent)} of ${fmt(s.limit)} this budget month (${D.fmtDateShort(m.start)} – ${D.fmtDateShort(m.end)}).` });
    if (s.safe && s.safe.amount < 0) AL.fire({ type: "budget_threshold", severity: "warn", source: { feature: "budgets", entity_id: s.budget.id }, dedupe_key: `budget:${s.budget.id}:${m.start}:safe`, title: `${s.name}: bills due exceed what is left`, body: `Left ${fmt(s.left)}, bills still due ${fmt(s.upcoming)}.` });
  }
}

// ---------- page ----------
const pctOf = (part, whole) => (whole && whole.amount > 0 && part ? Math.max(0, Math.min(100, (part.amount / whole.amount) * 100)) : 0);

// The bar carries the same subtraction the three numbers spell out: spent, then bills still due,
// then what is left. Reading it replaces doing the arithmetic.
function segBar(s) {
  const lim = s.limit ? s.limit.amount : 0;
  if (lim <= 0 || !s.spent) return '<div class="hint">Spending total incomplete</div>';
  const pc = (v) => Math.max(0, Math.min(100, (v / lim) * 100));
  const spent = pc(s.spent.amount);
  const bills = s.upcoming ? Math.min(pc(s.upcoming.amount), Math.max(0, 100 - spent)) : 0;
  const over = s.spent.amount > lim;
  return `<div class="tribar" role="img" aria-label="spent ${s.pct}% of the limit">
    <i class="t-spent ${over ? "over" : s.pct >= 80 ? "near" : ""}" style="width:${spent}%"></i>
    ${bills > 0 ? `<i class="t-bills" style="width:${bills}%"></i>` : ""}
  </div>
  <div class="tri-key">${over ? "over the limit" : `spent${bills > 0 ? " · bills still due" : ""} · safe to spend`}</div>`;
}

export function budgetsPage() {
  const m = month(), a = allocation(m), st = status(m), sv = savings(m);
  const ei = a.expected;
  const inc = ei.money;
  const committed = inc && a.spent ? Math.max(0, a.allocated.amount - a.spent.amount) : 0;
  const segSpent = pctOf(a.spent, inc), segCommitted = inc ? pctOf(money(committed, base()), inc) : 0;
  const segTarget = a.target ? pctOf(a.target, inc) : 0;
  const segFree = Math.max(0, 100 - segSpent - segCommitted - segTarget);
  const row = (label, value, cls = "", note = "") => `<div class="num-row ${cls}"><dt>${esc(label)}${note ? `<span class="num-note">${esc(note)}</span>` : ""}</dt><dd>${value}</dd></div>`;

  const top = inc && a.spent
    ? `<div class="bt-bar" role="img" aria-label="Expected income, divided">
         <i class="seg spent" style="width:${segSpent}%"></i><i class="seg committed" style="width:${segCommitted}%"></i><i class="seg target" style="width:${segTarget}%"></i><i class="seg free" style="width:${segFree}%"></i>
       </div>
       <div class="unit-note">all amounts in ${base()}</div>
       <div class="legend"><span><i class="k-spent"></i>Spent</span><span><i class="k-committed"></i>Allocated, not yet spent</span>${a.target ? '<span><i class="k-target"></i>Savings target</span>' : ""}<span><i class="k-free"></i>Left to allocate</span></div>
       <dl class="num-list">
         ${row("Spent so far", fmtBare(a.spent))}
         ${row("Allocated to categories", fmtBare(a.allocated))}
         ${a.target ? row("Savings target", fmtBare(a.target)) : ""}
         ${row("Left to allocate", a.leftToAllocate ? fmtBare(a.leftToAllocate) : "—", a.overAllocated ? "bad" : "free", a.overAllocated ? "over-allocated" : "unallocated and unspent")}
       </dl>`
    : `<div class="card warn" style="margin:12px 0 0"><b>${inc ? "Spending total is incomplete." : "Expected income is not known yet."}</b><br>${esc(ei.reason || a.reasons.join("; "))}. Update missing conversions or add a recurring income rule under Recurring, or type a number below. Your category budgets still work.</div>`;

  const catRow = (s) => `<div class="cat-row">
      <div class="cat-head"><span class="cat-name">${esc(s.name)}</span><span class="cat-pct">${s.pct != null ? s.pct + "%" : "—"}</span></div>
      <div class="cat-of">${fmtBare(s.spent)} spent of ${s.limit ? fmtBare(s.limit) : "—"}</div>
      ${segBar(s)}
      <dl class="num-list">
        ${row("Left to spend", s.left ? fmtBare(s.left) : "—")}
        ${row("Bills still due", s.upcoming ? fmtBare(s.upcoming) : "—", "", s.upcomingCount ? `${s.upcomingCount} bill${s.upcomingCount > 1 ? "s" : ""} before month end` : "none before month end")}
        ${row("Safe to spend", s.safe ? fmtBare(s.safe) : "—", s.safe && s.safe.amount < 0 ? "bad" : "good", "left minus bills still due")}
      </dl>
      ${s.missing ? `<div class="hint">${s.missing} record${s.missing > 1 ? "s have" : " has"} no saved base conversion. Totals stay incomplete.</div>` : ""}
      ${rateLinks(s.reasons)}
      <div class="actions"><button class="small" data-edit="${s.budget.id}">Edit</button><button class="small" data-remove="${s.budget.id}">Remove</button></div>
    </div>`;

  return {
    title: "Budgets",
    html: html`<p class="muted">Budget month ${D.fmtDate(m.start)} – ${D.fmtDate(m.end)}. Starts on day ${settings().start_day}; change it in Settings. No rollover.</p>
      <div class="card budget-top">
        <div class="bt-label">EXPECTED income this month <span class="tag ${ei.source === "user" ? "" : "ai"}">${ei.source === "user" ? "your number" : ei.source === "rules" ? "from your recurring income" : "not known"}</span></div>
        <div class="bt-value">${inc ? raw(heroAmount(fmtSplit(inc))) : raw(absent(ei.reason).s)}</div>
        <div class="bt-note">This is what your recurring income says <b>will</b> arrive. It is not money you have received. Received so far this month: <b>${sv.income ? fmt(sv.income) : sv.incomeIncomplete ? "— (conversion missing)" : fmt(b0())}</b>.</div>
        ${raw(top)}${raw(rateLinks(a.reasons))}
        <div class="actions"><button class="small" data-action="income">${ei.source === "user" ? "Change or clear my number" : "Use my own number"}</button>${ei.sources.length ? raw(`<span class="hint">${esc(ei.sources.map((x) => `${x.name} × ${x.count}`).join(" · "))}</span>`) : ""}</div>
      </div>
      <div class="actions"><button class="primary" data-action="new-cat">＋ Category budget</button><button data-action="savings">${sv.budget ? "Change" : "Set"} savings target</button></div>
      <div class="card"><h2>Savings</h2>
        <dl class="num-list">
          ${raw(row("Target this month", sv.target ? fmt(sv.target) : sv.reason ? raw(absent(sv.reason).s).s : '<span class="muted">none set</span>'))}
          ${raw(row("Saved so far", sv.saved ? fmt(sv.saved, { sign: true }) : raw(absent(sv.reason || "no income received yet").s).s, sv.saved && sv.saved.amount < 0 ? "bad" : "", "income received minus spending"))}
          ${raw(sv.rate != null ? row("Savings rate", sv.rate + "%") : "")}
        </dl>
        ${raw(rateLinks(sv.reasons))}
        ${sv.onTrack == null ? "" : raw(`<p class="${sv.onTrack ? "" : "error"}">${sv.onTrack ? `${icon("check", { size: 15 })} At or above target.` : `${icon("warning", { size: 15 })} Below target so far this month.`}</p>`)}
      </div>
      <div class="card"><h2>Category budgets</h2><p class="muted">What you have decided to allow yourself, per category, this month. All amounts in ${base()}.</p>
        ${st.length ? raw(st.map(catRow).join("")) : raw('<div class="empty">None yet. Add one to start dividing your income.</div>')}</div>`,
    bind(root) {
      root.querySelector("[data-action=new-cat]").onclick = () => catModal();
      root.querySelector("[data-action=income]").onclick = () => incomeModal(ei);
      root.querySelector("[data-action=savings]").onclick = () => savingsModal(sv);
      root.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => catModal(store.get("budgets", b.dataset.edit))));
      root.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => modal({ title: "Remove this budget?", body: "<p>The category keeps its transactions. Only the limit and its alerts go.</p>", submitLabel: "Remove", danger: true, onSubmit: () => remove(b.dataset.remove) })));
    },
  };
}

// Three integer boxes. No free text, nothing to mistype.
const thresholdBoxes = (values = []) => `<fieldset class="number-boxes"><legend>Alert me when spending reaches (up to ${THRESHOLD_MAX})</legend><div class="inline">${[0, 1, 2].map((i) => field(`Budget alert ${i + 1}`, inp(`th${i}`, { type: "number", min: 1, max: 200, step: 1, value: values[i] ?? "", placeholder: "%" }))).join("")}</div><div class="hint">Percent of the limit. Leave a box empty for fewer alerts. Each fires once a month.</div></fieldset>`;
const thresholdValues = (values) => [values.get("th0"), values.get("th1"), values.get("th2")];
const validateThresholds = (values) => { try { cleanThresholds(thresholdValues(values)); return {}; } catch (error) { if (error instanceof ValidationError) return { fields: error.fields, form: error.form }; throw error; } };

export function catModal(existing, draft = {}) {
  const cats = C.list("expense");
  const cur = C.get(existing?.category_id || draft.categoryId);
  const a = allocation();
  modal({ title: existing ? `Budget for ${C.label(cur)}` : "New category budget",
    body: `${a.expected.money ? `<p class="hint">Left to allocate right now: <b>${fmt(a.leftToAllocate)}</b>${a.overAllocated ? " (over-allocated)" : ""}.</p>` : ""}
      ${existing ? `<input type="hidden" name="cat" value="${existing.category_id}" />` : field("Category", sel("cat", cats, cur?.id || cats[0]?.id, C.label, (c) => c.id))}
      ${field("Monthly limit (" + base() + ")", moneyInput("limit", existing?.limit || draft.limit ? toDecimalString(existing?.limit || draft.limit) : ""))}
      ${thresholdBoxes(existing?.thresholds || settings().default_thresholds)}`,
    onSuccess: draft.onDone,
    onSubmit: (f) => { draft.beforeCommit?.(); const r = set("category", { categoryId: f.get("cat"), limit: parseMoney(f.get("limit"), base()), thresholds: cleanThresholds(thresholdValues(f)) }); r.warnings.forEach((w) => toast(w, 6000)); checkThresholds(); if (!r.warnings.length) toast("Saved"); return r; } });
  const form = document.querySelector("[data-modal-form]");
  bindValidation(form, { validate(values) {
    const fields = {}, text = String(values.get("limit") ?? "").trim(), parsed = parseMoney(text, base());
    if (!text || !validBaseMoney(parsed)) fields.limit = `Enter a valid limit in ${base()}.`;
    const category = C.get(values.get("cat"));
    if (!category || category.kind !== "expense" || !C.all().some((c) => c.id === category.id)) fields.cat = "Choose a live expense category or subcategory.";
    const threshold = validateThresholds(values); Object.assign(fields, threshold.fields || {});
    return { fields, form: threshold.form };
  } });
}
export function savingsModal(sv = savings(), draft = {}) {
  const t = sv.budget ? sv.budget.target : null;
  const hasDraft = Object.hasOwn(draft, "amountText") || Object.hasOwn(draft, "percentText");
  const amountValue = hasDraft ? (draft.amountText ?? "") : (t?.amount ? toDecimalString(t.amount) : "");
  const percentValue = hasDraft ? (draft.percentText ?? "") : (t?.percent_of_income ?? "");
  modal({ title: "Savings target", submitLabel: "Save",
    onSuccess: draft.onDone,
    body: `<p class="hint">Your target, your category budgets and your expected income are three ends of one sum. Set a target and the page shows what is left to divide between categories. Set the categories and it shows what that leaves you saving.</p>
      ${field("Amount per month (" + base() + ")", moneyInput("amount", amountValue))}
      ${field("or a share of expected income (%)", inp("pct", { type: "number", value: percentValue, min: 1, max: 100, step: 1 }), "Percent of expected income, not of money received.")}
      ${sv.budget && draft.allowRemove !== false ? '<label><input type="checkbox" name="clear" /> Remove my savings target</label>' : ""}`,
    onSubmit: (f) => {
      if (f.get("clear")) { remove(sv.budget.id); return; }
      draft.beforeCommit?.();
      const text = String(f.get("amount") ?? "").trim(), amt = parseMoney(text, base()), pctText = String(f.get("pct") ?? "").trim();
      const r = set("savings", { target: amt ? { amount: amt } : { percent_of_income: Number(pctText) } });
      r.warnings.forEach((w) => toast(w, 6000));
    } });
  const form = document.querySelector("[data-modal-form]"), amount = form.elements.amount, percent = form.elements.pct;
  const clearChoice = form.elements.clear;
  const relevance = () => { amount.disabled = Boolean(clearChoice?.checked); percent.disabled = amount.disabled || validBaseMoney(parseMoney(amount.value, base())); };
  amount.addEventListener("input", relevance); amount.addEventListener("change", relevance);
  clearChoice?.addEventListener("change", relevance); relevance();
  bindValidation(form, { dependencies: { amount: ["pct"], pct: ["amount"], clear: ["amount", "pct"] }, validate(values) {
    if (values.get("clear")) return {};
    const fields = {}, amountText = String(values.get("amount") ?? "").trim(), parsed = parseMoney(amountText, base()), validAmount = validBaseMoney(parsed), pctText = String(values.get("pct") ?? "").trim();
    if (amountText && !validAmount) fields.amount = `Enter a valid amount in ${base()}.`;
    if (validAmount) return { fields };
    if (pctText) {
      const pct = Number(pctText);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) fields.pct = "Enter a whole percent from 1 to 100.";
    } else if (!amountText) fields.amount = "Enter a savings amount or a whole percent of expected income.";
    return { fields };
  } });
}
function incomeModal(ei) {
  modal({ title: "Expected income", submitLabel: "Save",
    body: `<p class="hint">By default this comes from your recurring income rules${ei.sources.length ? `: ${esc(ei.sources.map((x) => `${x.name} × ${x.count}`).join(", "))}` : ""}. Type a number here to use your own instead.</p>
      ${field("Expected income per month (" + base() + ")", moneyInput("amount", settings().expected_income_override ? toDecimalString(settings().expected_income_override) : ""))}
      ${settings().expected_income_override ? '<label><input type="checkbox" name="clear" /> Go back to using my recurring income rules</label>' : ""}`,
    onSubmit: (f) => { if (f.get("clear")) { setOverride(null); return; } setOverride(parseMoney(f.get("amount"), base())); } });
  const form = document.querySelector("[data-modal-form]"), amount = form.elements.amount, clearChoice = form.elements.clear;
  const relevance = () => { amount.disabled = Boolean(clearChoice?.checked); };
  clearChoice?.addEventListener("change", relevance);
  bindValidation(form, { validate(values) {
    if (values.get("clear")) return {};
    const text = String(values.get("amount") ?? "").trim();
    return text && validBaseMoney(parseMoney(text, base())) ? {} : { fields: { amount: `Enter a valid expected-income amount in ${base()}, or clear the override.` } };
  }, dependencies: { clear: ["amount"] } });
}

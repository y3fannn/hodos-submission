// Debts: loans and cards. Amortisation in code. Options and maths, never "should".
import { store, nowIso } from "../lib/store.js";
import { money, fmt, parseMoney, isMoney, neg, CURRENCIES, toDecimalString, exponent as expOf } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, moneyInput, esc, bar, lineChart, bindCharts, cap, numberBoxes, readNumberBoxes, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import * as bus from "../lib/bus.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as C from "./categories.js";
import * as T from "./transactions.js";
import * as AL from "./alerts.js";
import { icon } from "../lib/icons.js";
import { createOperation } from "../lib/operations.js";

export const TYPES = ["mortgage", "car", "personal", "student", "card", "other"];
export const list = (status) => store.all("debts").filter((d) => (status ? d.status === status : d.status !== "archived"));
export const get = (id) => store.get("debts", id);
export const isLinked = (d) => Boolean(d.linked_account_id);
// Owed, positive. Linked card mirrors the account.
export function balanceOf(d) { if (isLinked(d)) { const b = A.balance(d.linked_account_id); return b ? money(Math.max(0, -b.amount), b.currency) : null; } return d.balance; }
const monthlyInterest = (bal, apr) => (apr == null ? null : Math.round((bal * Math.round(parseFloat(apr) * 10000)) / 12 / 1000000));

const validDate = (value) => {
  if (value == null || value === "") return true;
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number), date = new Date(0);
  date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const safeMoney = (value, currency) => isMoney(value) && Number.isSafeInteger(value.amount) && CURRENCIES.includes(value.currency) && (!currency || value.currency === currency);
const APR_NUMBER = /^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]+)?$/;
function normalizeRate(value) {
  const invalid = () => { throw new ValidationError({ fields: { rate: "Enter a valid APR or leave it blank for unknown." } }); };
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : invalid();
  if (typeof value !== "string") return invalid();
  const text = value.trim();
  if (!text) return null;
  if (!APR_NUMBER.test(text) || !Number.isFinite(parseFloat(text))) return invalid();
  return text;
}
const usableRate = (value) => { try { normalizeRate(value); return true; } catch (error) { if (error instanceof ValidationError) return false; throw error; } };
function issuesFrom(validate) {
  try { validate(); return {}; }
  catch (error) { if (error instanceof ValidationError) return { fields: error.fields, form: error.form }; throw error; }
}
function mergeValidationIssues(issues, validate, mapField = (name) => name) {
  try { validate(); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    for (const [name, message] of Object.entries(error.fields)) issues.fields[mapField(name)] = message;
    if (error.form) issues.form ||= error.form;
  }
}
const parsedDebtMoney = (text, currency) => parseMoney(text, currency);
const hasPositiveSafeMoneyInAnyCurrency = (text) => CURRENCIES.some((currency) => {
  const parsed = parsedDebtMoney(text, currency);
  return safeMoney(parsed, currency) && parsed.amount > 0;
});
function reminderIssues(days, prefix = "lead") {
  const fields = {};
  if (!Array.isArray(days) || days.length > 3) return { [`${prefix}0`]: "Choose up to three reminder days." };
  for (let i = 0; i < days.length; i++) {
    const value = days[i], n = typeof value === "string" && value.trim() ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1 || n > 365) fields[`${prefix}${i}`] = "Enter a whole number from 1 to 365.";
  }
  return fields;
}
function validateDebt(input, { creating = false, touched = null } = {}) {
  const fields = {}, check = (key) => !touched || touched.has(key), linkedId = input.linked_account_id;
  if (check("name") && (!input.name || typeof input.name !== "string" || !input.name.trim())) fields.name = "Enter a name.";
  if (check("type") && !TYPES.includes(input.type)) fields.type = "Choose a supported debt type.";
  if (check("currency") && !CURRENCIES.includes(input.currency)) fields.currency = "Choose a supported currency.";
  if (check("payment") && (!safeMoney(input.payment, input.currency) || (creating && input.payment.amount <= 0))) fields.payment = creating ? "Enter a positive payment in the debt currency." : "Enter a valid payment in the debt currency.";
  if (check("balance") && ((!linkedId && !safeMoney(input.balance, input.currency)) || (linkedId && input.balance != null))) fields.balance = "Enter a valid balance in the debt currency.";
  if (check("payment_day") && (!Number.isInteger(input.payment_day) || input.payment_day < 1 || input.payment_day > 31)) fields.payment_day = "Enter a whole day from 1 to 31.";
  if (check("rate_apr") && !usableRate(input.rate_apr)) fields.rate = "Enter a valid APR or leave it blank for unknown.";
  if (check("rate_type") && input.rate_type != null && !["fixed", "variable"].includes(input.rate_type)) fields.rate_type = "Choose fixed or variable.";
  for (const [key, name] of [["started_on", "started_on"], ["lock_in_until", "lock_in"], ["maturity_date", "maturity"]]) if (check(key) && !validDate(input[key])) fields[name] = "Enter a real calendar date or leave blank.";
  if (check("lead_days")) Object.assign(fields, reminderIssues(input.lead_days == null ? settings().lead_days : input.lead_days));
  if (!linkedId && (creating || check("pay_from_account_id"))) {
    const account = A.get(input.pay_from_account_id);
    if (!account || account.archived_at) fields.account = "Choose an available account.";
  }
  if (!linkedId && (creating || check("category_id"))) {
    const category = C.get(input.category_id);
    if (!category || category.archived_at || category.merged_into_id || !C.all().some((row) => row.id === input.category_id) || category.kind !== "expense") fields.category = "Choose an available expense category.";
  }
  if (linkedId && (creating || check("linked_account_id") || check("currency") || check("payment"))) {
    const account = A.get(linkedId), alreadyLinked = list().some((debt) => debt.id !== input.id && debt.linked_account_id === linkedId);
    if (!account || account.archived_at || account.type !== "credit" || (account.debt_id && account.debt_id !== input.id) || alreadyLinked) fields.account = "Choose an available, unlinked credit account.";
    else if (input.currency !== account.currency) fields.currency = "The linked card currency must match its account.";
  }
  if (Object.keys(fields).length) throw new ValidationError({ fields });
}
export function create(input) {
  const prepared = { ...input, name: typeof input.name === "string" ? input.name.trim() : input.name, rate_apr: normalizeRate(input.rate_apr) };
  validateDebt(prepared, { creating: true });
  if (prepared.lead_days != null) prepared.lead_days = [...new Set(prepared.lead_days.map(Number))].sort((a, b) => b - a);
  let rule = null;
  if (!prepared.linked_account_id) {
    const start = D.clampDay(...Object.values(D.parse(today())).slice(0, 2), prepared.payment_day);
    rule = T.createRule({ owner: "debt", name: `${prepared.name} repayment`, template: { kind: "expense", account_id: prepared.pay_from_account_id, money: prepared.payment, category_id: prepared.category_id, merchant: prepared.lender || prepared.name, note: "loan repayment" }, schedule: { freq: "monthly", interval: 1, start: start >= today() ? start : D.addMonths(start, 1, prepared.payment_day), anchor: prepared.payment_day } });
  }
  const row = store.insert("debts", { ...prepared, balance: prepared.linked_account_id ? null : prepared.balance, recurring_rule_id: rule?.id || null, status: "active", balance_notes: [] });
  if (prepared.linked_account_id) A.update(prepared.linked_account_id, { debt_id: row.id });
  checkAlerts(); if (rule) T.postDue();
  return row;
}
export function update(id, patch) {
  const current = get(id);
  if (!current) throw new ValidationError({ form: "This debt is no longer available." });
  const changes = { ...patch }, next = { ...current, ...changes }, touched = new Set(Object.keys(changes));
  if (touched.has("linked_account_id")) {
    const existing = current.linked_account_id ?? null, requested = changes.linked_account_id == null ? null : changes.linked_account_id;
    if (requested !== existing) throw new ValidationError({ fields: { linked_account_id: "Changing an existing debt's linked card is not supported here." } });
  }
  if (touched.has("rate_apr")) changes.rate_apr = normalizeRate(changes.rate_apr);
  if (touched.has("currency")) {
    if (next.payment && next.payment.currency !== next.currency) throw new ValidationError({ fields: { payment: "Payment currency must match the debt currency." } });
    if (next.balance && next.balance.currency !== next.currency) throw new ValidationError({ fields: { balance: "Balance currency must match the debt currency." } });
  }
  if (touched.has("balance") && !safeMoney(changes.balance, next.currency)) throw new ValidationError({ fields: { balance: "Enter a valid balance in the debt currency." } });
  validateDebt(next, { touched });
  if (touched.has("lead_days") && changes.lead_days != null) changes.lead_days = [...new Set(changes.lead_days.map(Number))].sort((a, b) => b - a);
  return store.update("debts", id, changes);
}
export function setBalance(id, m, reason) {
  const d = get(id);
  if (!d) throw new ValidationError({ form: "This debt is no longer available." });
  if (!safeMoney(m, d.currency)) throw new ValidationError({ fields: { balance: "Enter a valid balance in the debt currency." } });
  return update(id, { balance: m, balance_notes: [...(d.balance_notes || []), { date: today(), balance: m, reason }] });
}
export function setRate(id, apr) {
  const d = get(id);
  if (!d) throw new ValidationError({ form: "This debt is no longer available." });
  return update(id, { rate_apr: normalizeRate(apr) });
}

// Hook: repayment rule posted → split interest vs principal at post time.
bus.on("recurring_posted", ({ rule, tx }) => {
  if (rule.owner !== "debt") return;
  const d = store.all("debts").find((x) => x.recurring_rule_id === rule.id); if (!d || d.status !== "active") return;
  const bal = d.balance.amount;
  const interest = monthlyInterest(bal, d.rate_apr);
  const principal = interest == null ? tx.money.amount : tx.money.amount - interest;
  const after = bal - principal;
  store.insert("debt_payments", { debt_id: d.id, transaction_id: tx.id, date: tx.date, amount: tx.money, interest: interest == null ? null : money(interest, d.currency), principal: money(principal, d.currency), balance_after: money(after, d.currency) });
  update(d.id, { balance: money(after, d.currency) });
  if (after <= 0) { update(d.id, { status: "cleared" }); T.updateRule(rule.id, { archived_at: nowIso() }); AL.fire({ type: "debt_cleared", source: { feature: "debts", entity_id: d.id }, dedupe_key: `debt_cleared:${d.id}`, title: `${d.name} cleared`, body: after < 0 ? `Overpaid by ${fmt(money(-after, d.currency))}. Adjust the balance if needed.` : "Balance reached zero. Rule ended." }); }
});
export function logExtraPayment(id, m, date, accountId) {
  const d = get(id);
  if (!d || isLinked(d)) throw new ValidationError({ form: "This loan is unavailable for an extra payment." });
  if (!safeMoney(m, d.currency) || m.amount <= 0) throw new ValidationError({ fields: { amount: "Enter a positive amount in the debt currency." } });
  if (!validDate(date) || !date) throw new ValidationError({ fields: { date: "Enter a real calendar date." } });
  const account = A.get(accountId);
  if (!account || account.archived_at) throw new ValidationError({ fields: { account: "Choose an available account." } });
  const after = d.balance?.amount - m.amount;
  if (!Number.isSafeInteger(after)) throw new ValidationError({ fields: { amount: "This payment is too large to represent safely." } });
  T.validate({ kind: "expense", account_id: accountId, money: m, date, category_id: d.category_id });
  const tx = T.save({ kind: "expense", account_id: accountId, money: m, date, category_id: d.category_id, merchant: d.lender || d.name, note: "extra loan payment", source: "form" });
  store.insert("debt_payments", { debt_id: d.id, transaction_id: tx.id, date, amount: m, interest: money(0, d.currency), principal: m, balance_after: money(after, d.currency) });
  update(d.id, { balance: money(after, d.currency) });
  if (after <= 0) { update(d.id, { status: "cleared" }); if (d.recurring_rule_id) T.updateRule(d.recurring_rule_id, { archived_at: nowIso() }); }
}
export const payments = (id) => store.all("debt_payments").filter((p) => p.debt_id === id).sort((a, b) => b.date.localeCompare(a.date));

// Standard monthly amortisation. Pure calculation.
export function projection(d, { extraMonthly = 0, lumpSum = 0 } = {}) {
  if (!Number.isSafeInteger(extraMonthly)) throw new ValidationError({ fields: { extraMonthly: "Enter a representable whole amount." } });
  if (!Number.isSafeInteger(lumpSum)) throw new ValidationError({ fields: { lumpSum: "Enter a representable whole amount." } });
  const bal0 = balanceOf(d); if (!bal0) return { reason: "balance unknown" };
  if (d.rate_apr == null) return { reason: "rate unknown" };
  const pay = d.payment.amount + extraMonthly;
  let bal = bal0.amount - lumpSum, totalInterest = 0, months = 0; const schedule = [];
  if (bal <= 0) return { monthsToClear: 0, totalInterest: money(0, d.currency), payoffDate: today(), schedule, neverClears: false };
  const firstInterest = monthlyInterest(bal, d.rate_apr);
  if (pay <= firstInterest) return { neverClears: true, shortfall: money(firstInterest - pay, d.currency), monthlyInterest: money(firstInterest, d.currency), schedule };
  while (bal > 0 && months < 600) {
    const interest = monthlyInterest(bal, d.rate_apr); const principal = Math.min(bal, pay - interest); bal -= principal; totalInterest += interest; months++;
    schedule.push({ month: months, interest, principal, balance: bal });
  }
  return { monthsToClear: months, totalInterest: money(totalInterest, d.currency), payoffDate: D.addMonths(today(), months), schedule, neverClears: false, assumption: d.rate_type === "variable" ? `assumes rate stays ${d.rate_apr}%` : null };
}
export function whatIf(d, opts) { const b = projection(d), w = projection(d, opts); if (b.reason || b.neverClears || w.neverClears) return { base: b, with: w }; return { base: b, with: w, monthsSaved: b.monthsToClear - w.monthsToClear, interestSaved: money(b.totalInterest.amount - w.totalInterest.amount, d.currency) }; }

// Lock-in and maturity reminders work like insurance renewals: a default in Settings, a debt may
// carry its own, up to three, or none.
export const DEFAULT_LEAD_DAYS = [90, 30];
export const settings = () => store.one("debt_settings") || { lead_days: DEFAULT_LEAD_DAYS };
export function setDefaultLeadDays(days) {
  const fields = reminderIssues(days);
  if (Object.keys(fields).length) throw new ValidationError({ fields });
  const normalized = [...new Set(days.map(Number))].sort((a, b) => b - a);
  return store.upsertOne("debt_settings", { lead_days: normalized });
}
export const leadDays = (d) => d.lead_days ?? settings().lead_days;
const leadBoxes = (d) => `${numberBoxes("lead", d?.lead_days ?? settings().lead_days, { placeholder: "days", label: "Loan reminder", legend: "Days before lock-in ends or the loan matures" })}<div class="hint">Up to three reminders. Clear every box for none. Your default is ${settings().lead_days.length ? settings().lead_days.join(" and ") + " days" : "no reminders"}, set in Settings.</div>`;
const readLead = (f) => {
  const lead = readNumberBoxes(f, "lead"), defaults = settings().lead_days;
  if (String(lead) !== String(defaults)) return lead;
  const invalidDefaults = reminderIssues(defaults);
  if (Object.keys(invalidDefaults).length) throw new ValidationError({ fields: invalidDefaults });
  return null;
};
function loanInput(values, { rateApr = normalizeRate(values.get("rate")), leadDays = readLead(values) } = {}) {
  const currency = values.get("currency"), balance = parsedDebtMoney(values.get("balance"), currency);
  return { name: values.get("name"), type: values.get("type"), lender: values.get("lender") || null, currency, balance, original_balance: balance, rate_apr: rateApr, rate_type: values.get("rate_type"), payment: parsedDebtMoney(values.get("payment"), currency), payment_day: values.get("payment_day") === "" ? NaN : Number(values.get("payment_day")), pay_from_account_id: values.get("account"), category_id: values.get("category"), started_on: values.get("started_on") || null, maturity_date: values.get("maturity") || null, lock_in_until: values.get("lock_in") || null, lead_days: leadDays, linked_account_id: null };
}
function loanFormIssues(values) {
  const issues = { fields: {} };
  let rateApr = null, leadDays = [];
  mergeValidationIssues(issues, () => { rateApr = normalizeRate(values.get("rate")); });
  mergeValidationIssues(issues, () => { leadDays = readLead(values); });
  const input = loanInput(values, { rateApr, leadDays });
  mergeValidationIssues(issues, () => validateDebt(input, { creating: true }));
  return issues;
}
function linkedCardInput(values, account = A.get(values.get("account")), rateApr = normalizeRate(values.get("rate"))) {
  const accountId = values.get("account");
  if (!account) throw new ValidationError({ fields: { account: "Choose an available credit account." } });
  return { name: account.name, type: "card", lender: null, currency: account.currency, balance: null, original_balance: null, rate_apr: rateApr, rate_type: "variable", payment: parsedDebtMoney(values.get("payment"), account.currency), payment_day: account.statement_day || 1, pay_from_account_id: null, category_id: null, started_on: null, maturity_date: null, lock_in_until: null, linked_account_id: accountId };
}
function linkedCardFormIssues(values) {
  const issues = { fields: {} };
  let rateApr = null;
  mergeValidationIssues(issues, () => { rateApr = normalizeRate(values.get("rate")); });
  const account = A.get(values.get("account"));
  if (!account) {
    issues.fields.account = "Choose an available credit account.";
    const paymentText = values.get("payment");
    if (!hasPositiveSafeMoneyInAnyCurrency(paymentText)) issues.fields.payment = "Enter a positive, representable payment amount.";
    return issues;
  }
  const input = linkedCardInput(values, account, rateApr);
  mergeValidationIssues(issues, () => validateDebt(input, { creating: true }));
  return issues;
}
function rateFormIssues(values) {
  const fields = {};
  try { normalizeRate(values.get("rate")); } catch (error) { if (error instanceof ValidationError) Object.assign(fields, error.fields); else throw error; }
  if (!["fixed", "variable"].includes(values.get("rate_type"))) fields.rate_type = "Choose fixed or variable.";
  return { fields };
}
function balanceFormIssues(values, debt) {
  const balance = parsedDebtMoney(values.get("balance"), debt.currency);
  return safeMoney(balance, debt.currency) ? {} : { fields: { balance: "Enter a valid balance in the debt currency." } };
}
function extraPaymentFormIssues(values, debt) {
  const issues = { fields: {} }, amount = parsedDebtMoney(values.get("amount"), debt.currency), accountId = values.get("account"), account = A.get(accountId);
  if (!safeMoney(amount, debt.currency) || amount.amount <= 0) issues.fields.amount = "Enter a positive amount in the debt currency.";
  if (!account || account.archived_at) issues.fields.account = "Choose an available account.";
  mergeValidationIssues(issues, () => T.validate({ kind: "expense", account_id: account?.id || accountId, money: amount, date: values.get("date"), category_id: debt.category_id }), (name) => {
    if (name === "account_id") return "account";
    if (name === "category_id") return "category_id";
    if (name === "amount" && issues.fields.amount) return "amount";
    return name;
  });
  if (issues.fields.category_id) {
    delete issues.fields.category_id;
    issues.form = "The loan's expense category is no longer available.";
  }
  const after = debt.balance?.amount - amount?.amount;
  if (safeMoney(amount, debt.currency) && !Number.isSafeInteger(after)) issues.fields.amount = "This payment is too large to represent safely.";
  return issues;
}
function reminderFormIssues(values) { return issuesFrom(() => readLead(values)); }
function photoApplyIssues(values, proposed, debt) {
  const fields = {}, current = get(debt.id), selected = { balance: values.get("b") != null, rate: values.get("r") != null, payment: values.get("p") != null };
  if (!current || (isLinked(current) && (selected.balance || selected.payment))) return { form: "This debt changed and cannot apply the selected statement values." };
  if (selected.balance && !safeMoney(proposed.balance, current.currency)) fields.b = "This selected balance is not a valid amount in the debt currency.";
  if (selected.rate && !usableRate(proposed.rate)) fields.r = "This selected APR is not a usable number.";
  if (selected.payment && !safeMoney(proposed.payment, current.currency)) fields.p = "This selected payment is not a representable amount in the debt currency.";
  return { fields };
}
export function checkAlerts() {
  const t = today();
  for (const d of list("active")) for (const [field, type] of [["lock_in_until", "debt_lockin"], ["maturity_date", "debt_maturity"]]) {
    if (!d[field]) continue; const days = D.daysBetween(t, d[field]);
    const leads = leadDays(d), last = Math.min(...leads);
    for (const lead of leads) if (days <= lead && days >= 0) AL.fire({ type, severity: lead === last ? "warn" : "info", source: { feature: "debts", entity_id: d.id }, dedupe_key: `${type}:${d.id}:${d[field]}:${lead}`, title: `${d.name}: ${type === "debt_lockin" ? "lock-in ends" : "matures"} in ${days} days`, body: `${D.fmtDate(d[field])}.` });
  }
}
export async function fromImage(id, file, { signal, onProgress } = {}) {
  const d = get(id); const img = await ai.fileToImage(file, { signal }); signal?.throwIfAborted();
  onProgress?.("Matching statement details…", "generating");
  return ai.call("extract_debt_statement", { tier: "cheap", images: [img], signal, system: "Read the loan or card statement. Return the printed balance, interest rate, scheduled payment and next due date as texts, verbatim. Unknown = null.", input: { currency_hint: d.currency },
    schema: { type: "object", properties: { balance_text: { type: ["string", "null"] }, rate_text: { type: ["string", "null"] }, payment_text: { type: ["string", "null"] }, next_due: { type: ["string", "null"] }, lender: { type: ["string", "null"] } } } });
}

export function debtsPage() {
  const ds = list();
  const card = (d) => { const bal = balanceOf(d), p = projection(d); const pct = d.original_balance && bal ? Math.round(100 - (bal.amount / d.original_balance.amount) * 100) : null;
    return `<div class="card"><div class="row clickable" data-open="${d.id}"><div class="grow"><div class="title">${esc(d.name)}<span class="tag">${cap(d.type)}</span>${d.status !== "active" ? `<span class="tag">${cap(d.status)}</span>` : ""}${isLinked(d) ? '<span class="tag">linked card</span>' : ""}</div>${pct != null ? bar(pct) : ""}
      <div class="sub">${d.rate_apr != null ? `${d.rate_apr}% ${d.rate_type}` : "rate unknown"} · pays ${fmt(d.payment)}/month${isLinked(d) ? " (if you pay this)" : " on day " + d.payment_day} · ${p.reason ? p.reason : p.neverClears ? `<b>never clears</b> at this payment (short ${fmt(p.shortfall)}/month)` : `${p.monthsToClear} months to clear · interest ${fmt(p.totalInterest)}`}</div></div><div class="amt">${bal ? fmt(bal) : "—"}</div></div></div>`; };
  return {
    title: "Debts",
    html: html`<div class="actions"><button class="primary" data-action="new">＋ Loan</button><button data-action="link">Link a credit card</button></div>${ds.length ? raw(ds.map(card).join("")) : raw('<div class="empty">No debts. Add a loan, or link a credit card account for interest and payoff maths.</div>')}<p class="muted">Projections are standard monthly amortisation: interest = balance × rate ÷ 12. Options and maths only; no advice on what to pay first.</p>`,
    bind(root) {
      root.querySelector("[data-action=new]").onclick = () => newDebtModal();
      root.querySelector("[data-action=link]").onclick = () => linkCardModal();
      root.querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => (location.hash = `#/debts/${el.dataset.open}`)));
    },
  };
}
function newDebtModal() {
  const accts = A.active(); if (!accts.length) return toast("Create an account first.");
  const cats = C.list("expense"); const def = cats.find((c) => c.name === "Housing") || cats[0];
  const dialog = modal({ title: "New loan", submitLabel: "Save loan",
    body: `<div class="inline">${field("Name", inp("name", { required: true, placeholder: "Car loan" }))}${field("Type", sel("type", TYPES, "personal"))}</div><div class="inline">${field("Lender", inp("lender"))}${field("Currency", sel("currency", CURRENCIES, base()))}</div>
      <div class="inline">${field("Balance now", moneyInput("balance"))}${field("Rate APR % (blank = unknown)", inp("rate", { type: "number", step: "0.01", placeholder: "6.5" }))}${field("Rate type", sel("rate_type", ["fixed", "variable"]))}</div>
      <div class="inline">${field("Monthly payment", moneyInput("payment"))}${field("Payment day", inp("payment_day", { type: "number", value: 1, min: 1, max: 31 }))}</div>
      <div class="inline">${field("Pay from", sel("account", accts, accts[0].id, (a) => a.name, (a) => a.id))}${field("Expense category", sel("category", cats, def?.id, C.label, (c) => c.id))}</div>
      <div class="inline">${field("Started", inp("started_on", { type: "date" }))}${field("Lock-in until", inp("lock_in", { type: "date" }))}${field("Maturity", inp("maturity", { type: "date" }))}</div>${leadBoxes(null)}<p class="hint">A recurring repayment rule is created. It posts the whole payment as one expense; the interest/principal split lives here.</p>`,
    onSubmit: (f) => { create(loanInput(f)); toast("Loan added, repayment rule created"); } });
  bindValidation(dialog.form, { validate: loanFormIssues, dependencies: { currency: ["balance", "payment"] } });
}
function linkCardModal() {
  const cards = A.active().filter((a) => a.type === "credit" && !a.debt_id); if (!cards.length) return toast("No unlinked credit card accounts.");
  const dialog = modal({ title: "Link a credit card", body: field("Card account", sel("account", cards, cards[0].id, (a) => a.name, (a) => a.id)) + `<div class="inline">${field("Rate APR %", inp("rate", { type: "number", step: "0.01", placeholder: "26" }))}${field("If you pay this each month", moneyInput("payment"))}</div><p class="hint">Balance mirrors the card account. Payments are transfers bank → card. No expense is posted here.</p>`,
    onSubmit: (f) => { create(linkedCardInput(f)); toast("Linked"); } });
  bindValidation(dialog.form, { validate: linkedCardFormIssues, dependencies: { account: ["payment"] } });
}
export function debtDetailPage(id) {
  const d = get(id); if (!d) return { title: "Debt", html: "<div class='empty'>Not found</div>", bind() {} };
  const bal = balanceOf(d), p = projection(d), ps = payments(id);
  const projHtml = (pr) => pr.reason ? `<p class="absent">— ${pr.reason}</p>` : pr.neverClears ? `<p><b>Never clears at this payment.</b> Monthly interest ${fmt(pr.monthlyInterest)} exceeds the payment by ${fmt(pr.shortfall)}.</p>` : `<p>Estimated ${pr.monthsToClear} months to clear · total interest ${fmt(pr.totalInterest)}${pr.assumption ? ` · ${pr.assumption}` : ""}</p>`;
  return {
    title: d.name,
    html: html`<div class="stat"><div class="label">${cap(d.type)} · ${d.rate_apr != null ? d.rate_apr + "% " + d.rate_type : "rate unknown"} · pays ${fmt(d.payment)}/month${isLinked(d) ? " (linked card: balance mirrors the account)" : ""}</div><div class="value">${bal ? fmt(bal) : "—"}</div><div class="sub">${d.lock_in_until ? "lock-in until " + D.fmtDate(d.lock_in_until) + " · " : ""}${d.maturity_date ? "matures " + D.fmtDate(d.maturity_date) : ""}</div></div>
      <div class="card"><h2>Projection</h2>${raw(projHtml(p))}
        ${!p.reason && !p.neverClears ? raw(`${lineChart([{ x: "now", y: bal.amount / 10 ** expOf(d.currency) }, ...p.schedule.map((s) => ({ x: String(s.month), y: s.balance / 10 ** expOf(d.currency) }))], { height: 150, fmtY: (v) => fmt(money(Math.round(v * 10 ** expOf(d.currency)), d.currency)), id: "payoff" })}
        <p class="muted">Estimated balance by payment month, if nothing changes. Exact payoff dates are temporarily unavailable.</p>
        <details><summary class="muted">The numbers behind it</summary><div class="scroll-x"><table><tr><th>Month</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Balance after</th></tr>${p.schedule.slice(0, 12).map((s) => `<tr><td>${s.month}</td><td class="num">${fmt(money(s.interest, d.currency))}</td><td class="num">${fmt(money(s.principal, d.currency))}</td><td class="num">${fmt(money(s.balance, d.currency))}</td></tr>`).join("")}${p.schedule.length > 12 ? `<tr><td colspan="4" class="muted">… ${p.schedule.length - 12} more months</td></tr>` : ""}</table></div></details>`) : ""}</div>
      <div class="card"><h2>What if</h2><form data-form="whatif" novalidate><div class="inline">${raw(field("Extra each month", moneyInput("extra", "", "0.00")))}${raw(field("One-off payment now", moneyInput("lump", "", "0.00")))}</div><div class="actions right"><button class="primary">Calculate</button></div></form><div data-whatif></div><p class="hint">Pure calculation. Nothing is stored.</p></div>
      <div data-operation-root><div class="actions"><button data-action="rate">Set rate</button>${d.lock_in_until || d.maturity_date ? raw('<button data-action="reminders">Reminders</button>') : ""}${isLinked(d) ? "" : raw('<button data-action="balance">Correct balance</button><button data-action="extra">Log extra payment</button>')}${ai.enabled() && !isLinked(d) ? raw('<label class="btn">${icon("camera", { size: 17 })} Statement photo <input type="file" accept="image/*" data-action="photo" hidden /></label>') : ""}<button class="danger" data-action="archive">Archive</button></div><div data-operation-status class="operation-status" role="status" aria-live="polite"></div></div>
      <div class="card"><h2>Payments</h2>${ps.length ? raw(`<table><tr><th>Date</th><th class="num">Paid</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Balance</th></tr>${ps.map((x) => `<tr><td>${D.fmtDateShort(x.date)}</td><td class="num">${fmt(x.amount)}</td><td class="num">${x.interest ? fmt(x.interest) : "—"}</td><td class="num">${fmt(x.principal)}</td><td class="num">${fmt(x.balance_after)}</td></tr>`).join("")}</table>`) : raw('<div class="empty">No repayments posted yet.</div>')}</div>`,
    bind(root) {
      bindCharts(root);
      const whatIfForm = root.querySelector("[data-form=whatif]");
      bindValidation(whatIfForm, { validate(values) {
        const fields = {}, amounts = {};
        for (const name of ["extra", "lump"]) {
          const rawValue = String(values.get(name) ?? "").trim();
          if (!rawValue) { amounts[name] = 0; continue; }
          const parsed = parseMoney(rawValue, d.currency);
          if (!safeMoney(parsed, d.currency)) fields[name] = "Enter a valid, representable amount or leave it blank.";
          else amounts[name] = parsed.amount;
        }
        const currentBalance = balanceOf(d);
        if (!fields.extra && !fields.lump && (!Number.isSafeInteger(d.payment.amount + amounts.extra) || (currentBalance && !Number.isSafeInteger(currentBalance.amount - amounts.lump)))) {
          fields[!Number.isSafeInteger(d.payment.amount + amounts.extra) ? "extra" : "lump"] = "This amount is too large to calculate safely.";
        }
        return { fields };
      }});
      whatIfForm.onsubmit = (e) => {
        e.preventDefault(); const checked = whatIfForm.validation.validateSubmit(); if (!checked.valid) return;
        const f = checked.values;
        const extraText = String(f.get("extra") || "").trim(), lumpText = String(f.get("lump") || "").trim();
        const extra = extraText ? parseMoney(extraText, d.currency).amount : 0, lump = lumpText ? parseMoney(lumpText, d.currency).amount : 0;
        const w = whatIf(d, { extraMonthly: extra, lumpSum: lump }), pr = w.with;
        const bold = (text) => { const node = document.createElement("b"); node.textContent = text; return node; };
        const heading = document.createElement("p"), result = document.createElement("p");
        heading.append(bold(`With ${extra ? fmt(money(extra, d.currency)) + " extra/month" : ""}${extra && lump ? " and " : ""}${lump ? fmt(money(lump, d.currency)) + " now" : ""}:`));
        if (pr.reason) { result.className = "absent"; result.textContent = `— ${pr.reason}`; }
        else if (pr.neverClears) result.append(bold("Never clears at this payment."), ` Monthly interest ${fmt(pr.monthlyInterest)} exceeds the payment by ${fmt(pr.shortfall)}.`);
        else result.textContent = `Estimated ${pr.monthsToClear} months to clear · total interest ${fmt(pr.totalInterest)}${pr.assumption ? ` · ${pr.assumption}` : ""}`;
        const output = root.querySelector("[data-whatif]"); output.replaceChildren(heading, result);
        if (w.monthsSaved != null) {
          const savings = document.createElement("p");
          savings.append("Saves ", bold(`${w.monthsSaved} months`), " and ", bold(fmt(w.interestSaved)), " in interest, compared with the current plan.");
          output.append(savings);
        }
      };
      root.querySelector("[data-action=reminders]")?.addEventListener("click", () => { const dialog = modal({ title: "Reminders", body: leadBoxes(d), onSubmit: (f) => { update(d.id, { lead_days: readLead(f) }); checkAlerts(); toast("Saved"); } }); bindValidation(dialog.form, { validate: reminderFormIssues }); });
      root.querySelector("[data-action=rate]").onclick = () => { const dialog = modal({ title: "Set rate", body: field("APR % (blank = unknown)", inp("rate", { type: "number", step: "0.01", value: d.rate_apr ?? "" })) + field("Rate type", sel("rate_type", ["fixed", "variable"], d.rate_type)), onSubmit: (f) => update(d.id, { rate_apr: normalizeRate(f.get("rate")), rate_type: f.get("rate_type") }) }); bindValidation(dialog.form, { validate: rateFormIssues }); };
      root.querySelector("[data-action=balance]")?.addEventListener("click", () => { const dialog = modal({ title: "Correct balance", body: field("Balance now", moneyInput("balance", toDecimalString(d.balance))) + field("Reason", sel("reason", ["statement", "correction"])), onSubmit: (f) => setBalance(d.id, parseMoney(f.get("balance"), d.currency), f.get("reason")) }); bindValidation(dialog.form, { validate: (values) => balanceFormIssues(values, d) }); });
      root.querySelector("[data-action=extra]")?.addEventListener("click", () => { const dialog = modal({ title: "Extra payment", body: `<div class="inline">${field("Amount", moneyInput("amount"))}${field("Date", inp("date", { type: "date", value: today() }))}</div>${field("From account", sel("account", A.active(), d.pay_from_account_id, (a) => a.name, (a) => a.id))}<p class="hint">Posts a real expense. Principal only; balance falls by the full amount.</p>`, onSubmit: (f) => { logExtraPayment(d.id, parseMoney(f.get("amount"), d.currency), f.get("date"), f.get("account")); toast("Logged"); } }); bindValidation(dialog.form, { validate: (values) => extraPaymentFormIssues(values, d), dependencies: { account: ["amount", "date"], date: ["amount", "account"] } }); });
      // Rebind the same job after redraw so status and departure cleanup stay connected.
      let photoOperation = createOperation({ root: root.querySelector("[data-operation-root]"), key: `debts.statement-photo:${id}`, ownerGeneration: store.generation() });
      const photoInput = root.querySelector("[data-action=photo]");
      photoInput?.addEventListener("change", async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const pageHash = location.hash, operation = createOperation({ root: root.querySelector("[data-operation-root]"), key: `debts.statement-photo:${id}`, ownerGeneration: store.generation() });
        photoOperation = operation;
        if (!operation.start("Reading statement…", "reading")) return;
        try {
          const r = await fromImage(id, file, { signal: operation.signal, onProgress: (message, phase) => operation.progress(message, phase) });
          if (!operation.active() || !root.isConnected || location.hash !== pageHash || !get(id)) return;
          const nb = r.balance_text != null && String(r.balance_text).trim() ? parseMoney(r.balance_text, d.currency) : null;
          const nr = r.rate_text != null && String(r.rate_text).trim() ? parseFloat(r.rate_text) : null;
          const np = r.payment_text != null && String(r.payment_text).trim() ? parseMoney(r.payment_text, d.currency) : null;
          operation.succeed("Statement read. Nothing is saved until you confirm.");
          const proposed = { balance: nb, rate: nr, payment: np };
          const review = modal({ title: "Statement says", body: `<p class="ai-note">Confirm each change. Blanks stay as they are.</p><table><tr><th></th><th>App</th><th>Statement</th></tr><tr><td>Balance</td><td>${fmt(d.balance)}</td><td>${nb ? fmt(nb) : "—"}</td></tr><tr><td>Rate</td><td>${d.rate_apr ?? "—"}</td><td>${esc(nr ?? "—")}</td></tr><tr><td>Payment</td><td>${fmt(d.payment)}</td><td>${np ? fmt(np) : "—"}</td></tr></table>${r.balance_text != null && String(r.balance_text).trim() ? '<label><input type="checkbox" name="b" checked/> Update balance (reason: statement)</label>' : ""}${nr != null || (r.rate_text != null && String(r.rate_text).trim()) ? '<label><input type="checkbox" name="r" checked/> Update rate</label>' : ""}${r.payment_text != null && String(r.payment_text).trim() ? '<label><input type="checkbox" name="p" checked/> Update payment</label>' : ""}`, submitLabel: "Apply ticked", onSubmit: (f) => {
            const issues = photoApplyIssues(f, proposed, d);
            if (Object.keys(issues.fields || {}).length || issues.form) throw new ValidationError(issues);
            const selected = { balance: f.get("b") != null, rate: f.get("r") != null, payment: f.get("p") != null };
            if (selected.balance) setBalance(d.id, nb, "statement");
            if (selected.rate) setRate(d.id, nr);
            if (selected.payment) update(d.id, { payment: np });
          } });
          bindValidation(review.form, { validate: (values) => photoApplyIssues(values, proposed, d) });
        } catch { if (operation.active()) operation.fail("Could not read this statement.", "Choose another image or enter the changes manually."); }
        finally { if (photoInput.isConnected) photoInput.value = ""; }
      });
      root.querySelector("[data-action=archive]").onclick = () => modal({ title: "Archive debt?", body: "<p>Ends its rule. History kept.</p>", submitLabel: "Archive", danger: true, onSubmit: () => { update(d.id, { status: "archived" }); if (d.recurring_rule_id) T.updateRule(d.recurring_rule_id, { archived_at: nowIso() }); if (d.linked_account_id) A.update(d.linked_account_id, { debt_id: null }); }, onSuccess: () => { location.hash = "#/debts"; } });
      return ({ reason = "navigate" } = {}) => { if (reason !== "redraw") photoOperation?.dispose(reason); };
    },
  };
}

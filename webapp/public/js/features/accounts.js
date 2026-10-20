// Accounts: balance derived, transfers, credit, P1 balance check.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, parseMoney, add, neg, isMoney, CURRENCIES, toDecimalString, convert } from "../lib/money.js";
import { labelId as catLabel } from "./categories.js";
import * as fx from "../lib/fx.js";
import { html, raw, esc, modal, field, inp, sel, toast, absent, moneyInput, rateLinks, ValidationError, bindValidation, commitAction } from "../lib/ui.js";
import { base, today, profile } from "./profile.js";
import { fmtDate } from "../lib/dates.js";
import * as bus from "../lib/bus.js";

export const TYPES = ["bank", "cash", "wallet", "credit", "other"];
export const get = (id) => store.get("accounts", id);
export const list = (includeArchived = false) => store.all("accounts").filter((a) => includeArchived || !a.archived_at).sort((a, b) => a.name.localeCompare(b.name));
export const active = () => list(false);

const issue = (fields, form = "") => { if (Object.keys(fields).length || form) throw new ValidationError({ fields, form }); };
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validAccountMoney = (value, currency) => isMoney(value) && CURRENCIES.includes(value.currency) && value.currency === currency && Number.isSafeInteger(value.amount);
const parseTypedMoney = (text, currency) => {
  if (text == null || !String(text).trim()) return { blank: true, value: null };
  const value = parseMoney(text, currency);
  if (!value || !validAccountMoney(value, currency)) return { blank: false, value: null };
  return { blank: false, value };
};
const validateName = (name, fields) => { if (typeof name !== "string" || !name.trim()) fields.name = "Enter an account name."; };
const validateMoneyField = (value, currency, name, fields, { positive = false, optional = false } = {}) => {
  if (optional && value == null) return;
  if (!validAccountMoney(value, currency) || (positive && value.amount <= 0)) fields[name] = positive ? "Enter a positive amount in this account’s currency." : "Enter a valid amount in this account’s currency.";
};
export function create({ name, type, currency, openingBalance, openedOn, creditLimit, statementDay }) {
  const fields = {};
  validateName(name, fields);
  if (!TYPES.includes(type)) fields.type = "Choose a supported account type.";
  if (!CURRENCIES.includes(currency)) fields.currency = "Choose a supported currency.";
  const opening = openingBalance === undefined && CURRENCIES.includes(currency) ? money(0, currency) : openingBalance;
  const opened = openedOn === undefined ? today() : openedOn;
  validateMoneyField(opening, currency, "opening", fields);
  if (!validDate(opened)) fields.opened_on = "Choose a valid calendar date.";
  if (type === "credit" && creditLimit != null) validateMoneyField(creditLimit, currency, "limit", fields);
  if (type === "credit" && statementDay != null && (!Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
  issue(fields);
  return store.insert("accounts", { name: name.trim(), type, currency, opening_balance: opening, opened_on: opened, credit_limit: type === "credit" ? creditLimit ?? null : null, statement_day: type === "credit" ? statementDay ?? null : null, debt_id: null, archived_at: null });
}
export function update(id, patch) {
  const account = get(id), fields = {};
  if (!account) throw new ValidationError({ fields: { name: "This account is no longer available." } });
  if (Object.hasOwn(patch, "currency") && !CURRENCIES.includes(patch.currency)) fields.currency = "Choose a supported currency.";
  if (Object.hasOwn(patch, "currency") && patch.currency !== account.currency && store.all("transactions", { includeDeleted: true }).some((t) => t.account_id === id || t.counter_account_id === id)) fields.currency = "An account with transactions cannot change currency.";
  if (Object.hasOwn(patch, "name")) validateName(patch.name, fields);
  if (Object.hasOwn(patch, "currency") && CURRENCIES.includes(patch.currency)) {
    const opening = Object.hasOwn(patch, "opening_balance") ? patch.opening_balance : account.opening_balance;
    validateMoneyField(opening, patch.currency, "opening", fields);
    if (account.type === "credit") {
      const limit = Object.hasOwn(patch, "credit_limit") ? patch.credit_limit : account.credit_limit;
      if (limit != null) validateMoneyField(limit, patch.currency, "limit", fields);
    }
  } else if (account.type === "credit" && Object.hasOwn(patch, "credit_limit") && patch.credit_limit != null) validateMoneyField(patch.credit_limit, account.currency, "limit", fields);
  if (account.type === "credit" && Object.hasOwn(patch, "statement_day") && patch.statement_day != null && (!Number.isInteger(patch.statement_day) || patch.statement_day < 1 || patch.statement_day > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
  issue(fields);
  return store.update("accounts", id, { ...patch, ...(Object.hasOwn(patch, "name") ? { name: patch.name.trim() } : {}) });
}
export function archive(id) {
  store.update("accounts", id, { archived_at: nowIso() });
  for (const r of store.all("recurring_rules").filter((r) => r.template?.account_id === id && !r.paused_at)) store.update("recurring_rules", r.id, { paused_at: nowIso(), paused_reason: "account_archived" });
}

// balance = opening + Σ transactions (not voided), up to asOf.
export function balance(id, asOf) {
  const a = get(id) || store.all("accounts", { includeDeleted: true }).find((x) => x.id === id);
  if (!a) return null;
  let amt = a.opening_balance.amount;
  for (const t of store.all("transactions")) {
    if (t.voided_at || (asOf && t.date > asOf)) continue;
    if (t.account_id === id) amt += t.kind === "income" ? t.money.amount : -t.money.amount;
    else if (t.kind === "transfer" && t.counter_account_id === id && t.counter_money) amt += t.counter_money.amount;
  }
  return money(amt, a.currency);
}
export const available = (a) => (a.type === "credit" && a.credit_limit ? add(a.credit_limit, balance(a.id)) : null);

// Rows with balance, base balance, rate age.
export function withBalances(includeArchived = false) {
  const b = base();
  return list(includeArchived).map((a) => { const bal = balance(a.id); const conv = fx.toBase(bal, b); return { ...a, balance: bal, base_balance: conv.money, rate: conv.rate, reason: conv.reason }; });
}
export function totalBase(includeArchived = true) {
  const rows = withBalances(includeArchived);
  const reasons = rows.filter((r) => !r.base_balance).map((r) => r.reason || `${r.name}: no rate`);
  const total = rows.reduce((acc, r) => (acc && r.base_balance ? add(acc, r.base_balance) : null), money(0, base()));
  const oldest = rows.map((r) => r.rate?.fetched_at).filter(Boolean).sort()[0];
  return { total: reasons.length ? null : total, partial: total, reasons, oldest_rate: oldest };
}

export function transfer({ fromId, toId, moneyOut, moneyIn, date, note }) {
  const from = get(fromId), to = get(toId), fields = {};
  if (!from || from.archived_at) fields.from = "Choose a live account.";
  if (!to || to.archived_at) fields.to = "Choose a live account.";
  if (from && to && from.id === to.id) fields.to = "Choose a different receiving account.";
  if (from) validateMoneyField(moneyOut, from.currency, "out", fields, { positive: true });
  if (!validDate(date)) fields.date = "Choose a valid calendar date.";
  else {
    if (date > today()) fields.date = "Transfer date cannot be in the future.";
    if ((from && date < from.opened_on) || (to && date < to.opened_on)) fields.date = "Transfer date cannot be before either account opened.";
  }
  if (from && to && from.currency !== to.currency) validateMoneyField(moneyIn, to.currency, "in", fields, { positive: true });
  issue(fields);
  let counter = moneyIn, snap = null;
  if (from.currency === to.currency) counter = money(moneyOut.amount, to.currency);
  else {
    try { snap = { from: from.currency, to: to.currency, rate: fx.impliedRate(moneyOut, counter), source: "user", at: nowIso() }; }
    catch { throw new ValidationError({ fields: { in: "Enter an actual received amount that can be represented as a saved conversion." } }); }
  }
  let bm;
  try { bm = fx.snapshotAt(moneyOut, base(), date, today()); }
  catch { throw new ValidationError({ fields: { out: "This amount cannot be safely converted for the transfer date." } }); }
  const row = store.insert("transactions", { kind: "transfer", account_id: from.id, counter_account_id: to.id, money: moneyOut, counter_money: counter, base_money: bm.base_money, fx: snap || bm.fx, date, category_id: null, merchant: null, note: note || null, source: "form", recurring_rule_id: null, confirmed_at: nowIso(), dedupe_hash: `${date}|${moneyOut.amount}|transfer|${from.id}|${to.id}`, voided_at: null, void_reason: null });
  bus.emit("write", { table: "transactions", row });
  return row;
}

export function reconcileCheck(accountId, date, bankBalance) {
  const account = get(accountId), fields = {};
  if (!account || account.archived_at) fields.account = "Choose a live account.";
  if (!validDate(date)) fields.date = "Choose a valid calendar date.";
  if (account && bankBalance != null) validateMoneyField(bankBalance, account.currency, "bank", fields);
  issue(fields);
  const computed = balance(accountId, date);
  const gap = bankBalance != null ? money(bankBalance.amount - computed.amount, computed.currency) : null;
  const last = store.all("reconciliations").filter((r) => r.account_id === accountId).sort((a, b) => b.statement_date.localeCompare(a.statement_date))[0];
  const since = store.all("transactions").filter((t) => (t.account_id === accountId || t.counter_account_id === accountId) && (!last || t.date > last.statement_date) && t.date <= date);
  return { computed, gap, since, last };
}
export function saveReconciliation(accountId, date, bankBalance, computed, gap) {
  const account = get(accountId), fields = {};
  if (!account || account.archived_at) fields.account = "Choose a live account.";
  if (!validDate(date)) fields.date = "Choose a valid calendar date.";
  if (account && bankBalance != null) validateMoneyField(bankBalance, account.currency, "bank", fields);
  const actualComputed = account && validDate(date) ? balance(accountId, date) : null;
  if (account) {
    validateMoneyField(computed, account.currency, "computed", fields);
    if (actualComputed && validAccountMoney(computed, account.currency) && computed.amount !== actualComputed.amount) fields.computed = "App balance must match the calculated balance for this date.";
    if (bankBalance == null) { if (gap != null) fields.bank = "A gap requires a statement balance."; }
    else if (!validAccountMoney(gap, account.currency) || gap.amount !== bankBalance.amount - computed?.amount) fields.bank = "The gap must equal statement balance minus app balance.";
  }
  issue(fields);
  const actualGap = bankBalance == null ? null : money(bankBalance.amount - actualComputed.amount, account.currency);
  return store.insert("reconciliations", { account_id: accountId, statement_date: date, statement_balance: bankBalance, computed_balance: actualComputed, gap: actualGap, lines: [], confirmed_at: nowIso() });
}

// ---------- UI ----------
export function accountsPage() {
  const rows = withBalances(true);
  const tot = totalBase(true);
  const cur = rows.filter((r) => !r.archived_at), arch = rows.filter((r) => r.archived_at);
  const row = (a) => `<div class="row clickable" data-open="${a.id}"><div class="grow"><div class="title">${esc(a.name)}<span class="tag">${a.type}</span>${a.archived_at ? '<span class="tag">archived</span>' : ""}</div>
    <div class="sub">${a.currency}${a.base_balance && a.currency !== base() ? ` · ${fmt(a.base_balance)} in base${a.rate ? ` (rate entered ${fmtDate(a.rate.fetched_at.slice(0, 10))})` : ""}` : ""}${!a.base_balance && a.reason ? ` · ${a.reason}` : ""}${a.type === "credit" ? ` · available ${available(a) ? fmt(available(a)) : "—"}` : ""}</div></div>
    <div class="amt ${a.balance.amount < 0 ? "neg" : ""}">${fmt(a.balance)}</div></div>`;
  return {
    title: "Accounts",
    html: html`<div class="stat"><div class="label">All accounts in ${base()}</div><div class="value">${tot.total ? fmt(tot.total) : raw(absent(tot.reasons[0]).s)}</div>
      ${tot.reasons.length ? raw(`<div class="sub">Incomplete: ${esc(tot.reasons.join("; "))}. Partial: ${fmt(tot.partial)}${rateLinks(tot.reasons)}</div>`) : tot.oldest_rate ? raw(`<div class="sub">Oldest rate entered ${fmtDate(tot.oldest_rate.slice(0, 10))}</div>`) : ""}</div>
      ${!cur.length?raw('<div class="card"><h2>First account</h2><p>Create your financial accounts manually using ＋ Account below. Then import a statement through Add.</p><button type="button" data-account-skip>Skip for now</button></div>'):""}
      <div class="actions"><button class="primary" data-action="new">＋ Account</button><button data-action="transfer">⇄ Transfer</button><button data-action="check">Balance check</button></div>
      <div class="card">${cur.length ? raw(cur.map(row).join("")) : raw('<div class="empty">No accounts yet. Add your bank, cash, wallet or card.</div>')}</div>
      ${arch.length ? raw(`<div class="card"><h2>Archived</h2>${arch.map(row).join("")}</div>`) : ""}`,
    bind(root) {
      root.querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => (location.hash = `#/accounts/${el.dataset.open}`)));
      root.querySelector('[data-account-skip]')?.addEventListener('click',async()=>{try{await commitAction(()=>store.update('profile',profile().id,{assistant_setup_skipped:{...profile().assistant_setup_skipped,account:true}}));location.hash='#/home';}catch(e){toast(e.message);}});
      root.querySelector("[data-action=new]").onclick = () => newAccountModal();
      root.querySelector("[data-action=transfer]").onclick = () => transferModal();
      root.querySelector("[data-action=check]").onclick = () => balanceCheckModal();
    },
  };
}

// preset: {name, type, currency, opening} from the assistant; the person still checks and confirms.
export function newAccountModal(after, preset = {}) {
  const m = modal({ title: "New account", body: field("Name", inp("name", { required: true, value: preset.name || "", placeholder: "e.g. DBS savings" })) + `<div class="inline">${field("Type", sel("type", TYPES, TYPES.includes(preset.type) ? preset.type : undefined))}${field("Currency", sel("currency", CURRENCIES, CURRENCIES.includes(preset.currency) ? preset.currency : base()))}</div>` + `<div class="inline">${field("Opening balance", moneyInput("opening", preset.opening || "", "Enter an amount, including 0"), "Enter zero if this account starts at zero.")}${field("Opened on", inp("opened_on", { type: "date", value: preset.opened_on ?? today(), required: true }))}</div>` + `<div class="inline">${field("Credit limit (credit only)", moneyInput("limit", preset.credit_limit ?? "", "blank = unknown"), "Optional; blank means unknown.")}${field("Statement day (credit)", inp("statement_day", { type: "number", value: preset.statement_day ?? "", min: 1, max: 31, step: 1 }), "Optional; enter a whole day from 1 to 31.")}</div>`,
    onSubmit: (f) => {
      const cur = f.get("currency"), opening = parseTypedMoney(f.get("opening"), cur), limit = parseTypedMoney(f.get("limit"), cur), dayText = f.get("statement_day") ?? "";
      const fields = {};
      validateName(f.get("name"), fields);
      if (!TYPES.includes(f.get("type"))) fields.type = "Choose a supported account type.";
      if (!CURRENCIES.includes(cur)) fields.currency = "Choose a supported currency.";
      if (opening.blank || !opening.value) fields.opening = "Enter a valid opening amount, including zero.";
      if (!validDate(f.get("opened_on"))) fields.opened_on = "Choose a valid calendar date.";
      if (f.get("type") === "credit" && !limit.blank && !limit.value) fields.limit = "Enter a valid credit limit or leave it blank.";
      if (f.get("type") === "credit" && dayText !== "" && (!/^[0-9]+$/.test(dayText) || Number(dayText) < 1 || Number(dayText) > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
      issue(fields);
      preset.beforeCommit?.();
      const a = create({ name: f.get("name"), type: f.get("type"), currency: cur, openingBalance: opening.value, openedOn: f.get("opened_on"), creditLimit: limit.value, statementDay: dayText === "" ? null : Number(dayText) });
      toast("Account created"); return a;
    }, onSuccess: (a) => after?.(a) });
  bindValidation(m.form, { validate(values) {
    const fields = {}, cur = values.get("currency"), opening = parseTypedMoney(values.get("opening"), cur), limit = parseTypedMoney(values.get("limit"), cur), day = values.get("statement_day") ?? "";
    validateName(values.get("name"), fields);
    if (!TYPES.includes(values.get("type"))) fields.type = "Choose a supported account type.";
    if (!CURRENCIES.includes(cur)) fields.currency = "Choose a supported currency.";
    if (opening.blank || !opening.value) fields.opening = "Enter a valid opening amount, including zero.";
    if (!validDate(values.get("opened_on"))) fields.opened_on = "Choose a valid calendar date.";
    if (values.get("type") === "credit" && !limit.blank && !limit.value) fields.limit = "Enter a valid credit limit or leave it blank.";
    if (values.get("type") === "credit" && day !== "" && (!/^[0-9]+$/.test(day) || Number(day) < 1 || Number(day) > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
    return { fields };
  }, dependencies: { currency: ["opening", "limit"], type: ["limit", "statement_day"] } });
  const setCreditFields = () => {
    const isCredit = m.form.type.value === "credit";
    m.form.limit.disabled = m.form.statement_day.disabled = !isCredit;
  };
  m.form.type.addEventListener("change", setCreditFields); setCreditFields();
}

export function transferModal(preset = {}) {
  const accts = active();
  if (accts.length < 2) return toast("Need two accounts to transfer.");
  const m = modal({ title: "Transfer between accounts", body: `<div class="inline">${field("From", sel("from", accts, preset.fromId || accts[0].id, (a) => `${a.name} (${a.currency})`, (a) => a.id))}${field("To", sel("to", accts, preset.toId || accts[1].id, (a) => `${a.name} (${a.currency})`, (a) => a.id))}</div>
    ${field("Amount out", moneyInput("out", preset.out || ""))}<div data-in-wrap>${field("Amount in (other currency)", moneyInput("in", preset.in || "", "type the amount received"), "For different currencies, type the actual amount received; the saved rate is only a proposal.")}<div class="hint" data-propose></div></div>
    <div class="inline">${field("Date", inp("date", { type: "date", value: preset.date || today() }))}${field("Note", inp("note", { value: preset.note || "" }))}</div><p class="hint">Transfers have no category and never count as spending or income.</p>`,
    submitLabel: "Save transfer", onSuccess: preset.onDone,
    onSubmit: (f) => {
      preset.beforeCommit?.();
      const from = get(f.get("from")), to = get(f.get("to"));
      const out = from && parseTypedMoney(f.get("out"), from.currency), incoming = to && parseTypedMoney(f.get("in"), to.currency);
      const result = transfer({ fromId: f.get("from"), toId: f.get("to"), moneyOut: out?.value, moneyIn: incoming?.value, date: f.get("date"), note: f.get("note") });
      toast("Transfer saved"); return result;
    } });
  bindValidation(m.form, { validate(values) {
    const fields = {}, from = get(values.get("from")), to = get(values.get("to"));
    if (!from || from.archived_at) fields.from = "Choose a live account.";
    if (!to || to.archived_at) fields.to = "Choose a live account.";
    if (from && to && from.id === to.id) fields.to = "Choose a different receiving account.";
    const out = from && parseTypedMoney(values.get("out"), from.currency);
    if (!from || !out?.value || out.value.amount <= 0) fields.out = "Enter a positive amount in the sender’s currency.";
    if (!validDate(values.get("date"))) fields.date = "Choose a valid calendar date.";
    else if ((from && values.get("date") > today()) || (from && values.get("date") < from.opened_on) || (to && values.get("date") < to.opened_on)) fields.date = "Choose a date after both accounts opened and not in the future.";
    if (from && to && from.currency !== to.currency) {
      const incoming = parseTypedMoney(values.get("in"), to.currency);
      if (!incoming?.value || incoming.value.amount <= 0) fields.in = "Enter the positive actual amount received in the receiving currency.";
    }
    return { fields };
  }, dependencies: { from: ["to", "out", "in", "date"], to: ["in", "date"], out: ["in"], date: ["in"] } });
  const refresh = () => {
    const from = get(m.form.from.value), to = get(m.form.to.value);
    const wrap = m.form.querySelector("[data-in-wrap]");
    wrap.style.display = from.currency === to.currency ? "none" : "";
    if (from.currency !== to.currency) {
      const out = parseMoney(m.form.out.value, from.currency);
      const r = fx.rateAt(from.currency, to.currency, m.form.date.value, today());
      const conv = out && r ? convert(out, to.currency, r.rate) : null;
      const hint = m.form.querySelector("[data-propose]");
      hint.textContent = conv ? `Your saved rate proposes ${fmt(conv)} (1 ${from.currency} = ${r.rate} ${to.currency}). Check the actual amount received; those two amounts will be saved.` : `${fx.missingRateReason(from.currency, to.currency, m.form.date.value)}. You can still type the actual amount received.`;
      const link = document.createElement("a"); link.className = "btn small";
      link.href = fx.rateUrl(from.currency, to.currency, m.form.date.value); link.textContent = "Update rate"; hint.append(document.createTextNode(" "), link);
      if (conv && !m.form.in.value) m.form.in.value = toDecimalString(conv);
    }
  };
  m.form.from.onchange = m.form.to.onchange = m.form.date.onchange = refresh;
  m.form.out.onblur = refresh; refresh();
}

export function balanceCheckModal(accountId) {
  const accts = active();
  if (!accts.length) return toast("No accounts yet.");
  let previewKey = null;
  const checkKey = (id, date, bank, result) => JSON.stringify({
    id, date, bank: bank ? [bank.amount, bank.currency] : null,
    computed: [result.computed.amount, result.computed.currency],
    gap: result.gap ? [result.gap.amount, result.gap.currency] : null,
    since: result.since.map((row) => row.id), last: result.last ? [result.last.id, result.last.statement_date] : null,
  });
  const m = modal({ title: "Balance check against your bank", body: field("Account", sel("account", accts, accountId || accts[0].id, (a) => a.name, (a) => a.id)) + `<div class="inline">${field("Statement date", inp("date", { type: "date", value: today(), required: true }))}${field("Balance the bank shows (optional)", moneyInput("bank", "", "blank = no statement balance"), "Leave blank if the statement has no closing balance.")}</div><div data-result></div>`,
    submitLabel: "Show check", onSuccess: () => toast("Check recorded"),
    onSubmit: (f, form) => {
      const a = get(f.get("account")), typed = a && parseTypedMoney(f.get("bank"), a.currency);
      const bank = typed?.value ?? null;
      const date = f.get("date"), r = reconcileCheck(f.get("account"), date, bank), currentKey = checkKey(f.get("account"), date, bank, r);
      const res = form.querySelector("[data-result]");
      if (!res.dataset.shown || previewKey !== currentKey) {
        previewKey = currentKey;
        res.dataset.shown = "1";
        const card = document.createElement("div"); card.className = "card";
        for (const text of [`App says ${fmt(r.computed)} on ${fmtDate(f.get("date"))}. Bank says ${bank ? fmt(bank) : "—"}.`, `Gap: ${r.gap ? fmt(r.gap, { sign: true }) : "— (no bank balance typed)"}. Nothing is changed automatically. To fix, add or edit transactions (note "reconciliation").`, `${r.since.length} transactions since ${r.last ? "last check " + fmtDate(r.last.statement_date) : "the start"}.`]) {
          const p = document.createElement("p"); p.textContent = text; card.append(p);
        }
        const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = "Review these figures, then press Record check.";
        res.replaceChildren(card, hint); form.querySelector('[type="submit"]').textContent = "Record check";
        return false;
      }
      return saveReconciliation(a.id, date, bank, r.computed, r.gap);
    } });
  bindValidation(m.form, { validate(values) {
    const fields = {}, account = get(values.get("account")), bank = account && parseTypedMoney(values.get("bank"), account.currency);
    if (!account || account.archived_at) fields.account = "Choose a live account.";
    if (!validDate(values.get("date"))) fields.date = "Choose a valid calendar date.";
    if (account && values.get("bank").trim() && !bank?.value) fields.bank = "Enter a valid statement balance or leave it blank.";
    return { fields };
  }, dependencies: { account: ["bank"], date: ["bank"] } });
  const invalidatePreview = (event) => {
    if (!m.form.querySelector("[data-result]")?.dataset.shown) return;
    if (!event.target.name || !["account", "date", "bank"].includes(event.target.name)) return;
    const result = m.form.querySelector("[data-result]"); delete result.dataset.shown; result.replaceChildren(); previewKey = null;
    m.form.querySelector('[type="submit"]').textContent = "Show check";
  };
  m.form.addEventListener("input", invalidatePreview); m.form.addEventListener("change", invalidatePreview);
}

export function accountDetailPage(id) {
  const a = get(id) || store.all("accounts", { includeDeleted: true }).find((x) => x.id === id);
  if (!a) return { title: "Account", html: "<div class='empty'>Not found</div>", bind() {} };
  const bal = balance(id);
  const txs = store.all("transactions").filter((t) => t.account_id === id || t.counter_account_id === id).sort((x, y) => y.date.localeCompare(x.date) || y.created_at.localeCompare(x.created_at)).slice(0, 100);
  const checks = store.all("reconciliations").filter((r) => r.account_id === id).sort((x, y) => y.statement_date.localeCompare(x.statement_date)).slice(0, 5);
  return {
    title: a.name,
    html: html`<div class="stat"><div class="label">${a.type} · ${a.currency} · opened ${fmtDate(a.opened_on)}</div><div class="value">${fmt(bal)}</div>${a.type === "credit" ? raw(`<div class="sub">${bal.amount <= 0 ? "owed " + fmt(neg(bal)) : "overpaid"} · available ${available(a) ? fmt(available(a)) : "— (no limit set)"}${a.debt_id ? " · linked to a debt" : ""}</div>`) : ""}</div>
      <div class="actions"><button data-action="edit">Edit</button><button data-action="transfer">⇄ Transfer</button><button data-action="check">Balance check</button>${a.archived_at ? "" : raw(`<a class="btn" href="#/accounts/${a.id}/match">Match a statement</a><button class="danger" data-action="archive">Archive</button>`)}</div>
      ${checks.length ? raw(`<div class="card"><h2>Balance checks</h2>${checks.map((c) => `<div class="row"><div class="grow"><div class="title">${fmtDate(c.statement_date)}</div><div class="sub">bank ${fmt(c.statement_balance)} · app ${fmt(c.computed_balance)}</div></div><div class="amt">gap ${c.gap ? fmt(c.gap, { sign: true }) : "—"}</div></div>`).join("")}</div>`) : ""}
      <div class="card"><h2>Transactions</h2>${txs.length ? raw(txs.map((t) => txRow(t, id)).join("")) : raw('<div class="empty">None yet.</div>')}</div>`,
    bind(root) {
      root.querySelector("[data-action=edit]").onclick = () => {
        const m = modal({ title: "Edit account", body: field("Name", inp("name", { value: a.name, required: true })) + (a.type === "credit" ? `<div class="inline">${field("Credit limit (optional)", moneyInput("limit", a.credit_limit ? toDecimalString(a.credit_limit) : "", "blank = unknown"), "Leave blank if the limit is unknown.")}${field("Statement day (optional)", inp("statement_day", { type: "number", value: a.statement_day || "", min: 1, max: 31, step: 1 }), "Enter a whole day from 1 to 31, or leave blank.")}</div>` : ""), onSubmit: (f) => {
          const limit = parseTypedMoney(f.get("limit"), a.currency), day = f.get("statement_day"), fields = {};
          validateName(f.get("name"), fields);
          if (a.type === "credit" && f.get("limit").trim() && !limit.value) fields.limit = "Enter a valid credit limit or leave it blank.";
          if (a.type === "credit" && day !== "" && (!/^[0-9]+$/.test(day) || Number(day) < 1 || Number(day) > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
          issue(fields);
          return update(a.id, { name: f.get("name"), ...(a.type === "credit" ? { credit_limit: limit.value, statement_day: day === "" ? null : Number(day) } : {}) });
        } });
        bindValidation(m.form, { validate(values) {
          const fields = {}, limit = parseTypedMoney(values.get("limit"), a.currency), day = values.get("statement_day");
          validateName(values.get("name"), fields);
          if (a.type === "credit" && values.get("limit").trim() && !limit.value) fields.limit = "Enter a valid credit limit or leave it blank.";
          if (a.type === "credit" && day !== "" && (!/^[0-9]+$/.test(day) || Number(day) < 1 || Number(day) > 31)) fields.statement_day = "Enter a whole day from 1 to 31.";
          return { fields };
        } });
      };
      root.querySelector("[data-action=transfer]").onclick = () => transferModal({ fromId: a.id });
      root.querySelector("[data-action=check]").onclick = () => balanceCheckModal(a.id);
      root.querySelector("[data-action=archive]")?.addEventListener("click", () => modal({ title: "Archive account?", body: "<p>Hidden from pickers. Balance still counts in net worth until zero. Recurring rules on it pause.</p>", submitLabel: "Archive", danger: true, onSubmit: () => { archive(a.id); }, onSuccess: () => { location.hash = "#/accounts"; } }));
    },
  };
}
export function txRow(t, viewAccountId) {
  const incoming = t.kind === "income" || (t.kind === "transfer" && t.counter_account_id === viewAccountId && viewAccountId);
  const amt = t.kind === "transfer" && incoming ? t.counter_money : t.money;
  const label = t.kind === "transfer" ? `Transfer ${incoming ? "from " + (get(t.account_id)?.name || "?") : "to " + (get(t.counter_account_id)?.name || "?")}` : t.merchant || t.note || (t.kind === "income" ? "Income" : "Expense");
  return `<a class="row clickable ${t.voided_at ? "void" : ""}" data-tx="${t.id}" data-record-control="record:${t.id}" href="#/transactions/${encodeURIComponent(t.id)}"><span class="grow"><span class="title">${esc(label)}${t.source !== "form" ? `<span class="tag ${["text", "photo", "csv", "assistant"].includes(t.source) ? "ai" : ""}">${t.source}</span>` : ""}</span><span class="sub">${fmtDate(t.date)}${t.kind !== "transfer" ? " · " + esc(catLabel(t.category_id)) : ""}${!viewAccountId ? " · " + esc(get(t.account_id)?.name || "") : ""}</span></span><span class="amt ${incoming ? "pos" : "neg"}">${incoming ? "+" : "−"}${fmt(amt)}${t.entered_money ? `<br><small class="muted">${fmt(t.entered_money)} paid</small>` : ""}</span></a>`;
}

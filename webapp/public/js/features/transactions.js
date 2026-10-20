// Transactions: five doors, one confirm path. Recurring rules with catch-up. Cancel = strikethrough.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, parseMoney, isMoney, CURRENCIES, toDecimalString, convert } from "../lib/money.js";
import * as fx from "../lib/fx.js";
import * as D from "../lib/dates.js";
import { html, raw, modal, confirm, field, inp, sel, toast, moneyInput, esc, cap, rateLink, commitFormAction, commitAction, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { LIMITS, validDate } from "../lib/assistant-tasks.js";
import * as vault from "../lib/vault.js";
import * as bus from "../lib/bus.js";
import { base, today, entryCurrency, overseasCurrency } from "./profile.js";
import { createOperation } from "../lib/operations.js";
import * as A from "./accounts.js";
import * as C from "./categories.js";
import * as AL from "./alerts.js";
import { icon } from "../lib/icons.js";

export const SOURCES = ["form", "text", "photo", "csv", "notification", "recurring", "assistant"];
export const get = (id) => store.get("transactions", id);
export const all = () => store.all("transactions");
export const live = () => all().filter((t) => !t.voided_at); // counted in totals
// Read saved conversions only. Never fill a missing historical amount from a new current rate.
export const baseAmount = (t) => t.money.currency === base() ? t.money : t.base_money?.currency === base() ? t.base_money : null;
export function baseTotals(txs) {
  let amount = 0; const reasons = [];
  for (const t of txs) { const m = baseAmount(t); if (m) amount += m.amount; else reasons.push(`${fx.missingRateReason(t.money.currency, base(), t.date)} (saved conversion absent)`); }
  const partial = money(amount, base());
  return { total: reasons.length ? null : partial, partial, missing: reasons.length, reasons: [...new Set(reasons)] };
}
function resetCategorySelect(wrap, kind) {
  const select = document.createElement("select"); select.name = "category_id";
  for (const [value, label] of [["", "— Pick a category"], ...C.list(kind).map((c) => [c.id, C.label(c)])]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option);
  }
  const previous = wrap.querySelector('select');
  if (previous) {
    for (const name of ['id', 'aria-describedby', 'aria-labelledby', 'aria-invalid']) if (previous.hasAttribute(name)) select.setAttribute(name, previous.getAttribute(name));
    previous.replaceWith(select);
  } else wrap.append(select);
}
export const merchantKey = C.normaliseMerchant;

export function validate(d) {
  const fields = {};
  if (!["income", "expense"].includes(d.kind)) fields.kind = "INVALID_KIND";
  const a = A.get(d.account_id);
  if (!a) fields.account_id = "Pick an account.";
  if (!isMoney(d.money) || d.money.amount === 0) fields.amount = "Amount is required and cannot be zero.";
  else if (d.money.amount < 0) fields.amount = "Negative amounts are refused. A refund = cancel the original.";
  if (d.money && !CURRENCIES.includes(d.money.currency)) fields.currency = "Choose a supported currency.";
  if (!d.date) fields.date = "Date required";
  else if (d.date > today()) fields.date = "Date cannot be in the future. Use a recurring rule for future items.";
  else {
    try { fx.validateDate(d.date); } catch { fields.date = "Choose a valid calendar date."; }
    if (!fields.date && a && d.date < a.opened_on) fields.date = `Date is before ${a.name} was opened (${a.opened_on}).`;
  }
  if (d.category_id) {
    const c = C.get(d.category_id);
    if (!c) fields.category_id = "Category not found";
    else if (c.kind !== d.kind) fields.category_id = `Category is ${c.kind}, transaction is ${d.kind}.`;
  }
  if (Object.keys(fields).length) throw new ValidationError({ fields });
}
export const dedupeHash = (d) => `${d.date}|${d.money.amount}|${merchantKey(d.merchant)}|${d.account_id}`;

// A record moves its account in the ACCOUNT's currency. What the user actually paid, when that
// was a different currency, is kept beside it with the rate frozen at confirm.
function toAccountCurrency(d, accountRate) {
  const acct = A.get(d.account_id);
  if (d.money.currency === acct.currency) return { money: d.money, entered_money: null, entered_fx: null };
  const snap = fx.snapshotAt(d.money, acct.currency, d.date, today(), accountRate);
  if (!snap.base_money) throw fx.missingRateError(d.money.currency, acct.currency, d.date);
  if (snap.base_money.amount <= 0) throw new Error("That rate converts the amount to less than the account's smallest unit. Check the amount and rate.");
  return { money: snap.base_money, entered_money: d.money, entered_fx: snap.fx };
}
// A bank's own reference for a row, when its file carries one, identifies that row exactly, so the same
// file imported twice is caught even when two coffees share a date and a price. Without one, the hash.
export const findDuplicate = (d, excludeId) => {
  if (d.bank_ref) return live().find((t) => t.bank_ref === d.bank_ref && t.account_id === d.account_id && t.id !== excludeId) || null;
  const h = dedupeHash(d); return live().find((t) => t.dedupe_hash === h && t.id !== excludeId) || null;
};

export function save(d, { userRate, accountRate } = {}) {
  validate(d);
  if (d.kind === "income") d = { ...d, merchant: null }; // merchant is expense-only (ruled 2026-09-18)
  const conv = toAccountCurrency(d, accountRate);
  d = { ...d, money: conv.money };
  const snap = fx.snapshotAt(conv.money, base(), d.date, today(), userRate);
  const row = store.insert("transactions", {
    kind: d.kind, account_id: d.account_id, counter_account_id: null, counter_money: null, money: conv.money,
    entered_money: conv.entered_money, entered_fx: conv.entered_fx,
    base_money: snap.base_money, fx: snap.fx, date: d.date, category_id: d.category_id || null,
    merchant: d.merchant?.trim() || null, note: d.note?.trim() || null, source: d.source || "form",
    recurring_rule_id: d.recurring_rule_id || null, confirmed_at: nowIso(), dedupe_hash: dedupeHash(d), bank_ref: d.bank_ref || null, voided_at: null, void_reason: null,
  });
  if (row.merchant && row.category_id) C.learn(row.merchant, row.category_id);
  bus.emit("write", { table: "transactions", row });
  return row;
}
export function update(id, edits, { userRate, accountRate } = {}) {
  const t = get(id); if (!t) throw new Error("Not found");
  const d = { ...t, ...edits };
  if (d.kind === "income") { d.merchant = null; edits = { ...edits, merchant: null }; }
  validate(d);
  let conversionChanged = false;
  if (edits.money) {
    const original = t.entered_money || t.money;
    const sameInput = d.account_id === t.account_id && d.date === t.date && edits.money.amount === original.amount && edits.money.currency === original.currency && (!accountRate || accountRate === t.entered_fx?.rate);
    const conv = sameInput ? { money: t.money, entered_money: t.entered_money || null, entered_fx: t.entered_fx || null } : toAccountCurrency(d, accountRate);
    conversionChanged = !sameInput;
    edits = { ...edits, money: conv.money, entered_money: conv.entered_money, entered_fx: conv.entered_fx };
    d.money = conv.money;
  }
  const patch = { ...edits, dedupe_hash: dedupeHash(d) };
  if (conversionChanged || d.date !== t.date || d.account_id !== t.account_id || userRate) {
    const snap = fx.snapshotAt(d.money, base(), d.date, today(), userRate); patch.base_money = snap.base_money; patch.fx = snap.fx;
  }
  if (edits.money && (edits.money.amount !== t.money.amount || edits.money.currency !== t.money.currency)) {
    if (t.recurring_rule_id) {
      const r = store.get("recurring_rules", t.recurring_rule_id);
      if (r && r.template.money.amount !== edits.money.amount) AL.fire({ type: "price_change", severity: "info", source: { feature: "transactions", entity_id: t.id }, dedupe_key: `price_change:${t.id}`, title: `${r.name || t.merchant || "Recurring"} amount changed`, body: `Posted ${fmt(edits.money)} vs rule ${fmt(r.template.money)}. Rule unchanged.` });
    }
  }
  const row = store.update("transactions", id, patch);
  if (row.merchant && row.category_id && edits.category_id) C.learn(row.merchant, row.category_id);
  bus.emit("write", { table: "transactions", row });
  return row;
}
export function cancel(id, reason) { const row = store.update("transactions", id, { voided_at: nowIso(), void_reason: reason }); bus.emit("write", { table: "transactions", row }); return row; }
export function restore(id) { const row = store.update("transactions", id, { voided_at: null, void_reason: null }); bus.emit("write", { table: "transactions", row }); return row; }
export function remove(id) { store.softDelete("transactions", id); bus.emit("write", { table: "transactions" }); }

export function search({ q = "", kind, accountId, categoryId, from, to, source, showCancelled = true } = {}) {
  const ql = q.trim().toLowerCase();
  return all().filter((t) => (showCancelled || !t.voided_at) && (!kind || t.kind === kind) && (!accountId || t.account_id === accountId || t.counter_account_id === accountId)
    && (!categoryId || C.subtreeIds(categoryId).includes(t.category_id)) && (!from || t.date >= from) && (!to || t.date <= to) && (!source || t.source === source)
    && (!ql || (t.merchant || "").toLowerCase().includes(ql) || (t.note || "").toLowerCase().includes(ql)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
}

// ---------- confirm path (one modal per draft) ----------
export function confirmModal(draft, { title = "Confirm transaction", existing = null, progress = "", onDone, work, beforeCommit, suppressCategoryAI = false, initialRate = null, initialBaseRate = null, unresolvedFields = {} } = {}) {
  const operationId = crypto.randomUUID();
  let receipt = null;
  const accts = A.active();
  if (!accts.length) { toast("Create an account first."); location.hash = "#/accounts"; return; }
  const d = { kind: "expense", account_id: accts[0].id, date: today(), source: "form", ...draft };
  if (unresolvedFields.account_id) d.account_id = "";
  if (unresolvedFields.category_id) d.category_id = null;
  const accountChoices = unresolvedFields.account_id ? [{ id: "", name: "— choose an account", currency: "" }, ...accts] : accts;
  const acct = A.get(d.account_id) || accts[0];
  const inputMoney = d.entered_money || d.money;
  const currency = inputMoney?.currency || entryCurrency(acct);
  const overseas = overseasCurrency();
  const dup = existing ? null : d.money ? findDuplicate(d) : null;
  const catOpts = (kind, selected) => sel("category_id", [{ id: "", n: "— pick a category" }, ...C.list(kind).map((c) => ({ id: c.id, n: C.label(c) }))], selected || "", (c) => c.n, (c) => c.id);
  const m = importModal(work, {
    title: progress ? `${title} ${progress}` : title,
    submitLabel: existing ? "Save changes" : "Confirm & save",
    onClose: (reason) => { if (reason === "submit") C.checkUnlock(); },
    body: `${d.source && d.source !== "form" ? `<p class="ai-note">Pre-filled by ${d.source === "recurring" ? "a recurring rule" : "AI"}. Check every field. Blanks stay blank.</p>` : ""}
      ${overseas && !existing ? `<p class="ai-note">Overseas mode is on, so this starts in ${overseas} rather than the account's ${acct.currency}.</p>` : ""}
      ${dup ? `<div class="card warn"><b>Possible duplicate</b>: ${fmt(dup.money)} at ${dup.merchant || "—"} on ${dup.date} already exists. You can still confirm.</div>` : ""}
      <div class="inline">${field("Kind", sel("kind", ["expense", "income"], d.kind))}${field("Account", sel("account_id", accountChoices, d.account_id, (a) => a.id ? `${a.name} (${a.currency})` : a.name, (a) => a.id))}</div>
      <div class="inline">${field("Amount", moneyInput("amount", inputMoney ? toDecimalString(inputMoney) : ""))}${field("Currency", sel("currency", CURRENCIES, currency))}</div>
      <div class="hint" data-approx></div>
      <div data-rate-wrap hidden><label data-rate-label>Exchange rate${moneyInput("rate", initialRate ?? d.entered_fx?.rate ?? "", "blank = saved manual rate")}</label><div class="hint" data-rate-note></div><a class="btn small" data-update-rate>Update rate</a></div>
      <div data-base-rate-wrap hidden><label data-base-rate-label>Base conversion${moneyInput("base_rate", initialBaseRate ?? "", "blank = saved manual rate")}</label><div class="hint" data-base-rate-note></div><a class="btn small" data-update-base-rate>Update rate</a></div>
      <div class="inline">${field("Date", inp("date", { type: "date", value: d.date }))}<div data-merchant-wrap style="flex:1">${field("Merchant", inp("merchant", { value: d.merchant || "", placeholder: "e.g. Starbucks" }), "Expenses only. Money coming in has no merchant.")}</div></div>
      <label data-category-label>Category <span data-cat-tag></span></label><div data-cat-wrap>${catOpts(d.kind, d.category_id)}</div>
      ${field("Note", inp("note", { value: d.note || "" }))}`,
    onSubmit: async (f, form) => {
      if (!receipt && work?.receipt?.operationId === operationId) receipt = work.receipt;
      if (receipt?.state === "failed") {
        if (work) await work.commit(() => { throw new Error("Retry must reuse the existing save."); }, operationId, form);
        else await commitFormAction(form, operationId, null, receipt);
      } else if (receipt?.state !== "durable") {
      const cur = f.get("currency");
      const kind = f.get("kind");
      const out = { kind, account_id: f.get("account_id"), money: parseMoney(f.get("amount"), cur), date: f.get("date"), category_id: f.get("category_id") || null, merchant: kind === "income" ? null : f.get("merchant"), note: f.get("note"), source: d.source || "form", recurring_rule_id: d.recurring_rule_id || null, bank_ref: d.bank_ref || null };
      if (!out.money) throw new Error("Amount is required.");
      if (unresolvedFields.category_id && !out.category_id) throw new ValidationError({ fields: { category_id: unresolvedFields.category_id } });
      const accountRate = f.get("rate") ? String(f.get("rate")) : undefined;
      const userRate = f.get("base_rate") ? String(f.get("base_rate")) : undefined;
      const write = () => { beforeCommit?.(); return existing ? update(existing.id, out, { accountRate, userRate }) : save(out, { accountRate, userRate }); };
      if (work) {
        try { receipt = await work.commit(write, operationId, form); }
        catch (error) {
          if (work.receipt?.state === "failed" && form?.isConnected) {
            form.querySelectorAll("input,select,textarea").forEach((control) => { control.disabled = true; });
            const button = form.querySelector('button[type="submit"]'); if (button) button.textContent = "Retry saving";
          }
          throw error;
        }
      } else {
        receipt = store.captureAction(operationId, write);
        await commitFormAction(form, operationId, null, receipt);
      }
      }
      if (receipt?.state !== "durable") throw new Error("Device storage did not confirm this save. It is not marked as saved.");
      if (!form.isConnected || receipt.ownerGeneration !== store.generation() || (work && !work.active())) return false;
      toast(existing ? "Updated" : "Saved");
      onDone?.(receipt.value);
    },
  });
  const form = m.form;
  bindValidation(form, {
    dependencies: { kind: ['category_id'], account_id: ['currency', 'date', 'rate', 'base_rate'], currency: ['amount', 'rate', 'base_rate'], amount: ['rate'], date: ['rate', 'base_rate'] },
    validate(values) {
      // Persistence-only retry keeps the previously validated action, even with disabled fields.
      if (receipt?.changed || work?.receipt?.operationId === operationId) return {};
      const fields = {}, cur = values.get('currency');
      const out = { kind: values.get('kind'), account_id: values.get('account_id'), money: parseMoney(values.get('amount'), cur), date: values.get('date'), category_id: values.get('category_id') || null };
      try { validate(out); } catch (error) { if (error instanceof ValidationError) Object.assign(fields, error.fields); else throw error; }
      if (unresolvedFields.account_id && !out.account_id) fields.account_id = unresolvedFields.account_id;
      if (unresolvedFields.category_id && !out.category_id) fields.category_id = unresolvedFields.category_id;
      if (!CURRENCIES.includes(cur)) fields.currency = 'Choose a supported currency.';
      for (const name of ['rate', 'base_rate']) {
        const value = values.get(name);
        if (value) { try { fx.validateRate(value); } catch (error) { fields[name] = error.message; } }
      }
      if (!Object.keys(fields).length) {
        const original = existing?.entered_money || existing?.money;
        const sameInput = existing && out.account_id === existing.account_id && out.date === existing.date && out.money.amount === original.amount && out.money.currency === original.currency && (!values.get('rate') || values.get('rate') === existing.entered_fx?.rate);
        if (!sameInput) {
          try { toAccountCurrency(out, values.get('rate') || undefined); }
          catch (error) { fields.rate = error.message; }
        }
      }
      return { fields };
    },
  });
  form.querySelector('[data-category-label]').htmlFor = form.elements.category_id.id;
  const merchantWrap = form.querySelector("[data-merchant-wrap]"), catWrap = form.querySelector("[data-cat-wrap]");
  const applyKind = () => {
    const income = form.kind.value === "income";
    merchantWrap.hidden = income;
    if (income) form.merchant.value = ""; // cleared, not merely hidden
    resetCategorySelect(catWrap, form.kind.value);
  };
  form.kind.onchange = applyKind;
  if (d.kind === "income") { merchantWrap.hidden = true; form.merchant.value = ""; }
  form.account_id.onchange = () => { const selected = A.get(form.account_id.value); if (selected && !unresolvedFields.account_id) form.currency.value = selected.currency; form.rate.value = ""; form.base_rate.value = ""; rateCheck(); };
  form.currency.onchange = () => { form.rate.value = ""; rateCheck(); };
  form.date.onchange = rateCheck;
  // The rate that matters is the one into the account's own currency: that is what moves the balance.
  const target = () => A.get(form.account_id.value)?.currency || base();
  function rateCheck() {
    if (!A.get(form.account_id.value)) { form.querySelector("[data-rate-wrap]").hidden = true; form.querySelector("[data-base-rate-wrap]").hidden = true; form.rate.disabled = true; form.base_rate.disabled = true; form.querySelector("[data-approx]").textContent = "Choose an account before reviewing its conversion."; return; }
    const cur = form.currency.value, t = target(), date = form.date.value;
    const wrap = form.querySelector("[data-rate-wrap]"); wrap.hidden = cur === t;
    form.rate.disabled = cur === t;
    const r = fx.rateAt(cur, t, date, today());
    if (cur !== t) {
      form.querySelector("[data-rate-label]").firstChild.textContent = `1 ${cur} = how many ${t}?`;
      form.querySelector("[data-rate-note]").textContent = r ? `Saved manual rate: 1 ${cur} = ${r.rate} ${t}. Leave blank to use it, or type the rate you were charged.` : `${fx.missingRateReason(cur, t, date)}. Update it in Settings or type it here before saving.`;
      form.querySelector("[data-update-rate]").href = fx.rateUrl(cur, t, date);
    }
    const baseWrap = form.querySelector("[data-base-rate-wrap]"); baseWrap.hidden = t === base(); form.base_rate.disabled = t === base();
    if (t !== base()) {
      const b = fx.rateAt(t, base(), date, today());
      if (existing && existing.base_money?.currency !== base() && b && !form.base_rate.value) form.base_rate.value = b.rate;
      form.querySelector("[data-base-rate-label]").firstChild.textContent = `1 ${t} = how many ${base()}?`;
      form.querySelector("[data-base-rate-note]").textContent = existing?.base_money && date === existing.date ? `Saved conversion: ${fmt(existing.base_money)}. Leave blank to keep it when only the note or category changes.` : b ? `Saved manual rate: 1 ${t} = ${b.rate} ${base()}.` : `${fx.missingRateReason(t, base(), date)}. The account record can be saved, but its base total will be incomplete.`;
      form.querySelector("[data-update-base-rate]").href = fx.rateUrl(t, base(), date);
    }
    showApprox(r);
  }
  // What it costs in the account's currency, before saving. Frozen onto the row at confirm.
  function showApprox(r) {
    const approx = form.querySelector("[data-approx]"), cur = form.currency.value, t = target();
    if (!A.get(form.account_id.value)) { approx.textContent = "Choose an account before reviewing its conversion."; return; }
    if (cur === t) { approx.textContent = ""; return; }
    let typed;
    try { typed = form.rate.value ? fx.validateRate(form.rate.value) : r?.rate; } catch { approx.textContent = "Enter a rate above zero."; return; }
    const m = parseMoney(form.amount.value, cur);
    if (!m || !typed) { approx.textContent = typed ? "" : fx.missingRateReason(cur, t, form.date.value); return; }
    approx.textContent = `${fmt(convert(m, t, typed))} ${form.kind.value === "income" ? "into" : "off"} ${A.get(form.account_id.value).name}`;
  }
  const reApprox = () => showApprox(fx.rateAt(form.currency.value, target(), form.date.value, today()));
  form.amount.addEventListener("input", reApprox);
  form.rate?.addEventListener("input", reApprox);
  rateCheck();
  // suggest category: rule first, AI second, blank otherwise
  const suggestNow = async () => {
    const merchant = form.merchant.value, tag = form.querySelector("[data-cat-tag]");
    if (suppressCategoryAI || d.source === "assistant" || !form.isConnected || (work && !work.active()) || !merchant || form.category_id.value) return;
    tag.textContent = "Thinking…";
    const s = await C.suggest(merchant, form.note.value, form.kind.value, { signal: work?.signal });
    if (!form.isConnected || (work && !work.active())) return;
    tag.replaceChildren();
    if (s.source === "rule" || s.source === "ai") {
      const badge = document.createElement("span"); badge.className = s.source === "ai" ? "tag ai" : "tag";
      badge.textContent = s.source === "rule" ? "Seen before" : `AI suggestion · ${s.confidence}`; tag.append(badge);
    }
    if (s.categoryId && form.category_id && !form.category_id.value) form.category_id.value = s.categoryId;
  };
  form.merchant.onblur = () => { if (form.kind.value !== "income") suggestNow(); };
  if (d.merchant && !d.category_id && d.kind !== "income") suggestNow();
  if (Object.keys(unresolvedFields).length) form.validation.show({ fields: unresolvedFields });
  return m;
}

export function confirmSequence(drafts, { title, work }) {
  let i = 0; const saved = [];
  const next = () => { if (work && !work.active()) return; if (i >= drafts.length) { if (drafts.length > 1) toast(`${saved.length} of ${drafts.length} saved`); work?.finish(); return; } const d = drafts[i++]; confirmModal(d, { title, work, unresolvedFields: d.unresolvedFields || {}, initialRate: d.rate_text ?? null, initialBaseRate: d.base_rate_text ?? null, progress: drafts.length > 1 ? `(${i}/${drafts.length})` : "", onDone: (r) => { saved.push(r); next(); } }); };
  next();
}

// ---------- doors ----------
export async function fromText(text, accountId, { signal } = {}) {
  const acct = A.get(accountId);
  const res = await ai.call("extract_from_text", {
    tier: "cheap", signal,
    system: "Extract transactions from the user's sentence. amount_text verbatim as written (no arithmetic). Resolve nothing; relative dates like 'yesterday' may be returned as ISO dates using today. Unknown fields null.",
    input: { text, today: today(), base_currency: base(), account_currency: entryCurrency(acct) },
    schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["amount_text", "kind"], properties: { amount_text: { type: ["string", "null"] }, currency: { type: ["string", "null"] }, merchant: { type: ["string", "null"] }, date: { type: ["string", "null"] }, kind: { type: "string", enum: ["income", "expense"] }, note: { type: ["string", "null"] } } } } } },
  });
  return res.items.map((it) => {
    const cur = it.currency && CURRENCIES.includes(it.currency.toUpperCase()) ? it.currency.toUpperCase() : entryCurrency(acct);
    const m = it.amount_text ? parseMoney(it.amount_text, cur) : null;
    let date = it.date && /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : today();
    if (date > today()) date = today();
    return { kind: it.kind, account_id: accountId, money: m && m.amount > 0 ? m : null, date, merchant: it.merchant || null, note: it.note || null, source: "text" };
  });
}

export async function fromImage(file, hint, accountId, { signal, message = "" } = {}) {
  const acct = A.get(accountId);
  const img = await ai.fileToImage(file, { signal });
  signal?.throwIfAborted();
  const res = await ai.call("extract_from_image", {
    tier: "cheap", images: [img], signal,
    system: "Read the receipt, payment list or statement in the image. Return texts verbatim: total_text and each item's amount_text exactly as printed. Never add or compute. Unknown = null. Dates ISO if printed.",
    input: { hint, message, base_currency: base(), account_currency: entryCurrency(acct) },
    schema: { type: "object", required: ["items"], properties: { merchant: { type: ["string", "null"] }, date: { type: ["string", "null"] }, currency: { type: ["string", "null"] }, total_text: { type: ["string", "null"] }, items: { type: "array", items: { type: "object", required: ["description", "amount_text"], properties: { description: { type: "string" }, amount_text: { type: ["string", "null"] }, date: { type: ["string", "null"] } } } } } },
  });
  const cur = res.currency && CURRENCIES.includes(res.currency.toUpperCase()) ? res.currency.toUpperCase() : entryCurrency(acct);
  const total = res.total_text ? parseMoney(res.total_text, cur) : null;
  const items = res.items.map((it) => ({ description: it.description, money: it.amount_text ? parseMoney(it.amount_text, cur) : null, date: it.date }));
  const itemSum = items.every((i) => i.money) ? items.reduce((s, i) => s + i.money.amount, 0) : null;
  const date = res.date && /^\d{4}-\d{2}-\d{2}$/.test(res.date) && res.date <= today() ? res.date : today();
  return { merchant: res.merchant || null, date, currency: cur, total, items, itemSum, mismatch: total && itemSum != null && itemSum !== total.amount };
}

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
export async function mapCsvColumns(header, sample, { signal } = {}) {
  return ai.call("map_csv_columns", {
    tier: "cheap", signal,
    system: "Given a CSV header and sample rows from a bank export, say which column holds the date, the amount (or separate debit and credit columns), the description, optionally the currency, and optionally a column holding the bank's own reference or transaction ID for each row. Give the date format as a pattern using YYYY MM DD. Say whether negative amounts mean expense or income.",
    input: { header, sample_rows: sample },
    schema: { type: "object", required: ["date_col", "description_col", "date_format", "negative_means"], properties: { date_col: { type: "string" }, amount_col: { type: ["string", "null"] }, debit_col: { type: ["string", "null"] }, credit_col: { type: ["string", "null"] }, description_col: { type: "string" }, currency_col: { type: ["string", "null"] }, reference_col: { type: ["string", "null"] }, date_format: { type: "string" }, negative_means: { type: "string", enum: ["expense", "income"] } } },
    validate: (o) => { const issues = csvMappingIssues(o, header); return Object.values(issues.fields)[0] || null; },
  });
}
function csvDateFormat(format) {
  if (typeof format !== 'string') return null;
  const match = /^(YYYY|MM|DD)([^A-Z0-9]*)(YYYY|MM|DD)\2(YYYY|MM|DD)$/.exec(format.trim().toUpperCase());
  if (!match || new Set([match[1], match[3], match[4]]).size !== 3) return null;
  return { order: [match[1], match[3], match[4]], separator: match[2].trim() || match[2] };
}
function csvMappingIssues(values, header) {
  const fields = {};
  for (const name of ['date_col', 'amount_col', 'debit_col', 'credit_col', 'description_col', 'currency_col', 'reference_col']) {
    if (values[name] && !header.includes(values[name])) fields[name] = 'Choose a column from this file.';
  }
  for (const name of ['date_col', 'description_col']) if (!values[name]) fields[name] = 'Choose a column from this file.';
  if (!csvDateFormat(values.date_format)) fields.date_format = 'Use YYYY, MM and DD, such as DD/MM/YYYY.';
  if (!values.amount_col && !(values.debit_col && values.credit_col)) {
    for (const name of ['amount_col', 'debit_col', 'credit_col']) fields[name] = 'Pick one signed amount column, or both debit and credit columns.';
  }
  if (!['expense', 'income'].includes(values.negative_means)) fields.negative_means = 'Choose what negative amounts mean.';
  return { fields };
}
export function parseDateWith(text, format = 'YYYY-MM-DD') {
  const spec = csvDateFormat(format), s = String(text ?? '').trim();
  if (!spec) return null;
  let parts;
  if (spec.separator) parts = s.split(/^\s+$/.test(spec.separator) ? /\s+/ : spec.separator).map(part => part.trim());
  else {
    if (!/^\d{8}$/.test(s)) return null;
    let offset = 0;
    parts = spec.order.map(token => { const width = token === 'YYYY' ? 4 : 2; const part = s.slice(offset, offset + width); offset += width; return part; });
  }
  if (parts.length !== 3) return null;
  const values = Object.fromEntries(spec.order.map((token, i) => [token, parts[i]]));
  let y = values.YYYY; const m = values.MM, d = values.DD;
  if (!/^(\d{2}|\d{4})$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  if (y.length === 2) y = '20' + y; // Retain the existing separated short-year convention.
  const out = D.iso(+y, +m, +d), parsed = new Date(`${out}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === out ? out : null;
}
export function applyMapping(rows, header, mapping, accountCurrency) {
  return rows.map((r) => {
    const raw = Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""]));
    try {
      const date = parseDateWith(raw[mapping.date_col], mapping.date_format);
      if (!date) return { raw, status: "failed", reason: "date unreadable" };
      const explicitCurrency = mapping.currency_col ? String(raw[mapping.currency_col] ?? '').trim().toUpperCase() : '';
      const cur = explicitCurrency || accountCurrency;
      if (!CURRENCIES.includes(cur)) return { raw, status: 'failed', reason: `Currency ${cur} is not supported. Fix the file or currency mapping.` };
      let kind, m;
      if (mapping.amount_col) { const v = parseMoney(raw[mapping.amount_col], cur); if (!v) return { raw, status: "failed", reason: "amount unreadable" }; const negIsExpense = mapping.negative_means === "expense"; kind = v.amount < 0 ? (negIsExpense ? "expense" : "income") : (negIsExpense ? "income" : "expense"); m = money(Math.abs(v.amount), cur); }
      else { const dr = parseMoney(raw[mapping.debit_col], cur), cr = parseMoney(raw[mapping.credit_col], cur); if (dr && dr.amount !== 0) { kind = "expense"; m = money(Math.abs(dr.amount), cur); } else if (cr && cr.amount !== 0) { kind = "income"; m = money(Math.abs(cr.amount), cur); } else return { raw, status: "failed", reason: "no amount" }; }
      if (m.amount === 0) return { raw, status: "failed", reason: "amount is zero" };
      if (date > today()) return { raw, status: "failed", reason: "future date" };
      return { raw, status: "ready", parsed: { kind, money: m, date, merchant: raw[mapping.description_col] || null, bank_ref: (mapping.reference_col && String(raw[mapping.reference_col] || "").trim()) || null } };
    } catch (e) { return { raw, status: "failed", reason: e.message }; }
  });
}

// ---------- recurring ----------
export const rules = (owner) => store.all("recurring_rules").filter((r) => !r.archived_at && (!owner || r.owner === owner));
export function validateRule({ template, schedule }) {
  const fields = {};
  if (!['income', 'expense'].includes(template?.kind)) fields.kind = 'Choose income or expense.';
  if (!isMoney(template?.money) || !Number.isSafeInteger(template.money.amount) || template.money.amount <= 0) fields.amount = 'Amount required and must be above zero.';
  if (typeof template?.money?.currency === 'string' && !CURRENCIES.includes(template.money.currency)) fields.currency = 'Choose a supported currency.';
  if (!A.get(template?.account_id)) fields.account_id = 'Pick an account.';
  if (template?.category_id) {
    const category = C.get(template.category_id);
    if (!category || category.kind !== template.kind) fields.category_id = 'Choose a category for this kind of transaction.';
  }
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(schedule?.freq)) fields.freq = 'Choose a supported schedule.';
  const interval = schedule?.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) fields.interval = 'Enter a whole number of 1 or more.';
  for (const name of ['start', 'end']) {
    const date = schedule?.[name];
    if (name === 'end' && !date) continue;
    if (!date) { fields[name] = 'First date required.'; continue; }
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fields[name] = 'Choose a valid calendar date.';
  }
  if (Object.keys(fields).length) throw new ValidationError({ fields });
}
export function createRule({ owner = "transaction", name, template, schedule }) {
  if (template?.kind === "income") template = { ...template, merchant: null };
  validateRule({ template, schedule });
  const row = store.insert("recurring_rules", { owner, name: name || template.merchant || "Recurring", template, schedule: { interval: 1, ...schedule }, last_posted_on: null, paused_at: null, paused_reason: null, skipped_dates: [], archived_at: null });
  return row;
}
export function updateRule(id, patch) {
  const rule = store.get('recurring_rules', id);
  if (!rule) throw new Error('Rule not found.');
  if (patch.template || patch.schedule) validateRule({ ...rule, ...patch });
  return store.update('recurring_rules', id, patch);
}
function scheduledDate(rule, k) {
  const s = rule.schedule;
  if (s.freq === "monthly") return D.addMonths(s.start, k * s.interval, s.anchor || D.parse(s.start).d);
  if (s.freq === "yearly") return D.addMonths(s.start, 12 * k * s.interval, D.parse(s.start).d);
  if (s.freq === "weekly") return D.addDays(s.start, 7 * k * s.interval);
  return D.addDays(s.start, k * s.interval);
}
function occurrenceIndex(rule, date) {
  const s = rule.schedule, start = D.parse(s.start), target = D.parse(date);
  if (!start || !target || date <= s.start) return 0;
  const stepMonths = s.freq === "yearly" ? 12 * s.interval : s.freq === "monthly" ? s.interval : 0;
  let k;
  if (stepMonths) k = Math.max(0, Math.floor(((target.y - start.y) * 12 + target.m - start.m) / stepMonths));
  else {
    const days = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${s.start}T00:00:00Z`)) / 86400000);
    k = Math.max(0, Math.floor(days / ((s.freq === "weekly" ? 7 : 1) * s.interval)));
  }
  while (k > 0 && scheduledDate(rule, k) >= date) k--;
  while (k < 100000000 && scheduledDate(rule, k) < date) k++;
  return k;
}
// ignorePosted: every scheduled date in range, posted or not. Budgets need this for expected income.
export function dueDates(rule, upTo, { limit = 500, from = null, ignorePosted = false, offset = 0 } = {}) {
  const s = rule.schedule, out = [];
  const after = ignorePosted ? null : rule.last_posted_on;
  const first = Math.max(offset, from ? occurrenceIndex(rule, from) : 0, after ? occurrenceIndex(rule, D.addDays(after, 1)) : 0);
  for (let k = first; k < first + limit; k++) {
    const d = scheduledDate(rule, k);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > "9999-12-31") break;
    if (d > upTo || (s.end && d > s.end)) break;
    if (from && d < from) continue;
    if ((rule.skipped_dates || []).includes(d)) continue;
    out.push(d);
  }
  return out;
}
export function allDueDates(rule, upTo, { from = null, ignorePosted = false } = {}) {
  const dates = [];
  let offset = Math.max(from ? occurrenceIndex(rule, from) : 0, !ignorePosted && rule.last_posted_on ? occurrenceIndex(rule, D.addDays(rule.last_posted_on, 1)) : 0);
  while (true) {
    const next = scheduledDate(rule, offset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > upTo || (rule.schedule.end && next > rule.schedule.end)) break;
    const page = dueDates(rule, upTo, { limit: 500, from, ignorePosted, offset });
    dates.push(...page);
    offset += 500;
  }
  return dates;
}
export const nextDue = (rule) => {
  const start = rule.last_posted_on && rule.last_posted_on >= today() ? D.addDays(rule.last_posted_on, 1) : today();
  let offset = occurrenceIndex(rule, start);
  while (true) {
    const scheduled = scheduledDate(rule, offset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled) || scheduled > "9999-12-31" || (rule.schedule.end && scheduled > rule.schedule.end)) return null;
    const date = dueDates(rule, "9999-12-31", { limit: 1, from: start, offset })[0];
    if (date) return date;
    offset++;
  }
};
export function upcoming(from, to) {
  return rules().filter((r) => !r.paused_at && r.template.kind === "expense").flatMap((r) => allDueDates(r, to, {from}).map((date) => ({ rule: r, date, money: r.template.money })));
}
// Subscriptions: every regular payment the person signed up for, priced per month and per year.
// Loan repayments and insurance premiums have their own screens, and Housing is where you live rather
// than something you subscribe to, so those are left out. Paused rules are not charging, so they are
// out too. Code only: nothing is labelled, guessed or stored.
const PER_MONTH = { daily: 365 / 12, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
export const perMonthFactor = (rule) => (PER_MONTH[rule.schedule.freq] ?? 1) / (rule.schedule.interval || 1);
export function subscriptions() {
  const premiums = new Set(store.all("policies").map((p) => p.recurring_rule_id).filter(Boolean));
  const priced = (m, f) => { const c = fx.toBase(m, base()); return { perMonth: c.money ? money(Math.round(c.money.amount * f), base()) : null, perYear: c.money ? money(Math.round(c.money.amount * f * 12), base()) : null, reason: c.reason || null }; };
  const fromRules = rules("transaction")
    .filter((r) => r.template.kind === "expense" && !r.paused_at && !premiums.has(r.id) && C.groupOf(C.get(r.template.category_id))?.name !== "Housing")
    .map((r) => ({ id: r.id, rule: r, found: false, name: r.template.merchant || r.name, money: r.template.money, ...priced(r.template.money, perMonthFactor(r)) }));
  // Charges noticed in the records but never set up: listed too, marked, so a forgotten one is seen.
  const found = detectRecurring()
    .filter((c) => c.subscription_like && C.groupOf(C.get(c.category_id))?.name !== "Housing")
    .map((c) => ({ id: `found:${c.key}`, candidate: c, found: true, name: c.merchant, money: c.money, since: c.first, ...priced(c.money, perMonthFactor({ schedule: c.schedule })) }));
  return [...fromRules, ...found].sort((a, b) => (b.perYear?.amount ?? -1) - (a.perYear?.amount ?? -1));
}
export function subscriptionTotals(list = subscriptions()) {
  const priced = list.filter((x) => x.perMonth);
  return { count: list.length, perMonth: money(priced.reduce((t, x) => t + x.perMonth.amount, 0), base()), perYear: money(priced.reduce((t, x) => t + x.perYear.amount, 0), base()), unpriced: list.length - priced.length };
}
// ---------- recurring detection ----------
// A charge the user never set up as recurring, noticed in their records: the same merchant, an amount
// within 5%, three times or more, at a regular gap, and still going. Code only. Nothing becomes a rule
// until the user says so, and "Not recurring" means that merchant at that price is never offered again.
// Income carries no merchant, so detection is for spending. Only a steady rhythm counts: anything
// bought more often than weekly, or at uneven gaps, never forms a run, whatever it is.
const PERIODS = [
  { freq: "weekly", interval: 1, days: 7, tol: 2, label: "every week" },
  { freq: "weekly", interval: 2, days: 14, tol: 3, label: "every two weeks" },
  { freq: "monthly", interval: 1, days: 30.44, tol: 5, label: "every month" },
  { freq: "monthly", interval: 3, days: 91.3, tol: 10, label: "every three months" },
  { freq: "yearly", interval: 1, days: 365.25, tol: 15, label: "every year" },
];
const within5 = (a, b) => Math.abs(a - b) <= 0.05 * Math.max(a, b);
const nextAfter = (date, p) => (p.freq === "weekly" ? D.addDays(date, 7 * p.interval) : D.addMonths(date, p.freq === "yearly" ? 12 : p.interval));
export function detectRecurring() {
  const t = today();
  const covered = new Set(rules().filter((r) => r.template.kind === "expense" && r.template.merchant).map((r) => merchantKey(r.template.merchant)));
  const ignores = store.all("recurring_ignores");
  const byMerchant = {};
  for (const x of live()) if (x.kind === "expense" && x.merchant && !x.recurring_rule_id) (byMerchant[merchantKey(x.merchant)] ||= []).push(x);
  const out = [];
  for (const [key, txs] of Object.entries(byMerchant)) {
    if (!key || covered.has(key) || txs.length < 3) continue;
    // One merchant can sell two things at two prices, so charges are grouped by price first.
    const groups = [];
    for (const x of txs.sort((a, b) => a.date.localeCompare(b.date))) {
      const g = groups.find((g) => g.currency === x.money.currency && within5(g.ref, x.money.amount));
      if (g) g.txs.push(x); else groups.push({ ref: x.money.amount, currency: x.money.currency, txs: [x] });
    }
    for (const g of groups) {
      const days = []; for (const x of g.txs) if (!days.length || days[days.length - 1].date !== x.date) days.push(x);
      if (days.length < 3) continue;
      const last = days[days.length - 1];
      if (ignores.some((i) => i.key === key && i.currency === g.currency && within5(i.amount, last.money.amount))) continue;
      for (const p of PERIODS) {
        // The unbroken run of regular gaps that ends at the latest charge.
        const run = [last];
        for (let i = days.length - 2; i >= 0; i--) { if (Math.abs(D.daysBetween(days[i].date, run[0].date) - p.days) <= p.tol) run.unshift(days[i]); else break; }
        if (run.length < 3) continue;
        if (D.daysBetween(last.date, t) > p.days + 2 * p.tol) break; // it has stopped
        out.push({ key: `${key}|${g.currency}|${last.money.amount}`, merchant: last.merchant, money: last.money, account_id: last.account_id, category_id: last.category_id,
          schedule: { freq: p.freq, interval: p.interval }, label: p.label, count: run.length, first: run[0].date, last: last.date, next: nextAfter(last.date, p), tx_ids: run.map((x) => x.id),
          // Monthly, quarterly and yearly is how subscriptions bill. A same-price weekly purchase is as
          // likely a habit (Friday lunch) as a commitment (a cleaner): still asked, never assumed.
          subscription_like: p.freq !== "weekly" });
        break;
      }
    }
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}
// On app open: one alert per charge noticed, asking. An alert whose charge is no longer noticed
// (set up by hand since, or stopped) is put away.
export function checkRecurring() {
  const cands = detectRecurring(), keys = new Set(cands.map((c) => `recurring_candidate:${c.key}`));
  for (const c of cands) AL.fire({ type: "recurring_candidate", source: { feature: "transactions" }, dedupe_key: `recurring_candidate:${c.key}`, title: `We noticed ${c.merchant}: ${fmt(c.money)} ${c.label}`, body: `${c.count} times since ${D.fmtDate(c.first)}. Make it a recurring transaction?`, payload: { key: c.key } });
  for (const a of store.all("alerts").filter((a) => a.type === "recurring_candidate" && !a.dismissed_at && !keys.has(a.dedupe_key))) AL.dismiss(a.id);
  return cands;
}
const closeCandidateAlert = (c) => { const a = store.all("alerts").find((x) => x.dedupe_key === `recurring_candidate:${c.key}`); if (a && !a.dismissed_at) AL.dismiss(a.id); };
// "Make it recurring": the normal rule form, prefilled. Once the rule exists, the charges already on
// record become its past instances, so nothing is posted twice.
export function linkCandidate(c, rule) {
  for (const id of c.tx_ids) store.update("transactions", id, { recurring_rule_id: rule.id });
  if (rule.schedule.start <= c.last) updateRule(rule.id, { last_posted_on: c.last });
  closeCandidateAlert(c);
}
export function acceptCandidate(c) {
  ruleModal({ name: c.merchant, template: { kind: "expense", account_id: c.account_id, money: c.money, category_id: c.category_id, merchant: c.merchant }, schedule: { freq: c.schedule.freq, interval: c.schedule.interval, start: c.last } }, null, { onCreated: (rule) => linkCandidate(c, rule) });
}
export function ignoreCandidate(c) {
  const [key, currency] = c.key.split("|");
  store.insert("recurring_ignores", { key, currency, amount: c.money.amount, merchant: c.merchant });
  closeCandidateAlert(c);
}
export function postDue() {
  const posted = [];
  for (const r of rules()) {
    if (r.paused_at) continue;
    if (!A.get(r.template.account_id)) { updateRule(r.id, { paused_at: nowIso(), paused_reason: "account_archived" }); AL.fire({ type: "system", severity: "warn", source: { feature: "transactions", entity_id: r.id }, dedupe_key: `rule_paused:${r.id}`, title: `Rule "${r.name}" paused`, body: "Its account is archived. Resume it with a new account." }); continue; }
    for (const date of dueDates(r, today())) {
      const t = r.template;
      const snap = fx.snapshotAt(t.money, base(), date, today());
      const row = store.insert("transactions", { kind: t.kind, account_id: t.account_id, counter_account_id: null, counter_money: null, money: t.money, base_money: snap.base_money, fx: snap.fx, date, category_id: t.category_id || null, merchant: t.merchant || null, note: t.note || null, source: "recurring", recurring_rule_id: r.id, confirmed_at: nowIso(), dedupe_hash: `${date}|${t.money.amount}|${merchantKey(t.merchant)}|${t.account_id}`, voided_at: null, void_reason: null });
      updateRule(r.id, { last_posted_on: date });
      posted.push({ rule: r, tx: row });
      bus.emit("recurring_posted", { rule: r, tx: row });
    }
    if (r.schedule.end && r.schedule.end < today()) updateRule(r.id, { archived_at: nowIso() });
  }
  if (posted.length) {
    AL.fire({ type: "recurring_posted", source: { feature: "transactions" }, dedupe_key: `recurring_posted:${today()}:${posted.map((p) => p.tx.id).join(",").slice(0, 40)}`, title: `${posted.length} recurring item${posted.length > 1 ? "s" : ""} posted`, body: postedSummary(posted) });
    bus.emit("write", { table: "transactions" });
  }
  return posted;
}
// One line per rule, not one per posting: after a long gap a monthly rule can post two dozen times.
function postedSummary(posted) {
  const by = new Map();
  for (const p of posted) { const e = by.get(p.rule.id) || { name: p.rule.name, n: 0, money: p.tx.money }; e.n++; by.set(p.rule.id, e); }
  const parts = [...by.values()].map((e) => (e.n > 1 ? `${e.name} ×${e.n}` : `${e.name} ${fmt(e.money)}`));
  const dates = posted.map((p) => p.tx.date).sort();
  const span = dates[0] === dates.at(-1) ? `on ${D.fmtDate(dates[0])}` : `from ${D.fmtDate(dates[0])} to ${D.fmtDate(dates.at(-1))}`;
  return `${parts.slice(0, 4).join(" · ")}${parts.length > 4 ? ` · and ${parts.length - 4} more` : ""}, ${span}`;
}
export function skipNext(id) { const r = store.get("recurring_rules", id); const n = nextDue(r); if (!n) return null; updateRule(id, { skipped_dates: [...(r.skipped_dates || []), n] }); return n; }
export const pauseRule = (id) => updateRule(id, { paused_at: nowIso(), paused_reason: "user" });
export function resumeRule(id, accountId) {
  const r = store.get("recurring_rules", id);
  const patch = { paused_at: null, paused_reason: null, last_posted_on: r.last_posted_on && r.last_posted_on < today() ? D.addDays(today(), -1) : r.last_posted_on };
  if (accountId) patch.template = { ...r.template, account_id: accountId };
  return updateRule(id, patch);
}

// ---------- pages ----------
const RECORDS_SIZE = 20;
let recordsView = null;
let recordsPendingFocus = null;
export function clearRecordsView() { recordsView = null; recordsPendingFocus = null; }
export function recordsPageSlice(matches, page, size = 20) {
  const sorted = [...matches].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.id || "").localeCompare(String(a.id || "")));
  const total = sorted.length, pages = Math.max(1, Math.ceil(total / size));
  page = Number.isInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  page = Math.min(page, pages);
  const first = total ? (page - 1) * size + 1 : 0, last = total ? Math.min(page * size, total) : 0;
  return { rows: sorted.slice(first ? first - 1 : 0, last), total, page, pages, first, last };
}
export function groupRecordPage(pageRows, matchingRows) {
  const days = new Map();
  for (const row of matchingRows) {
    if (row.kind === "transfer" || row.voided_at || row.deleted_at) continue;
    const day = row.date;
    if (!days.has(day)) days.set(day, { income: [], expense: [] });
    if (row.kind === "income" || row.kind === "expense") days.get(day)[row.kind].push(row);
  }
  return pageRows.map((row, index) => {
    const groups = days.get(row.date) || { income: [], expense: [] };
    const totals = {};
    for (const kind of ["income", "expense"]) {
      let result;
      try { result = baseTotals(groups[kind]); } catch { result = { total: null, missing: 0, reasons: [], partial: null }; }
      const safe = !!result.partial && Number.isSafeInteger(result.partial.amount);
      totals[kind] = { total: result.missing || !safe ? null : result.total, missing: result.missing, reasons: result.reasons, unsafe: !safe && !result.missing };
    }
    return { row, date: index === 0 || pageRows[index - 1].date !== row.date ? row.date : null, totals };
  });
}
const criteriaKeys = ["q", "kind", "account", "category", "from", "to", "source"];
function recordsCriteria(p) { return Object.fromEntries(criteriaKeys.filter((k) => p[k]).map((k) => [k, p[k]])); }
function recordsHash(criteria, page) { const qs = new URLSearchParams(criteria); if (page > 1) qs.set("page", page); return `#/transactions${qs.size ? `?${qs}` : ""}`; }
function recordsReturnHash() { return recordsView?.generation === store.generation() && /^#\/transactions(?:\?|$)/.test(recordsView.hash || "") ? recordsView.hash : "#/transactions"; }
function activeCriteria(criteria) {
  const active = criteriaKeys.filter((k) => criteria[k] && k !== "from" && k !== "to").map((k) => ({ key: k, label: k === "q" ? criteria.q : k === "kind" ? `${criteria.kind[0].toUpperCase()}${criteria.kind.slice(1)}` : k === "account" ? A.get(criteria.account)?.name || criteria.account : k === "category" ? C.labelId(criteria.category) : criteria.source }));
  if (criteria.from || criteria.to) active.push({ key: "dateRange", label: `${criteria.from || "…"} – ${criteria.to || "…"}` });
  return active;
}
export function transactionsPage(params, _reason = "navigate") {
  const p = Object.fromEntries(new URLSearchParams(params || ""));
  const criteria = recordsCriteria(p);
  const matches = search({ q: criteria.q || "", kind: criteria.kind || undefined, accountId: criteria.account || undefined, categoryId: criteria.category || undefined, from: criteria.from, to: criteria.to, source: criteria.source || undefined, showCancelled: true });
  const parsed = /^[0-9]+$/.test(p.page || "1") && Number(p.page || 1) > 0 ? Number(p.page || 1) : 1;
  const result = recordsPageSlice(matches, parsed, RECORDS_SIZE);
  const canonical = recordsHash(criteria, result.page);
  if (p.page !== (result.page === 1 ? undefined : String(result.page)) && (p.page !== undefined || result.page > 1)) history.replaceState(null, "", canonical);
  const groups = groupRecordPage(result.rows, matches);
  const filtered = Object.keys(criteria).length > 0;
  const active = activeCriteria(criteria);
  const totalLine = result.total ? `Records ${result.first}–${result.last} of ${result.total}` : "0 matching records";
  const dateHeading = (date) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric", day: "numeric" }); };
  const amountLine = (kind, value) => {
    if (value.unsafe) return `<span>${kind}: unavailable (sum is not safely representable)</span>`;
    if (value.missing) return `<span>${kind}: incomplete — ${esc(value.reasons.join("; "))}; <a href="#/settings">Update rate</a></span>`;
    return `<span>${kind}: ${fmt(value.total)}</span>`;
  };
  const rowsHtml = groups.map(({ row, date, totals }) => `${date ? `<section class="record-day"><h2>${esc(dateHeading(date))}</h2><p class="muted day-totals">${filtered ? "Filtered day totals · " : "Day totals · "}${amountLine("Matching income", totals.income)} · ${amountLine("Matching expenses", totals.expense)}</p></section>` : ""}${A.txRow(row)}`).join("");
  const pageLink = (n, label, disabled) => disabled ? `<span class="btn disabled" aria-disabled="true">${label}</span>` : `<a class="btn" href="${esc(recordsHash(criteria, n))}">${label}</a>`;
  const clear = () => { location.hash = "#/transactions"; };
  return {
    title: "Records",
    html: html`<h1 tabindex="-1" data-records-heading>Records</h1>
      <form data-form="search"><div class="search-line">${raw(field("Search merchant or note", inp("q", { value: criteria.q || "", placeholder: "e.g. Starbucks" }).replace("<input", '<input data-record-control="search"')))}<button class="primary" data-record-control="search-go">Go</button></div></form>
      <div class="active-conditions" aria-label="Active filters">${raw(active.map(({ key, label }) => `<button type="button" data-remove="${key}" data-record-control="condition:${key}">${esc(label)} ×</button>`).join(""))}${active.length ? '<button type="button" data-clear data-record-control="clear-all">Clear all</button>' : ""}</div>
      <details data-filters ${recordsView?.hash === canonical && recordsView.filtersOpen ? "open" : ""}><summary data-record-control="filters-toggle">Filters</summary><form data-form="filters"><div class="filter-grid">
        ${raw(field("Kind", sel("kind", [["", "All kinds"], ["expense", "Expense"], ["income", "Income"], ["transfer", "Transfer"]], criteria.kind || "", (x) => x[1], (x) => x[0]).replace("<select", '<select data-record-control="filter-kind"')))}
        ${raw(field("Account", sel("account", [{ id: "", name: "All accounts" }, ...A.list(true)], criteria.account || "", (a) => a.name, (a) => a.id).replace("<select", '<select data-record-control="filter-account"')))}
        ${raw(field("Category", sel("category", [{ id: "", n: "All categories" }, ...C.list().map((c) => ({ id: c.id, n: C.label(c) }))], criteria.category || "", (c) => c.n, (c) => c.id).replace("<select", '<select data-record-control="filter-category"')))}
        ${raw(field("Entered by", sel("source", ["", ...SOURCES], criteria.source || "", (s) => (s ? s[0].toUpperCase() + s.slice(1) : "Any way")).replace("<select", '<select data-record-control="filter-source"')))}
        <fieldset class="date-range"><legend>Date range</legend><div class="inline">${raw(field("From", inp("from", { type: "date", value: criteria.from || "" }).replace("<input", '<input data-record-control="filter-from"')))}${raw(field("To", inp("to", { type: "date", value: criteria.to || "" }).replace("<input", '<input data-record-control="filter-to"')))}</div></fieldset>
      </div><button data-record-control="filter-apply">Apply filters</button></form></details>
      <p data-record-count>${totalLine}</p><nav aria-label="Records pages">${raw(pageLink(result.page - 1, "Newer", result.page <= 1))} ${result.total ? `${result.page} of ${result.pages}` : ""} ${raw(pageLink(result.page + 1, "Older", result.page >= result.pages))}</nav>
      <div class="records-list">${result.total ? raw(rowsHtml) : raw('<p class="empty">No transactions match.</p>')}</div>
      <nav aria-label="Records pages">${raw(pageLink(result.page - 1, "Newer", result.page <= 1))} ${result.total ? `${result.page} of ${result.pages}` : ""} ${raw(pageLink(result.page + 1, "Older", result.page >= result.pages))}</nav>`,
    bind(root, { reason: _bindReason } = {}) {
      const capture = (preferredRow = null) => {
        if (!root.isConnected) return;
        const rows = [...root.querySelectorAll("[data-tx]")].filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight; });
        const anchor = preferredRow || rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top))[0] || null;
        const control = preferredRow || document.activeElement?.closest?.("[data-record-control]");
        recordsView = { hash: canonical, scrollY: window.scrollY, anchorRecordId: anchor?.dataset.tx || null, anchorOffset: anchor?.getBoundingClientRect().top || 0, focusedControlKey: control?.dataset.recordControl || null, filtersOpen: root.querySelector("[data-filters]")?.open || false, generation: store.generation() };
      };
      root.addEventListener("click", (event) => { const target = event.target.closest("[data-tx]"); if (target) capture(target); });
      root.querySelector("[data-filters]").addEventListener("toggle", (event) => { recordsView = { ...(recordsView || {}), hash: canonical, filtersOpen: event.target.open, generation: store.generation() }; });
      const submit = (form) => { const data = new FormData(form), next = { ...criteria, ...Object.fromEntries([...data].filter(([, v]) => v)) }; for (const key of criteriaKeys) if (data.has(key) && !data.get(key)) delete next[key]; location.hash = recordsHash(next, 1); };
      root.querySelector("[data-form=search]").onsubmit = (e) => { e.preventDefault(); submit(e.currentTarget); };
      root.querySelector("[data-form=filters]").onsubmit = (e) => { e.preventDefault(); submit(e.currentTarget); };
      root.querySelectorAll("[data-form=filters] select").forEach((select) => select.addEventListener("change", () => submit(select.form)));
      root.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
        const next = { ...criteria }, removed = button.dataset.remove;
        if (removed === "dateRange") { delete next.from; delete next.to; } else delete next[removed];
        const nextConditions = activeCriteria(next), focusKey = nextConditions.length ? `condition:${nextConditions[0].key}` : "search";
        const nextHash = recordsHash(next, 1);
        recordsPendingFocus = { key: focusKey, hash: nextHash, generation: store.generation() };
        location.hash = nextHash;
      }));
      root.querySelector("[data-clear]")?.addEventListener("click", clear);
      return () => capture();
    },
    afterBind(root, { reason: afterReason } = {}) {
      if (recordsPendingFocus && recordsPendingFocus.hash === canonical && recordsPendingFocus.generation === store.generation()) {
        const target = root.querySelector(`[data-record-control="${CSS.escape(recordsPendingFocus.key)}"]`);
        recordsPendingFocus = null;
        if (target) { target.focus({ preventScroll: true }); return true; }
      }
      if (afterReason === "redraw") return false;
      if (recordsView?.hash !== canonical || recordsView.generation !== store.generation()) return false;
      const row = recordsView.anchorRecordId && root.querySelector(`[data-tx="${CSS.escape(recordsView.anchorRecordId)}"]`);
      if (row) window.scrollTo(0, Math.max(0, window.scrollY + row.getBoundingClientRect().top - recordsView.anchorOffset));
      else window.scrollTo(0, recordsView.scrollY || 0);
      if (recordsView.focusedControlKey) root.querySelector(`[data-record-control="${CSS.escape(recordsView.focusedControlKey)}"]`)?.focus({ preventScroll: true });
      return true;
    },
  };
}

export function transactionDetailPage(id) {
  const t = get(id);
  if (!t) return { title: "Transaction", html: "<div class='empty'>Not found</div>", bind() {} };
  const rule = t.recurring_rule_id ? store.get("recurring_rules", t.recurring_rule_id) : null;
  const cancelLabel = t.kind === "expense" ? "Cancel charge" : "Cancel transaction";
  const rows = [["Kind", cap(t.kind)], ["Account", A.get(t.account_id)?.name], t.kind === "transfer" ? ["To", A.get(t.counter_account_id)?.name] : null,
    t.entered_money ? ["Paid", `${fmt(t.entered_money)} at ${t.entered_fx?.rate} (${t.entered_fx?.source}, frozen when you confirmed)`] : null,
    [t.entered_money ? "Off the account" : "Amount", fmt(t.money)], t.kind === "transfer" && t.counter_money ? ["Received", fmt(t.counter_money)] : null,
    t.money.currency !== base() ? ["In " + base(), t.base_money?.currency === base() ? `${fmt(t.base_money)} (rate ${t.fx?.rate}, frozen when saved)` : `— (${fx.missingRateReason(t.money.currency, base(), t.date)}; saved conversion absent)`] : null,
    ["Date", D.fmtDate(t.date)], t.kind !== "transfer" ? ["Category", C.labelId(t.category_id)] : null, ["Merchant", t.merchant || "—"], ["Note", t.note || "—"], ["Source", cap(t.source)], rule ? ["Rule", rule.name] : null, t.voided_at ? ["Cancelled", `${t.void_reason} · ${t.voided_at.slice(0, 10)}`] : null].filter(Boolean);
  return {
    title: t.kind === "transfer" ? "Transfer" : t.merchant || t.kind,
    html: html`<div class="card ${t.voided_at ? "void" : ""}"><table>${raw(rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join(""))}</table>${t.money.currency !== base() && t.base_money?.currency !== base() ? raw(`<p class="hint">Update the rate, then edit and confirm this record to add its conversion. Nothing already saved changes on its own.</p>${rateLink(t.money.currency, base(), t.date)}`) : ""}</div>
      <div class="actions">${t.kind !== "transfer" && !t.voided_at ? raw(`<button data-action="edit">Edit</button><button data-action="recur">Make recurring</button><button data-action="cancel">${cancelLabel}</button>`) : ""}${t.voided_at ? raw('<button data-action="restore">Restore</button>') : ""}<button class="danger" data-action="delete">Delete</button></div>
      <p class="muted">${cancelLabel} keeps the record in the list, struck through and out of every total; you can restore it. Use it for a refund or a transaction that never happened. It does not contact your bank or move money. Delete is for a record made by mistake.</p>`,
    bind(root) {
      const runAction = (button, mutate) => async () => {
        if (button.dataset.saving === "true") return;
        button.dataset.saving = "true"; button.disabled = true;
        try { await commitAction(mutate); } catch {}
        finally { delete button.dataset.saving; if (button.isConnected) button.disabled = false; }
      };
      root.querySelector("[data-action=edit]")?.addEventListener("click", () => confirmModal({ ...t }, { title: "Edit transaction", existing: t }));
      root.querySelector("[data-action=cancel]")?.addEventListener("click", () => modal({ title: t.kind === "expense" ? "Cancel this charge?" : "Cancel this transaction?", body: field("Reason", sel("reason", ["refund", "error", "cancelled"])) + "<p class='hint'>Kept forever, struck through, excluded from totals and balances. Reversible. This only updates your Hodos record; it does not cancel a bank payment or request a refund.</p>", submitLabel: cancelLabel, danger: true, onSubmit: (f) => { cancel(t.id, f.get("reason")); toast("Cancelled"); } }));
      const restoreButton = root.querySelector("[data-action=restore]");
      restoreButton?.addEventListener("click", runAction(restoreButton, () => { restore(t.id); toast("Restored"); }));
      root.querySelector("[data-action=delete]").onclick = () => modal({ title: "Delete?", body: `<p>Hidden for good. Use ${cancelLabel} for refunds.</p>`, submitLabel: "Delete", danger: true, onSubmit: () => { remove(t.id); }, onSuccess: () => { location.hash = recordsReturnHash(); } });
      root.querySelector("[data-action=recur]")?.addEventListener("click", () => ruleModal({ template: { kind: t.kind, account_id: t.account_id, money: t.money, category_id: t.category_id, merchant: t.merchant, note: t.note }, name: t.merchant }));
    },
  };
}

export function ruleModal(preset = {}, existing = null, { onCreated, onDone, beforeCommit } = {}) {
  const accts = A.active(); if (!accts.length) return toast("Create an account first.");
  const t = { kind: "expense", account_id: accts[0].id, ...(preset.template || {}) };
  const s = { freq: "monthly", interval: 1, start: today(), anchor: D.parse(today()).d, ...(preset.schedule || {}) };
  const cats = (kind, selected) => sel("category_id", [{ id: "", n: "— pick a category" }, ...C.list(kind).map((c) => ({ id: c.id, n: C.label(c) }))], selected || "", (c) => c.n, (c) => c.id);
  const m = modal({ title: existing ? "Edit rule (future instances only)" : "New recurring rule", submitLabel: existing ? "Save" : "Create rule",
    body: field("Name", inp("name", { value: preset.name || "", placeholder: "e.g. Rent" })) + `<div class="inline">${field("Kind", sel("kind", ["expense", "income"], t.kind))}${field("Account", sel("account_id", accts, t.account_id, (a) => `${a.name} (${a.currency})`, (a) => a.id))}</div>
      <div class="inline">${field("Amount", moneyInput("amount", t.money ? toDecimalString(t.money) : ""))}<div data-merchant-wrap style="flex:1">${field("Merchant", inp("merchant", { value: t.merchant || "" }), "Expenses only.")}</div></div>
      <label data-category-label>Category</label><div data-cat-wrap>${cats(t.kind, t.category_id)}</div>
      <div class="inline">${field("Every", sel("freq", ["daily", "weekly", "monthly", "yearly"], s.freq))}${field("Interval", inp("interval", { type: "number", value: s.interval, min: 1 }))}</div>
      <div class="inline">${field("First date", inp("start", { type: "date", value: s.start }), "Day of month or weekday is taken from this date. Short month → last day.")}${field("End (optional)", inp("end", { type: "date", value: s.end || "" }))}</div>
      ${field("Note", inp("note", { value: t.note || "" }))}<p class="hint">Posts itself on schedule when you open the app, with catch-up for missed dates. This is the one write that skips confirm.</p>`,
    onSuccess: onDone,
    onSubmit: (f) => {
      beforeCommit?.();
      const acct = A.get(f.get("account_id"));
      const kind = f.get("kind");
      const template = { kind, account_id: acct.id, money: parseMoney(f.get("amount"), acct.currency), category_id: f.get("category_id") || null, merchant: kind === "income" ? null : f.get("merchant") || null, note: f.get("note") || null };
      const start = f.get("start");
      const schedule = { freq: f.get("freq"), interval: Number(f.get("interval")), start, end: f.get("end") || null, anchor: f.get("freq") === "weekly" ? D.weekday(start) : D.parse(start).d };
      const rule = existing ? updateRule(existing.id, { name: f.get("name") || template.merchant || "Recurring", template, schedule }) : createRule({ name: f.get("name"), template, schedule });
      if (!existing) { onCreated?.(rule); postDue(); }
      toast(existing ? "Rule updated" : "Rule created");
      return rule;
    } });
  bindValidation(m.form, {
    dependencies: { kind: ['category_id'], account_id: ['amount'] },
    validate(values) {
      const account = A.get(values.get('account_id'));
      const template = { kind: values.get('kind'), account_id: values.get('account_id'), money: parseMoney(values.get('amount'), account?.currency), category_id: values.get('category_id') || null };
      const intervalText = String(values.get('interval') || '').trim();
      const schedule = { freq: values.get('freq'), interval: intervalText ? Number(intervalText) : NaN, start: values.get('start'), end: values.get('end') || null };
      try { validateRule({ template, schedule }); return {}; }
      catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        if (error.fields.currency) { error.fields.account_id = error.fields.currency; delete error.fields.currency; }
        return error;
      }
    },
  });
  m.form.querySelector('[data-category-label]').htmlFor = m.form.elements.category_id.id;
  const mw = m.form.querySelector("[data-merchant-wrap]"), cw = m.form.querySelector("[data-cat-wrap]");
  const applyKind = () => { const income = m.form.kind.value === "income"; mw.hidden = income; if (income) m.form.merchant.value = ""; resetCategorySelect(cw, m.form.kind.value); };
  m.form.kind.onchange = applyKind;
  if (t.kind === "income") { mw.hidden = true; m.form.merchant.value = ""; }
}

export function recurringPage() {
  const list = rules("transaction").concat(rules("debt")).sort((a, b) => (nextDue(a) || "9").localeCompare(nextDue(b) || "9"));
  const subs = subscriptions(), st = subscriptionTotals(subs), cands = detectRecurring();
  const noticed = cands.length ? `<div class="card"><h2>We noticed</h2>${cands.map((c, i) => `<div class="row"><div class="grow"><div class="title">${esc(c.merchant)}</div><div class="sub">${fmt(c.money)} ${c.label} · ${c.count} times since ${D.fmtDate(c.first)}, last on ${D.fmtDateShort(c.last)}</div>
      <div class="actions"><button class="small primary" data-accept="${i}">Make it recurring</button><button class="small" data-ignore="${i}">Not recurring</button></div></div></div>`).join("")}
      <p class="muted">Found in your records: the same amount at the same place, again and again. Nothing is set up until you say so.</p></div>` : "";
  const subsCard = subs.length ? `<div class="card"><h2>Subscriptions</h2>
      <div class="goal-nums"><span class="goal-now">${fmt(st.perYear)}</span><span class="goal-of">a year · ${fmt(st.perMonth)} a month · ${st.count} subscription${st.count === 1 ? "" : "s"}</span></div>
      <table><tr><th>What</th><th class="num">A month</th><th class="num">A year</th></tr>${subs.map((x) => `<tr><td>${esc(x.name)}${x.found ? ' <span class="tag warn">not set up</span>' : ""}</td><td class="num">${x.perMonth ? fmt(x.perMonth) : "—"}</td><td class="num">${x.perYear ? fmt(x.perYear) : `— <small>(${esc(x.reason)})</small>`}</td></tr>`).join("")}</table>
      <p class="muted">Every regular payment, dearest first: the ones you set up, and any the app noticed that you have not. Loans, insurance and housing are left out; they have their own screens. Anything you no longer use is one cancellation away.</p></div>` : "";
  return {
    title: "Recurring",
    html: html`<div class="actions"><button class="primary" data-action="new">＋ Rule</button><button data-action="post">Post due now</button></div>
      ${raw(noticed)}${raw(subsCard)}
      <div class="card">${list.length ? raw(list.map((r) => `<div class="row"><div class="grow"><div class="title">${esc(r.name)}${r.paused_at ? `<span class="tag warn">paused${r.paused_reason === "account_archived" ? " · account archived" : ""}</span>` : ""}${r.owner === "debt" ? '<span class="tag">debt</span>' : ""}</div>
        <div class="sub">${r.template.kind} · ${A.get(r.template.account_id)?.name || "account missing"} · ${C.labelId(r.template.category_id)} · every ${r.schedule.interval > 1 ? r.schedule.interval + " " : ""}${r.schedule.freq.replace("ly", "")}${r.schedule.interval > 1 ? "s" : ""} · next ${r.paused_at ? "—" : D.fmtDate(nextDue(r))}${r.last_posted_on ? " · last " + D.fmtDateShort(r.last_posted_on) : ""}</div>
        <div class="actions"><button class="small" data-edit="${r.id}">Edit</button>${r.paused_at ? `<button class="small" data-resume="${r.id}">Resume</button>` : `<button class="small" data-skip="${r.id}">Skip next</button><button class="small" data-pause="${r.id}">Pause</button>`}<button class="small danger" data-archive="${r.id}">Archive</button></div></div>
        <div class="amt">${fmt(r.template.money)}</div></div>`).join("")) : raw('<div class="empty">No rules. Rent, salary, subscriptions and loan repayments live here.</div>')}</div>`,
    bind(root) {
      const runAction = (button, mutate) => async () => {
        if (button.dataset.saving === "true") return;
        button.dataset.saving = "true"; button.disabled = true;
        try { await commitAction(mutate); } catch {}
        finally { delete button.dataset.saving; if (button.isConnected) button.disabled = false; }
      };
      root.querySelector("[data-action=new]").onclick = () => ruleModal();
      root.querySelectorAll("[data-accept]").forEach((b) => (b.onclick = () => acceptCandidate(cands[Number(b.dataset.accept)])));
      root.querySelectorAll("[data-ignore]").forEach((b) => (b.onclick = runAction(b, () => { ignoreCandidate(cands[Number(b.dataset.ignore)]); toast("Not recurring. It will not be offered again."); })));
      const postButton = root.querySelector("[data-action=post]");
      postButton.onclick = runAction(postButton, () => { const p = postDue(); toast(p.length ? `${p.length} posted` : "Nothing due"); });
      root.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { const r = store.get("recurring_rules", b.dataset.edit); ruleModal({ name: r.name, template: r.template, schedule: r.schedule }, r); }));
      root.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = runAction(b, () => { const d = skipNext(b.dataset.skip); toast(d ? `Skipped ${d}` : "Nothing to skip"); })));
      root.querySelectorAll("[data-pause]").forEach((b) => (b.onclick = runAction(b, () => { pauseRule(b.dataset.pause); toast("Paused"); })));
      root.querySelectorAll("[data-resume]").forEach((b) => (b.onclick = () => { const r = store.get("recurring_rules", b.dataset.resume); modal({ title: "Resume rule", body: field("Account", sel("account", A.active(), A.get(r.template.account_id)?.id, (a) => a.name, (a) => a.id)) + "<p class='hint'>Posts from the next due date. Missed dates while paused are not back-filled.</p>", submitLabel: "Resume", onSubmit: (f) => { resumeRule(r.id, f.get("account")); postDue(); } }); }));
      root.querySelectorAll("[data-archive]").forEach((b) => (b.onclick = () => modal({ title: "Archive rule?", body: "<p>Stops posting. Past instances stay.</p>", submitLabel: "Archive", danger: true, onSubmit: () => updateRule(b.dataset.archive, { archived_at: nowIso() }) })));
    },
  };
}

// ---------- Add page (the doors) ----------
// One unfinished import owns its request, dialogs and reset; a new attempt never shares it.
let importWork = null;
let stagedUploadFiles = [], uploadContext = "", uploadAccount = null, uploadBatch = null;
export function startImport(form) {
  const submitControl = (host) => host?.querySelector('button[type="submit"]') || host?.querySelector('button.primary');
  const button = submitControl(form);
  if (!button) throw new Error("This upload form has no submit control. Reopen the page and try again.");
  importWork?.cancel();
  const buttonContent = [...button.childNodes].map((node) => node.cloneNode(true)), textButton = button.childElementCount === 0;
  const hash = location.hash;
  const revision = vault.accessRevision(), owner = vault.ownerId(), generation = store.generation(), profileId = store.one("profile")?.id;
  const operation = createOperation({ root: form, key: "transactions.import", ownerGeneration: generation });
  if (!operation.start("Reading…", "reading")) throw new Error("Another import is still active.");
  let cancelled = false;
  const ready = () => { const currentForm = work.form, currentButton = submitControl(currentForm); if (currentButton) { currentButton.disabled = false; currentButton.replaceChildren(...buttonContent.map((node) => node.cloneNode(true))); } currentForm?.removeAttribute("aria-busy"); currentForm?.querySelectorAll("input,select,textarea").forEach((el) => { el.disabled = false; }); operation.pause("Ready for the next step."); };
  const onPageHide = () => work.cancel("pagehide");
  const work = {
    form, operation, signal: operation.signal, dialog: null, committing: false,
    active: () => operation.active() && hash === location.hash && revision === vault.accessRevision() && owner === vault.ownerId() && generation === store.generation() && profileId === store.one("profile")?.id,
    check() { if (!this.active()) this.cancel("access or page changed"); this.signal.throwIfAborted(); },
    cancel(reason = "cancelled") { if (cancelled) return; cancelled = true; window.removeEventListener("pagehide", onPageHide); operation.dispose(reason); this.dialog?.close(); this.form.reset(); ready(); if (importWork === this) importWork = null; },
    ready,
    finish() { this.cancel("completed"); if (!this.deferCategoryPrompt) C.checkUnlock(); },
    // Hold confirmed import progress until the captured snapshot is durably stored; retries never rerun mutation.
    receipt: null,
    async commit(write, operationId, savingForm = null) {
      this.check();
      if (this.receipt && this.receipt.operationId !== operationId && this.receipt.state !== "durable") throw new Error("Retry the previous save before continuing.");
      if (this.receipt?.operationId !== operationId) this.receipt = null;
      if (this.receipt?.state === "durable") {
        if (this.operation.state === "failed") { this.operation.start("Resuming the confirmed import…", "preparing"); this.operation.pause("Save confirmed. Ready to continue."); }
        else this.operation.pause("Save confirmed.");
        return this.receipt;
      }
      if (this.operation.state === "failed") this.operation.start("Retrying this save…", "saving");
      else if (this.operation.state === "idle") this.operation.start("Saving confirmed changes…", "saving");
      else this.operation.progress("Saving confirmed changes…", "saving");
      this.committing = true;
      try {
        if (!this.receipt) this.receipt = store.captureAction(operationId, write);
        await commitFormAction(savingForm, operationId, null, this.receipt);
        if (this.receipt.state !== "durable") throw new Error("Device storage did not confirm this save.");
        const saved = this.receipt; this.receipt = null; this.operation.pause("Saved. Ready for the next step."); return saved;
      } catch (error) {
        if (this.receipt) this.operation.fail("Not saved.", "Use Retry saving to continue this import.");
        else this.operation.pause("Check the details and try again.");
        throw error;
      } finally { this.committing = false; }
    },
  };
  importWork = work;
  window.addEventListener("pagehide", onPageHide, { once: true });
  button.disabled = true; if (textButton) button.textContent = "Reading…"; form.setAttribute("aria-busy", "true");
  form.querySelectorAll("input,select,textarea").forEach((el) => { el.disabled = true; });
  return work;
}
function importModal(work, options) {
  if (!work) return modal(options);
  work.check();
  const m = modal({ ...options, onCancel: () => work.cancel(), onSubmit: async (f, form) => { work.check(); return await options.onSubmit?.(f, form); } });
  m.form.dataset.importWork = "";
  work.dialog = m;
  return m;
}
async function runFileUpload(form, values) {
  if (uploadBatch) return;
  const files = [...stagedUploadFiles], accountId = values.get("account"), message = String(values.get("context") || "");
  if (files.length !== 1) { toast("Choose exactly one file at a time."); return; }
  if (!A.active().some(a => a.id === accountId)) { toast("Choose files and an active account first."); return; }
  const generation = store.generation(), owner = vault.ownerId(), revision = vault.accessRevision(), hash = location.hash;
  const batch = {}; uploadBatch = batch;
  const current = () => uploadBatch === batch && generation === store.generation() && owner === vault.ownerId() && revision === vault.accessRevision() && hash === location.hash;
  let work = null, started = false, allDone = false;
  const controls = (host, disabled) => host?.querySelectorAll("input,select,textarea,button[type=submit]").forEach(el => { el.disabled = disabled; });
  controls(form, true);
  try {
    const needsAI = ai.enabled();
    if (!needsAI && files.some(file => !/\.csv$/i.test(file.name))) throw new Error("AI is off. CSV files can still be mapped by hand; other formats need AI enabled in Settings.");
    if (needsAI && !await confirm("Send files to AI?", "Selected files are sent as provided, including names and account details. They are not automatically anonymised. Nothing financial is saved until you review and confirm.")) return;
    if (!current()) return;
    const { prepareFiles } = await import("./assistant-files.js");
    for (const file of files) {
      if (!current() || needsAI && !ai.enabled()) break;
      const host = document.querySelector('form[data-door="upload"]');
      if (!host?.isConnected || !A.active().some(a => a.id === accountId)) break;
      host.elements.account.value = accountId; host.elements.context.value = message;
      work = startImport(host); started = true; work.stayOnAdd = true; work.deferCategoryPrompt = true;
      let completed = false, reviewOpened = false;
      const finish = work.finish.bind(work); work.finish = () => { completed = true; finish(); };
      const stopped = new Promise(resolve => work.signal.addEventListener("abort", resolve, { once: true }));
      const states = await prepareFiles([file], { accountId, message, today: today(), work, signal: work.signal, nativeCsv: true,
        callAI: needsAI ? ai.call : null,
        onDisclosure: () => { work.check(); if (needsAI && !ai.enabled()) throw new Error("AI permission changed. Nothing unconfirmed was saved."); },
        imageReader: image => fromImage(image, host.elements.hint.value, accountId, { signal: work.signal, message }),
        onDraft: async result => {
          work.check();
          if (result.kind === "csv") { reviewOpened = true; return; }
          if (result.kind === "image") { reviewOpened = true; photoChoice(result.photo, accountId, work); return; }
          if (result.kind !== "extraction") return;
          if (!result.actions.length) {
            const text = String(result.text || "The file did not provide enough information to prepare a transaction.");
            reviewOpened = true;
            work.dialog = modal({ title: `About ${file.name}`, cancelLabel: "Close", body: `<p>${esc(text)}</p><p>Nothing was saved. Add or correct the details, then choose the file again, or use the normal transaction form.</p>`, onClose: () => { if (work.active()) work.finish(); } });
            return;
          }
          if (result.actions.some(action => action.kind !== "log_transaction")) throw new Error("Add accepts new transaction records only. Use the normal feature screen for other changes; nothing from this file was saved.");
          const { amountFromText } = await import("./assistant-actions.js"); work.check();
          const account = A.get(accountId);
          const drafts = result.actions.map(action => {
            const p = action.params || {};
            if (!["expense", "income"].includes(p.kind)) throw new Error("A transaction's income/expense direction is unclear. Correct the file or use the normal form.");
            const currency = p.currency ? String(p.currency).toUpperCase() : entryCurrency(account);
            if (!CURRENCIES.includes(currency)) throw new Error("An uploaded currency is unsupported. Nothing from this file was saved.");
            const categories = p.category_name ? C.list(p.kind).filter(c => C.label(c).toLowerCase() === String(p.category_name).toLowerCase()) : [];
            let moneyValue = null;
            if (p.amount_text != null) { moneyValue = amountFromText(String(p.amount_text), currency); if (!moneyValue) throw new Error("An uploaded amount could not be read safely. Use the normal form to enter it."); }
            if (p.date != null && !validDate(p.date)) throw new Error("An uploaded date could not be read safely. Use the normal form to enter it.");
            return { kind: p.kind, account_id: accountId, money: moneyValue, date: p.date || today(), merchant: p.merchant || null, note: p.note || null, category_id: categories.length === 1 ? categories[0].id : null, unresolvedFields: p.category_name && categories.length !== 1 ? { category_id: `Choose a category; “${String(p.category_name).slice(0, 80)}” was not an exact match.` } : {}, source: "assistant", rate_text: p.rate_text == null ? null : String(p.rate_text), base_rate_text: p.base_rate_text == null ? null : String(p.base_rate_text) };
          });
          if (!drafts.length) throw new Error("No transaction records were found. Nothing from this file was saved.");
          reviewOpened = true;
          if (result.text?.trim()) importModal(work, { title: "Extraction notes", body: `<p>${esc(result.text)}</p><p>Review every transaction before saving.</p>`, submitLabel: "Review transactions", onSubmit: () => { confirmSequence(drafts, { title: `Review ${file.name}`, work }); return false; } });
          else confirmSequence(drafts, { title: `Review ${file.name}`, work });
        } });
      if (!current()) break;
      if (states[0]?.status === "error") throw new Error(`${file.name}: ${states[0].message}`);
      if (!reviewOpened) { work.cancel(); break; }
      if (work.active()) work.ready();
      await stopped;
      if (!completed || !current()) break;
      allDone = file === files.at(-1);
    }
  } catch (error) { if (current() && error.name !== "AbortError") toast(error.message); work?.cancel(); }
  finally {
    if (uploadBatch === batch) {
      const wasCurrent = current(); uploadBatch = null;
      if (started) { stagedUploadFiles.length = 0; uploadContext = ""; }
      const host = wasCurrent ? document.querySelector('form[data-door="upload"]') : null; controls(host, false);
      if (started) { host?.querySelector("[data-file-list]")?.replaceChildren(); if (host) host.elements.context.value = ""; }
      if (allDone && wasCurrent && currentRouteIsAdd(hash)) {
        if (/\.csv$/i.test(files.at(-1).name)) location.hash = "#/transactions";
        else C.checkUnlock();
      }
    }
  }
}
const currentRouteIsAdd = hash => location.hash === hash && hash.split("?")[0] === "#/add";
export function addPage() {
  const accts = A.active();
  const aiOn = ai.enabled();
  const acctSel = (name) => sel(name, accts, accts[0]?.id, (a) => `${a.name} (${a.currency})`, (a) => a.id);
  return {
    title: "Add",
    html: html`${accts.length ? "" : raw('<div class="card warn">Create an account first. <a href="#/accounts">Accounts →</a></div>')}
      ${overseasCurrency() ? raw(`<div class="card warn">${icon("overseas", { size: 16 })} <b>Overseas mode is on.</b> New records start in ${esc(overseasCurrency())} instead of the account's own currency. Turn it off in <a href="#/settings">Settings</a> when you are home.</div>`) : ""}
      <div class="card"><h2>Form</h2><p class="muted">Always available. Every other door ends in this form.</p><div class="actions"><button class="primary" data-door="expense">− Expense</button><button class="primary" data-door="income">+ Income</button><button data-door="transfer">⇄ Transfer</button><button data-door="rule">↻ Recurring rule</button></div></div>
      <div class="card"><h2>Type it <span class="tag ai">${raw(icon("ai", { size: 11 }))}sent to AI provider</span></h2>${aiOn ? raw(`<form data-door="text"><textarea name="text" placeholder="lunch 12 yesterday, taxi 8.50, salary 5000 on the 25th"></textarea><label>Account ${acctSel("account")}</label><div class="actions right"><button type="button" data-import-cancel>Cancel / reset</button><button class="primary">Read it</button></div></form>`) : raw(ai.offHtml())}</div>
      <div class="card"><h2>Upload files</h2><p class="muted">Choose an existing account and one file at a time. Files are only read after you press Read files. Supported: JPG, JPEG, PNG, WebP, PDF, CSV, MD and TXT.</p><form data-door="upload"><label>Account ${raw(acctSel("account"))}</label><label>Optional context <textarea name="context" maxlength="10000" placeholder="Anything useful about these files"></textarea></label><label>Browse files <input type="file" name="files" accept=".jpg,.jpeg,.png,.webp,.pdf,.csv,.md,.txt" /></label><label>Image kind ${raw(sel("hint", [["receipt", "receipt"], ["list", "payment app list"], ["statement", "bank statement"]], "receipt", x => x[1], x => x[0]))}</label><label>Take a receipt photo <input type="file" name="camera" accept="image/jpeg,image/png,image/webp" capture="environment" /></label><ul data-file-list></ul><p class="muted">${aiOn ? "PDF/text/images are sent to the AI provider after consent. CSV mapping uses at most five sample rows; all rows are reviewed locally." : "AI is off: CSV files can be mapped by hand. Turn AI on in Settings to read PDF, text or image files."}</p><div class="actions right"><button type="button" data-import-cancel>Cancel / reset</button><button type="submit" class="primary">Read files</button></div></form></div>`,
    bind(root) {
      const uploadForm = root.querySelector('form[data-door="upload"]');
      if (uploadForm) { uploadForm._stagedFiles = stagedUploadFiles; uploadForm.elements.context.value = uploadContext; if (A.active().some(a => a.id === uploadAccount)) uploadForm.elements.account.value = uploadAccount; uploadForm.elements.context.oninput = () => { uploadContext = uploadForm.elements.context.value; }; uploadForm.elements.account.onchange = () => { uploadAccount = uploadForm.elements.account.value; }; }
      const discard = () => { uploadBatch = null; stagedUploadFiles.length = 0; uploadContext = ""; uploadAccount = null; importWork?.cancel(); uploadForm?.reset(); uploadForm?.querySelector("[data-file-list]")?.replaceChildren(); uploadForm?.querySelectorAll("input,select,textarea,button[type=submit]").forEach(el => { el.disabled = false; }); };
      if (importWork?.active()) {
        const replacement = [...root.querySelectorAll("form[data-door]")].find((form) => form.dataset.door === importWork.form.dataset.door);
        if (replacement) { importWork.form = replacement; importWork.operation.attach(replacement); }
      }
      const manual = (open) => () => { discard(); open(); };
      root.querySelector("[data-door=expense]").onclick = manual(() => confirmModal({ kind: "expense" }, { title: "New expense" }));
      root.querySelector("[data-door=income]").onclick = manual(() => confirmModal({ kind: "income" }, { title: "New income" }));
      root.querySelector("[data-door=transfer]").onclick = manual(() => A.transferModal());
      root.querySelector("[data-door=rule]").onclick = manual(() => ruleModal());
      for (const form of root.querySelectorAll("form[data-door]")) {
        if (form.dataset.door === "upload") {
          const staged = stagedUploadFiles;
          const list = form.querySelector("[data-file-list]");
          const paint = () => { list.replaceChildren(...staged.map((file, i) => { const li = document.createElement("li"), remove = document.createElement("button"); li.textContent = file.name + " "; remove.type = "button"; remove.textContent = "Remove"; remove.disabled = !!importWork?.active(); remove.onclick = () => { if (uploadBatch || importWork?.active()) return; staged.splice(i, 1); form._stagedFiles = staged; paint(); }; li.append(remove); return li; })); };
          const add = input => { if (uploadBatch || importWork?.active()) return; const candidate = [...staged, ...input.files]; const total = candidate.reduce((n, f) => n + f.size, 0); if (candidate.length > 1 || candidate.some(f => f.size > LIMITS.fileBytes) || total > LIMITS.batchBytes) { let error = form.querySelector("[data-upload-error]"); if (!error) { error = document.createElement("p"); error.dataset.uploadError = ""; error.className = "error"; list.after(error); } error.textContent = `Choose one file at a time, no file over ${LIMITS.fileBytes / 1024 / 1024} MB, and no more than ${LIMITS.batchBytes / 1024 / 1024} MB total.`; input.value = ""; return; } form.querySelector("[data-upload-error]")?.remove(); staged.push(...input.files); form._stagedFiles = staged; input.value = ""; paint(); };
          form.elements.files.onchange = e => add(e.currentTarget); form.elements.camera.onchange = e => add(e.currentTarget);
          const showDropError = text => { let error = form.querySelector("[data-upload-error]"); if (!error) { error = document.createElement("p"); error.dataset.uploadError = ""; error.className = "error"; form.querySelector("[data-file-list]").after(error); } error.textContent = text; };
          form.ondragover = e => { e.preventDefault(); };
          form.ondrop = e => { e.preventDefault(); if (uploadBatch || importWork?.active()) return; const incoming = [...e.dataTransfer.files]; const candidate = [...staged, ...incoming]; const total = candidate.reduce((n, f) => n + f.size, 0); if (candidate.length > 1 || candidate.some(f => f.size > LIMITS.fileBytes) || total > LIMITS.batchBytes) { showDropError(`Choose one file at a time, no file over ${LIMITS.fileBytes / 1024 / 1024} MB, and no more than ${LIMITS.batchBytes / 1024 / 1024} MB total.`); return; } form.querySelector("[data-upload-error]")?.remove(); staged.push(...incoming); form._stagedFiles = staged; paint(); };
          paint();
        }
        form.querySelector("[data-import-cancel]").onclick = () => { if (importWork?.form === form) importWork.cancel(); else form.reset(); if (form.dataset.door === "upload") { uploadBatch = null; stagedUploadFiles.length = 0; uploadContext = ""; form._stagedFiles = stagedUploadFiles; form.querySelector("[data-file-list]")?.replaceChildren(); form.querySelector("[data-upload-error]")?.remove(); } };
        form.onsubmit = async (e) => {
          e.preventDefault();
          if (!form.isConnected || (importWork?.form === form && importWork.active())) return;
          const f = new FormData(form), door = form.dataset.door;
          if (door === "upload") { await runFileUpload(form, f); return; }
          const work = startImport(form);
          try {
            if (door === "csv") await reviewCsvImport(f.get("csv"), f.get("account"), work);
            else if (door === "text") {
              work.operation.progress("Preparing your text…", "generating");
              const drafts = await fromText(f.get("text"), f.get("account"), work); work.check();
              if (!drafts.length) { toast("Nothing found. Opening a blank form."); confirmModal({ account_id: f.get("account"), source: "text" }, { work, onDone: () => work.finish() }); }
              else confirmSequence(drafts, { title: "From your text", work });
            } else {
              work.operation.progress("Reading your image…", "reading");
              const r = await fromImage(f.get("image"), f.get("hint"), f.get("account"), work); work.check(); photoChoice(r, f.get("account"), work);
            }
          } catch (ex) {
            if (work.active()) {
              toast(ex.message);
              if (door === "csv" || door === "upload") work.cancel();
              else confirmModal({ account_id: f.get("account"), source: door, note: door === "text" ? f.get("text") : null }, { title: "Manual (AI could not read this)", work, onDone: () => work.finish() });
            }
          } finally { if (work.active()) work.ready(); else work.cancel(); }
        };
      }
      return ({ reason = "navigate" } = {}) => { if (reason !== "redraw") discard(); };
    },
  };
}

function photoChoice(r, accountId, work) {
  const itemsHtml = r.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${i.money ? fmt(i.money) : "—"}</td></tr>`).join("");
  const m = importModal(work, { title: "What the AI read", submitLabel: "One transaction for the total", extraButtons: `<button type="button" data-items ${r.items.length ? "" : "disabled"}>One per item (${r.items.length})</button>`,
    body: `<p>${esc(r.merchant || "merchant unknown")} · ${esc(r.date)} · total ${r.total ? fmt(r.total) : "— (not printed)"}</p>${r.mismatch ? `<div class="card warn">Items add up to ${fmt(money(r.itemSum, r.currency))} but the total says ${fmt(r.total)}. Shown, not fixed. You decide.</div>` : ""}<table>${itemsHtml}</table>`,
    onSubmit: () => { confirmModal({ kind: "expense", account_id: accountId, money: r.total || (r.itemSum != null ? money(r.itemSum, r.currency) : null), date: r.date, merchant: r.merchant, note: r.items.map((i) => `${i.description} ${i.money ? toDecimalString(i.money) : ""}`).join("; "), source: "photo" }, { title: "From photo", work, onDone: () => work.finish() }); } });
  m.form.querySelector("[data-items]").onclick = () => { work.check(); m.close(); confirmSequence(r.items.map((i, n) => ({ kind: "expense", account_id: accountId, money: i.money, date: i.date && i.date <= today() ? i.date : r.date, merchant: r.merchant, note: `${i.description} (${n + 1}/${r.items.length})`, source: "photo" })), { title: "From photo", work }); };
}

export async function reviewCsvImport(file, accountId, work, { mapColumns = null, suggestCategories = !mapColumns } = {}) {
  const acct = A.get(accountId);
  work.operation.progress("Reading the file…", "reading");
  const text = await file.text(); work.check();
  const rows = parseCsv(text);
  if (rows.length < 2) { toast("File has no data rows."); work.cancel(); return; }
  const header = rows[0].map((h) => h.trim()), data = rows.slice(1);
  if (data.length > 2000) { toast(`${data.length} rows. Max 2,000 per file. Split it and try again.`); work.cancel(); return; }
  let mapping = null;
  if (mapColumns) {
    try {
      work.operation.progress("Matching the column names…", "generating");
      mapping = await mapColumns(header, data.slice(0, 5), acct.currency); work.check();
      const test = applyMapping(data.slice(0, 5), header, mapping, acct.currency);
      if (test.every((t) => t.status === "failed")) { toast("Column mapping failed the test rows. Map by hand."); mapping = null; }
    } catch (e) { work.check(); toast(e.message); }
  } else if (ai.enabled()) {
    try {
      work.operation.progress("Matching the column names…", "generating");
      mapping = await mapCsvColumns(header, data.slice(0, 5), work); work.check();
      const test = applyMapping(data.slice(0, 5), header, mapping, acct.currency);
      if (test.every((t) => t.status === "failed")) { toast("AI mapping failed the test rows. Map by hand."); mapping = null; }
    } catch (e) { work.check(); toast(e.message); }
  }
  work.check();
  const proceed = (mp) => reviewBatch(file.name, header, data, mp, acct, work, { suggestCategories });
  if (mapping) await proceed(mapping);
  else manualMap(header, data, acct, proceed, work);
}
export function manualMap(header, data, _acct, cb, work) {
  const hs = ["", ...header];
  const m = importModal(work, { title: "Map the columns", submitLabel: "Apply",
    body: `<p class="muted">First row: ${esc(data[0].join(" | ")).slice(0, 160)}</p>${field("Date column", sel("date_col", header))}${field("Date format", inp("date_format", { value: "YYYY-MM-DD", placeholder: "e.g. DD/MM/YYYY" }))}${field("Amount column (signed)", sel("amount_col", hs))}<div class="inline">${field("or Debit column", sel("debit_col", hs))}${field("Credit column", sel("credit_col", hs))}</div>${field("Bank reference column (optional)", sel("reference_col", hs), "If each row has its own ID, it catches the same file imported twice.")}${field("Description column", sel("description_col", header))}${field("Currency column (optional)", sel("currency_col", hs))}${field("Negative amounts mean", sel("negative_means", ["expense", "income"]))}`,
    onSubmit: (f) => { const mp = Object.fromEntries([...f].map(([k, v]) => [k, v || null])); const issues = csvMappingIssues(mp, header); if (Object.keys(issues.fields).length) throw new ValidationError(issues); return cb(mp); } });
  bindValidation(m.form, { validate: values => csvMappingIssues(Object.fromEntries(values), header),
    dependencies: { amount_col: ['debit_col', 'credit_col'], debit_col: ['amount_col', 'credit_col'], credit_col: ['amount_col', 'debit_col'] } });
  return m;
}
export async function reviewBatch(fileName, header, data, mapping, acct, work, { suggestCategories = true } = {}) {
  work.check();
  const parsed = applyMapping(data, header, mapping, acct.currency);
  const seen = new Set();
  for (const r of parsed) {
    if (r.status !== "ready") continue;
    const d = { ...r.parsed, account_id: acct.id };
    try {
      validate(d); fx.validateDate(d.date);
      if (!CURRENCIES.includes(d.money.currency)) throw new Error(`Currency ${d.money.currency} is not supported. Fix the file or currency mapping.`);
      if (d.money.currency !== acct.currency) fx.validatePair(d.money.currency, acct.currency);
      if (acct.currency !== base()) fx.validatePair(acct.currency, base());
    } catch (error) {
      r.status = "failed"; r.reason = error.message; r.parsed = null; continue;
    }
    const h = d.bank_ref ? `ref:${d.bank_ref}` : dedupeHash(d);
    if (findDuplicate(d) || seen.has(h)) { r.status = "duplicate"; r.reason = "already recorded"; }
    seen.add(h);
  }
  const ready = parsed.filter((r) => r.status === "ready" || r.status === "duplicate");
  if (suggestCategories) {
    work.operation.progress("Checking category suggestions…", "generating");
    const sugg = await C.suggestBatch(ready.map((r) => ({ merchant: r.parsed.merchant, kind: r.parsed.kind })), work); work.check();
    ready.forEach((r, i) => (r.parsed.category_id = sugg[i].categoryId || null, r.parsed.cat_source = sugg[i].source));
  }
  work.operation.pause("Ready to review the rows.");
  const rowName = (r, i) => [`Row ${i + 1}`, r.parsed?.date || r.raw[mapping.date_col], r.parsed?.merchant || r.raw[mapping.description_col]].filter(Boolean).join(', ');
  const catOpts = (kind, selected, i, label) => `<select name="cat_${i}" data-cat aria-label="${esc(`Category for ${label}`)}"><option value="">— pick</option>${C.list(kind).map((c) => `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${esc(C.label(c))}</option>`).join("")}</select>`;
  const conversionHint = (r) => {
    if (!r.parsed) return "";
    const { money, date } = r.parsed, reasons = [];
    if (money.currency !== acct.currency && !fx.rateAt(money.currency, acct.currency, date, today())) reasons.push(fx.missingRateReason(money.currency, acct.currency, date));
    if (acct.currency !== base() && !fx.rateAt(acct.currency, base(), date, today())) reasons.push(fx.missingRateReason(acct.currency, base(), date));
    return reasons.map((reason) => { const m = reason.match(/([A-Z]{3}) → ([A-Z]{3})/); return `<div class="hint">${esc(reason)}${m[2] === acct.currency ? "; required to move the account" : "; base totals may be incomplete"}. ${rateLink(m[1], m[2], date)}</div>`; }).join("");
  };
  const tr = parsed.map((r, i) => `<tr data-i="${i}"><td><input type="checkbox" name="inc" value="${i}" aria-label="${esc(`Include ${rowName(r, i)}`)}" ${r.status === "ready" ? "checked" : ""} ${r.status === "failed" ? "disabled" : ""}/></td><td>${r.status === "failed" ? `<span class="tag crit">${esc(r.reason)}</span>` : `${r.parsed.date}<br><small>${esc(r.parsed.merchant || "")}</small>${r.status === "duplicate" ? '<span class="tag warn">possible duplicate</span>' : ""}${conversionHint(r)}`}</td><td class="num">${r.parsed ? (r.parsed.kind === "income" ? "+" : "−") + fmt(r.parsed.money) : ""}</td><td>${r.parsed ? catOpts(r.parsed.kind, r.parsed.category_id, i, rowName(r, i)) + (r.parsed.cat_source === "ai" ? '<span class="tag ai">AI</span>' : r.parsed.cat_source === "rule" ? '<span class="tag">seen</span>' : "") : ""}</td></tr>`).join("");
  const counts = { ready: parsed.filter((r) => r.status === "ready").length, dup: parsed.filter((r) => r.status === "duplicate").length, failed: parsed.filter((r) => r.status === "failed").length };
  let batchId = null;
  let batchOperationId = crypto.randomUUID(), commitSummary = null;
  importModal(work, { title: `Review ${fileName}`, submitLabel: "Save ticked rows",
    body: `<p class="muted">${data.length} rows: ${counts.ready} ready · ${counts.dup} possible duplicates (unticked) · ${counts.failed} failed (shown with reason). Mapping is not saved; every upload is read fresh.</p><div class="scroll-x" role="region" aria-label="CSV rows to review" tabindex="0"><table><thead><tr><th scope="col">Include</th><th scope="col">Row</th><th scope="col" class="num">Amount</th><th scope="col">Category</th></tr></thead><tbody>${tr}</tbody></table></div>`,
    onSubmit: async (f, form) => {
      const saved = await work.commit(() => {
      let n = 0, failures = 0;
      for (const i of f.getAll("inc")) {
        work.check();
        const r = parsed[Number(i)]; if (!r?.parsed || r.status === "confirmed") continue;
        const catSel = form.querySelector(`tr[data-i="${i}"] [data-cat]`), row = form.querySelector(`tr[data-i="${i}"]`);
        row.querySelector(".error")?.remove();
        try {
          save({ ...r.parsed, account_id: acct.id, category_id: catSel?.value || null, source: "csv" }); n++; r.status = "confirmed"; r.reason = null;
          row.querySelector('[name="inc"]').disabled = true;
        } catch (e) {
          failures++; r.status = "failed"; r.reason = e.message;
          const error = document.createElement("div"); error.className = "error"; error.textContent = e.message;
          row.querySelector("td:nth-child(2)").append(error);
        }
      }
      work.check();
      const batch = { source: "csv", file_name: fileName, row_count: data.length, mapping, rows: parsed.map((r) => ({ status: r.status === "ready" ? "skipped" : r.status, reason: r.reason || null })), confirmed_at: nowIso() };
      if (batchId) store.update("import_batches", batchId, batch);
      else batchId = store.insert("import_batches", batch).id;
      commitSummary = { n, failures };
      return failures ? false : true;
      }, batchOperationId, form);
      if (!work.active()) return false;
      if (commitSummary) toast(`${commitSummary.n} saved${commitSummary.failures ? `; ${commitSummary.failures} failed, shown below` : ""}`);
      if (saved.value === false) { batchOperationId = crypto.randomUUID(); return false; }
      work.finish(); if (!work.stayOnAdd) location.hash = "#/transactions";
    } });
}

// Investments: described only. Cost basis, P&L, allocation, returns. Disclaimer everywhere. No advice.
// The feature is "Investments"; one position inside it is a holding, which is also the stored entity.
import { store } from "../lib/store.js";
import { money, fmt, parseMoney, isMoney, add, convert, CURRENCIES, exponent, toDecimalString } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, moneyInput, esc, lineChart, bindCharts, cap, rateLink, rateLinks, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { base, today } from "./profile.js";
import { createOperation } from "../lib/operations.js";
import { icon } from "../lib/icons.js";

// Wording approved 2026-09-19. The short line goes wherever investments appear; the full text sits one tap behind it.
export const DISCLAIMER = "General information only, not financial advice. AI can make mistakes. Values are as you entered them.";
export const DISCLAIMER_FULL = "This app describes what you hold. It is not a recommendation to buy, sell or hold anything, and it does not consider your goals, finances or needs. Figures are as you entered them and may be out of date. AI-written text can contain mistakes. Past performance does not predict future returns. For advice, speak to a licensed financial adviser.";
export const disclaimerBlock = () => `<details class="disclaimer"><summary>${esc(DISCLAIMER)} <span class="more">More</span></summary><p>${esc(DISCLAIMER_FULL)}</p></details>`;
export const TYPES = ["stock", "etf", "fund", "bond", "crypto", "cash", "other"];
export const list = (status) => store.all("holdings").filter((h) => (status ? h.status === status : h.status !== "archived"));
export const get = (id) => store.get("holdings", id);
const optionalText = (v) => v == null || v === "" || typeof v === "string";
const safeMoney = (m, currency) => isMoney(m) && Number.isSafeInteger(m.amount) && CURRENCIES.includes(m.currency) && (!currency || m.currency === currency);
export function collectHolding(input) {
  const fields = {}, name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fields.name = "Name required.";
  for (const [key,label] of [["ticker","Ticker"],["accountLabel","Broker / platform"]]) if (!optionalText(input[key])) fields[key === "accountLabel" ? "label" : key] = `${label} must be text.`;
  if (!TYPES.includes(input.type)) fields.type = "Choose a valid investment type.";
  if (!CURRENCIES.includes(input.currency)) fields.currency = "Choose a supported currency.";
  if (!["units", "value"].includes(input.mode)) fields.mode = "Choose a valid mode.";
  const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() || null : null;
  return { fields, candidate: { name, ticker, type: input.type, currency: input.currency, mode: input.mode, accountLabel: typeof input.accountLabel === "string" ? input.accountLabel.trim() || null : null } };
}
export function create(input) { const { fields, candidate } = collectHolding(input); if (Object.keys(fields).length) throw new ValidationError({ fields }); return store.insert("holdings", { name: candidate.name, ticker: candidate.ticker, type: candidate.type, currency: candidate.currency, mode: candidate.mode, account_label: candidate.accountLabel, status: "active" }); }
export const update = (id, patch) => store.update("holdings", id, patch);
export const trades = (id) => store.all("trades").filter((t) => t.holding_id === id).sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at));
export const flows = (id) => store.all("cash_flows").filter((t) => t.holding_id === id).sort((a, b) => a.date.localeCompare(b.date));
export const vals = (id) => store.all("valuations").filter((v) => v.holding_id === id).sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
const unitsNum = (s) => Number(String(s).replace(/,/g, ""));
// Units are summed as floats, so 68.767 comes back as 68.76700000000001. Four decimals is finer
// than any broker fills, and the stored trades keep their exact strings either way.
export const fmtUnits = (n) => String(Math.round(Number(n) * 1e4) / 1e4);

// Every buy, sell, deposit, withdrawal and value is frozen at the rate of its own date, the way a
// record is. Without one the row is refused: a past amount restated at today's rate is a guess.
function frozen(m, date, rate) {
  fx.validateDate(date);
  const snap = fx.snapshotOn(m, base(), date, rate) || fx.snapshotAt(m, base(), date, today(), rate);
  if (!snap.base_money) throw fx.missingRateError(m.currency, base(), date);
  return snap;
}
function resolveRate(currency, date, typed, fields, fieldName = "rate") {
  if (fields.date || currency === base()) return null;
  if (typed != null && String(typed).trim()) {
    try { return fx.validateRate(typed); } catch { fields[fieldName] = "Enter a valid exchange rate."; return null; }
  }
  try { return rateFor(currency, date); } catch (e) { fields[fieldName] = "Update rate"; fields.rate_pair = e.rate_pair; return null; }
}
export function collectTrade(id, kind, date, units, price, fees, rate, feeText = null) {
  const fields = {}, h = get(id), u = unitsNum(units), dateValid = (() => { try { fx.validateDate(date); return true; } catch { fields.date = "Choose a valid date, today or earlier."; return false; } })();
  if (!h) fields.holding_id = "Choose an existing investment.";
  else if (h.mode !== "units") fields.holding_id = "This investment is value-only.";
  if (!['buy','sell'].includes(kind)) fields.kind = "Choose buy or sell.";
  if (!Number.isFinite(u) || !(u > 0)) fields.units = "Units must be above zero.";
  if (!safeMoney(price, h?.currency)) fields.price = `Enter a safe amount in ${h?.currency || "the investment currency"}.`;
  if ((fees != null && !safeMoney(fees, h?.currency)) || (feeText != null && String(feeText).trim() && fees == null)) fields.fees = `Enter a safe amount in ${h?.currency || "the investment currency"}.`;
  if (h && kind === "sell" && Number.isFinite(u) && u > position(h).units + 1e-9) fields.units = `Refused: only ${position(h).units} units held.`;
  let gross, snap, resolved;
  if (h && dateValid && CURRENCIES.includes(h.currency)) resolved = resolveRate(h.currency,date,rate,fields);
  const amountFieldsValid = h && Number.isFinite(u) && u > 0 && ['buy','sell'].includes(kind) && safeMoney(price,h.currency) && (fees == null || safeMoney(fees,h.currency)) && !(feeText != null && String(feeText).trim() && fees == null);
  if (amountFieldsValid && !fields.holding_id && !fields.kind && !fields.units && dateValid) {
    gross = Math.round(u * price.amount);
    const net = kind === "buy" ? gross + (fees?.amount || 0) : gross - (fees?.amount || 0);
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(net)) fields.price = "Computed total is too large.";
    else if (h.currency === base() || resolved) try { snap = frozen(money(net,h.currency),date,resolved); } catch { fields.price = "Converted total is too large to save safely."; }
  }
  const {rate_pair,...visibleFields}=fields; return { fields:visibleFields, rate_pair, candidate: { h, kind, date, units: String(u), price, fees: fees ?? null, snap } };
}
export function trade(id, kind, date, units, price, fees, { rate } = {}) {
  const { fields, rate_pair, candidate: c } = collectTrade(id, kind, date, units, price, fees, rate);
  if (Object.keys(fields).length) throw new ValidationError({ fields, rate_pair });
  return store.insert("trades", { holding_id: id, kind: c.kind, date: c.date, units: c.units, price: c.price, fees: c.fees, base_money: c.snap.base_money, fx: c.snap.fx, transaction_id: null });
}
export function collectEntry(id, kind, date, m, rate, isFlow = false) {
  const fields = {}, h = get(id); let dateValid = false;
  if (!h) fields.holding_id = "Choose an existing investment.";
  if (isFlow && !["deposit", "withdrawal"].includes(kind)) fields.kind = "Choose deposit or withdrawal.";
  if (!isFlow && !["manual","photo"].includes(kind)) fields.source = "Choose a valid value source.";
  if (!safeMoney(m, h?.currency) || (isFlow && m.amount <= 0)) fields[isFlow ? "amount" : "value"] = `Enter a safe${isFlow ? " positive" : ""} amount in ${h?.currency || "the investment currency"}.`;
  try { fx.validateDate(date); dateValid = true; } catch { fields.date = "Choose a valid date, today or earlier."; }
  let snap, resolved;
  if (h && dateValid && CURRENCIES.includes(h.currency)) resolved = resolveRate(h.currency,date,rate,fields);
  if (h && !fields.holding_id && !fields.kind && !fields.source && safeMoney(m,h.currency) && (!isFlow || m.amount > 0) && dateValid && (h.currency === base() || resolved)) try { snap = frozen(m,date,resolved); } catch { fields[isFlow ? "amount" : "value"] = "Converted amount is too large to save safely."; }
  const {rate_pair,...visibleFields}=fields; return { fields:visibleFields, rate_pair, candidate: { h, kind, date, money: m, snap } };
}
export function cashFlow(id, kind, date, m, { rate } = {}) {
  const { fields, rate_pair, candidate: c } = collectEntry(id, kind, date, m, rate, true);
  if (Object.keys(fields).length) throw new ValidationError({ fields, rate_pair });
  return store.insert("cash_flows", { holding_id: id, kind, date, money: c.money, base_money: c.snap.base_money, fx: c.snap.fx, transaction_id: null });
}
export function value(id, date, m, source = "manual", { rate } = {}) {
  const { fields, rate_pair, candidate: c } = collectEntry(id, source, date, m, rate, false);
  if (Object.keys(fields).length) throw new ValidationError({ fields, rate_pair });
  return store.insert("valuations", { holding_id: id, date, value: m, source, base_money: c.snap.base_money, fx: c.snap.fx });
}
// Typed rate, else an explicitly entered rate for this day; never a network call.
export function rateFor(currency, date, typed) {
  fx.validateDate(date);
  if (currency === base()) return null;
  if (typed && String(typed).trim()) return fx.validateRate(typed);
  const r = entryRate(currency, date);
  if (!r) throw fx.missingRateError(currency, base(), date);
  return r.rate;
}
const entryRate = (currency, date) => fx.rateOn(currency, base(), date) || (date === today() ? fx.liveRate(currency, base()) : null);
export const rateField = (h) => h.currency === base() ? "" : `${field(`1 ${h.currency} = how many ${base()} on this date?`, moneyInput("rate", "", "blank = saved manual rate"), "Frozen onto this entry. Updating Settings never changes it.")}<div class="hint" data-entry-rate-note></div>`;
export function bindRateField(m, h) {
  if (h.currency === base()) return m;
  const refresh = () => {
    const date = m.form.date.value, r = entryRate(h.currency, date);
    const note = m.form.querySelector("[data-entry-rate-note]");
    note.textContent = r ? `Saved rate: 1 ${h.currency} = ${r.rate} ${base()}. ` : `${fx.missingRateReason(h.currency, base(), date)}. `;
    const link = document.createElement("a"); link.className = "btn small";
    link.href = fx.rateUrl(h.currency, base(), date); link.textContent = "Update rate"; note.append(link);
  };
  m.form.date.addEventListener("change", refresh); refresh(); return m;
}

export function valueModal(holdingId, preset = {}) {
  const h = get(holdingId);
  if (!h || h.status !== "active") { toast(!h ? "This investment no longer exists." : "This investment is closed or archived; values cannot be added."); return null; }
  let prepared;
  const read = (f) => (prepared = collectEntry(holdingId, "manual", f.get("date"), parseMoney(f.get("value"), h.currency), f.get("rate"), false));
  const dialog = bindRateField(modal({ title: "Set dated value", body: `<div class="inline">${field("Total value (" + h.currency + ")", moneyInput("value", preset.value ? toDecimalString(preset.value) : ""))}${field("As of", inp("date", { type: "date", value: preset.date || today() }))}</div>${rateField(h)}`, onSubmit: () => {
    const current = get(holdingId);
    if (!current || current.status !== "active") throw new ValidationError({ form: !current ? "This investment no longer exists." : "This investment is closed or archived; values cannot be added." });
    const result = prepared;
    if (Object.keys(result.fields).length) throw new ValidationError({ fields: result.fields, rate_pair: result.rate_pair });
    preset.beforeCommit?.();
    const c = result.candidate;
    return store.insert("valuations", { holding_id: holdingId, date: c.date, value: c.money, source: "manual", base_money: c.snap.base_money, fx: c.snap.fx });
  }, onSuccess: (result) => preset.onDone?.(result) }), h);
  bindValidation(dialog.form, { validate: read, dependencies: { date: ["rate"], value: ["rate"] } });
  return dialog;
}

export function position(h) {
  const cur = h.currency; let units = 0, totalCost = 0, realised = 0;
  if (h.mode === "units") for (const t of trades(h.id)) {
    const u = unitsNum(t.units), gross = Math.round(u * t.price.amount), fees = t.fees?.amount || 0;
    if (t.kind === "buy") { totalCost += gross + fees; units += u; }
    else { const avg = units > 0 ? totalCost / units : 0; realised += gross - fees - Math.round(u * avg); units -= u; totalCost = Math.round(units * avg); }
  }
  const avgCost = h.mode === "units" && units > 0 ? money(Math.round(totalCost / units), cur) : null;
  const costBasis = h.mode === "units" ? money(Math.round(totalCost), cur) : null;
  const fl = flows(h.id);
  const netContributed = fl.length ? money(fl.reduce((s, f) => s + (f.kind === "deposit" ? f.money.amount : -f.money.amount), 0), cur) : null;
  const latest = vals(h.id)[0] || null;
  const latestValue = latest?.value || null;
  let pnl = null, pnlReason = null;
  if (!latestValue) pnlReason = "no value entered";
  else if (h.mode === "units") pnl = money(latestValue.amount - costBasis.amount, cur);
  else if (netContributed) pnl = money(latestValue.amount - netContributed.amount, cur); else pnlReason = "no contributions logged";
  return { units, avgCost, costBasis, netContributed, latestValue, asOf: latest?.date || null, pnl, pnlReason, realised: h.mode === "units" ? money(Math.round(realised), cur) : null };
}
export function summary() {
  const hs = list("active"), b = base(); const reasons = []; let total = money(0, b); const rows = []; let oldest = null;
  for (const h of hs) {
    const p = position(h); let baseVal = null;
    if (!p.latestValue) reasons.push(`${h.name} has no value`);
    else { const c = fx.toBase(p.latestValue, b); if (!c.money) reasons.push(`${h.name}: ${c.reason}`); else { baseVal = c.money; total = total && add(total, baseVal); if (!oldest || p.asOf < oldest) oldest = p.asOf; } }
    rows.push({ h, p, baseVal });
  }
  const valued = rows.filter((r) => r.baseVal);
  const sumValued = valued.reduce((s, r) => s + r.baseVal.amount, 0);
  const byType = {};
  for (const r of valued) byType[r.h.type] = (byType[r.h.type] || 0) + r.baseVal.amount;
  const allocation = Object.entries(byType).map(([type, amt]) => ({ type, amount: money(amt, b), pct: sumValued ? Math.round((amt / sumValued) * 1000) / 10 : 0 })).sort((a, c) => c.amount.amount - a.amount.amount);
  return { totalBase: reasons.length ? null : total, partial: money(sumValued, b), allocation, incomplete_reasons: reasons, oldestAsOf: oldest, rows };
}
// ---------- returns ----------
// Money in counts buys and deposits; money out counts sells and withdrawals.
// Both modes of holding are covered, so a units-mode position with no cash-flow rows still has contributions.
// Past amounts use only their saved conversion. A missing/old-base snapshot stays absent,
// never restated at a new current rate.
function inBase(m, row, { live = false } = {}) {
  if (m.currency === base()) return { amount: m.amount };
  if (!live && row.base_money?.currency === base()) return { amount: row.base_money.amount };
  if (!live && row.fx && row.fx.to === base()) return { amount: convert(m, base(), row.fx.rate).amount };
  if (!live) return { amount: null, reason: `${fx.missingRateReason(m.currency, base(), row.date)} (saved conversion absent; history is unchanged)` };
  const c = fx.toBase(m, base());
  return c.money ? { amount: c.money.amount } : { amount: null, reason: c.reason };
}
export function flowsBase({ upTo = null } = {}) {
  const out = [];
  for (const h of store.all("holdings")) {
    const push = (row, date, amount) => { if (upTo && date > upTo) return; const c = inBase(money(Math.round(Math.abs(amount)), h.currency), row); out.push(c.amount == null ? { date, amount: null, reason: c.reason } : { date, amount: amount < 0 ? -c.amount : c.amount, restated: c.restated }); };
    for (const f of flows(h.id)) push(f, f.date, f.kind === "deposit" ? f.money.amount : -f.money.amount);
    for (const t of trades(h.id)) { const gross = Math.round(unitsNum(t.units) * t.price.amount), fees = t.fees?.amount || 0; push(t, t.date, t.kind === "buy" ? gross + fees : -(gross - fees)); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
// Portfolio value on a date: each holding's latest valuation on or before it, carried forward, never
// interpolated. A past date uses the rate frozen when that value was dated; today uses today's rate,
// because what something is worth now is priced now.
export function valueAt(date) {
  let total = 0, rateMissing = false; const missing = [];
  const live = date >= today();
  for (const h of store.all("holdings")) {
    const v = vals(h.id).find((x) => x.date <= date);
    if (!v) { missing.push(`${h.name} has no value on or before ${date}`); continue; }
    const c = inBase(v.value, v, { live });
    if (c.amount == null) { missing.push(`${h.name}: ${c.reason}`); rateMissing = true; continue; }
    total += c.amount;
  }
  return { amount: rateMissing ? null : total, missing, restated: 0 };
}
// "6 months", for a yearly rate worked out from less than a year.
export function periodLabel(days) { return days < 60 ? `${days} days` : `${Math.round(days / 30.44)} months`; }
// Money-weighted return: the annualised rate at which the dated flows and the end value balance. Bisection, 365-day year.
export function xirr(cashflows) {
  const cf = cashflows.filter((c) => c.amount != null && c.amount !== 0);
  if (cf.length < 2) return null;
  const pos = cf.some((c) => c.amount > 0), negi = cf.some((c) => c.amount < 0);
  if (!pos || !negi) return null;
  const d0 = cf[0].date;
  const npv = (r) => cf.reduce((s, c) => s + c.amount / Math.pow(1 + r, D.daysBetween(d0, c.date) / 365), 0);
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, f = npv(mid);
    if (!Number.isFinite(f)) return null;
    if (Math.abs(f) < 1e-6 || hi - lo < 1e-9) return mid;
    if (flo * f <= 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
  }
  return (lo + hi) / 2;
}
export function returns(asOf = today()) {
  const reasons = [];
  const v = valueAt(asOf);
  const fl = flowsBase({ upTo: asOf });
  reasons.push(...v.missing, ...fl.filter((f) => f.amount == null).map((f) => f.reason));
  const rateMissing = fl.some((f) => f.amount == null), completeValue = !v.missing.length;
  const net = fl.reduce((s, f) => s + (f.amount || 0), 0);
  const hasValue = store.all("holdings").some((h) => vals(h.id).length);
  const netContributed = fl.length && !rateMissing ? money(net, base()) : null;
  let simplePct = null;
  if (!fl.length) reasons.push("nothing contributed yet, so a simple return cannot be worked out");
  else if (net <= 0) reasons.push("contributions net to zero or less, so a simple return cannot be worked out");
  else if (hasValue && netContributed && completeValue) simplePct = ((v.amount - net) / net) * 100;
  // A yearly rate even when there is less than a year behind it, with the period it came from, so a
  // short history is shown and named rather than hidden (ruled 2026-09-19).
  let dwPct = null, dwDays = null;
  if (hasValue && completeValue && !rateMissing && fl.length) {
    dwDays = D.daysBetween(fl[0].date, asOf);
    const r = xirr([...fl.map((f) => ({ date: f.date, amount: -f.amount })), { date: asOf, amount: v.amount }]);
    if (r == null) reasons.push("the dated cash flows do not solve for a dollar-weighted return");
    else dwPct = r * 100;
  }
  return { value: hasValue && completeValue ? money(v.amount, base()) : null, netContributed, simplePct, dollarWeightedPct: dwPct, dwPeriod: dwDays != null && dwDays < 365 ? periodLabel(dwDays) : null, reasons: [...new Set(reasons)], asOf };
}
// One line, three modes. Never two units on one pair of axes.
export function series(mode = "amount") {
  const dates = [...new Set(store.all("valuations").map((v) => v.date))].sort();
  if (!dates.length) return { points: [], reason: "no values entered yet" };
  if (dates[dates.length - 1] < today()) dates.push(today());
  const span = D.daysBetween(dates[0], dates[dates.length - 1]);
  const points = dates.map((d) => {
    const x = D.fmtAxis(d, span);
    if (mode === "amount") { const v = valueAt(d); return { x, y: v.amount == null ? null : v.amount / 10 ** exponent(base()), note: v.missing.length ? `Incomplete: ${v.missing.join("; ")}` : undefined }; }
    const r = returns(d);
    const y = mode === "simple" ? r.simplePct : r.dollarWeightedPct;
    // A yearly rate from less than a year swings hard. It is drawn, and the tooltip names the period.
    return { x, y: y == null ? null : y, note: mode === "dollar_weighted" && y != null && r.dwPeriod ? `a yearly rate from ${r.dwPeriod}` : undefined };
  });
  if (points.some((p) => p.y != null)) return { points, reason: null };
  return { points, reason: mode === "simple" ? "no contributions logged, so there is no simple return to draw" : "the cash flows do not solve for a dollar-weighted return" };
}

export async function fromImage(file, { signal, onProgress } = {}) {
  const img = await ai.fileToImage(file, { signal }); signal?.throwIfAborted(); const known = list("active").map((h) => ({ id: h.id, name: h.name, ticker: h.ticker || undefined }));
  onProgress?.("Matching statement positions…", "generating");
  return ai.call("extract_holdings_statement", { tier: "cheap", images: [img], signal, system: "Read the brokerage or exchange statement. One row per position: name, ticker if printed, units text, value text, currency, all verbatim. Match each row to a known holding id by ticker first, exact name second, else null. Never invent.", input: { known, currency_hint: base() },
    schema: { type: "object", required: ["rows"], properties: { as_of: { type: ["string", "null"] }, rows: { type: "array", items: { type: "object", required: ["name", "value_text"], properties: { name: { type: "string" }, ticker: { type: ["string", "null"] }, units_text: { type: ["string", "null"] }, value_text: { type: "string" }, currency: { type: ["string", "null"] }, match_id: { type: ["string", "null"] } } } } } },
    validate: (o) => (o.rows.some((r) => r.match_id && !known.find((k) => k.id === r.match_id)) ? "match_id not known" : null) });
}

export function investmentsPage() {
  const s = summary();
  const q = new URLSearchParams((location.hash.split("?")[1] || ""));
  const mode = ["amount", "simple", "dollar_weighted"].includes(q.get("mode")) ? q.get("mode") : "amount";
  const ser = series(mode);
  const r = returns();
  const pctTxt = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
  const chipHref = (m) => `#/investments?mode=${m}`;
  const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];
  const row = ({ h, p, baseVal }) => `<div class="row clickable" data-open="${h.id}"><div class="grow"><div class="title">${esc(h.name)}${h.ticker ? ` <span class="tag">${esc(h.ticker)}</span>` : ""}<span class="tag">${cap(h.type)}</span></div>
    <div class="sub">${h.mode === "units" ? `${fmtUnits(p.units)} units · avg ${p.avgCost ? fmt(p.avgCost) : "—"} · cost ${fmt(p.costBasis)}` : `contributed ${p.netContributed ? fmt(p.netContributed) : "—"}`} · P&L ${p.pnl ? fmt(p.pnl, { sign: true }) : `— (${p.pnlReason})`}${p.asOf ? ` · as of ${D.fmtDateShort(p.asOf)}` : ""}</div></div>
    <div class="amt">${p.latestValue ? fmt(p.latestValue) : "no value"}${baseVal && h.currency !== base() ? `<br><small>${fmt(baseVal)}</small>` : ""}</div></div>`;
  return {
    title: "Investments",
    html: html`${raw(disclaimerBlock())}
      <div class="stat"><div class="label">Total in ${base()}${s.oldestAsOf ? ` · oldest value as of ${D.fmtDateShort(s.oldestAsOf)}` : ""}</div><div class="value">${s.totalBase ? fmt(s.totalBase) : "—"}</div>${s.incomplete_reasons.length ? raw(`<div class="sub">incomplete: ${esc(s.incomplete_reasons.join("; "))}${rateLinks(s.incomplete_reasons)}${s.partial.amount ? ` · partial ${fmt(s.partial)}` : ""}</div>`) : ""}</div>
      <div class="card"><h2>Returns</h2>
        <dl class="num-list">
          <div class="num-row"><dt>Put in, net of anything taken out</dt><dd>${r.netContributed ? fmt(r.netContributed) : "—"}</dd></div>
          <div class="num-row"><dt>Worth now</dt><dd>${r.value ? fmt(r.value) : "—"}</dd></div>
          <div class="num-row ${r.simplePct != null && r.simplePct < 0 ? "bad" : ""}"><dt>Simple return<span class="num-note">worth now against what you put in</span></dt><dd>${pctTxt(r.simplePct)}</dd></div>
          <div class="num-row ${r.dollarWeightedPct != null && r.dollarWeightedPct < 0 ? "bad" : ""}"><dt>Dollar-weighted return<span class="num-note">a year's rate, counting when each amount went in${r.dwPeriod && r.dollarWeightedPct != null ? `, worked out from ${r.dwPeriod}` : ""}</span></dt><dd>${pctTxt(r.dollarWeightedPct)}</dd></div>
        </dl>
        ${r.reasons.length ? raw(`<div class="hint">${esc(r.reasons.join(" · "))}${rateLinks(r.reasons)}</div>`) : ""}
      </div>
      <div class="card"><h2>History</h2>
        <div class="chips"><a class="chip ${mode === "amount" ? "on" : ""}" href="${chipHref("amount")}">Amount</a><a class="chip ${mode === "simple" ? "on" : ""}" href="${chipHref("simple")}">Simple return</a><a class="chip ${mode === "dollar_weighted" ? "on" : ""}" href="${chipHref("dollar_weighted")}">Dollar-weighted</a></div>
        ${raw(ser.points.some((p) => p.y != null) ? lineChart(ser.points, { fmtY: (v) => (mode === "amount" ? fmt(money(Math.round(v * 10 ** exponent(base())), base())) : (v >= 0 ? "+" : "") + v.toFixed(1) + "%"), id: "inv" }) : `<div class="empty">${esc(ser.reason || "Nothing to draw yet")}</div>`)}
        <p class="muted">Each point uses the latest value on or before that date, carried forward and never guessed between two values. Past points use the exchange rate of the day each value was dated; today uses the latest manual rate.${mode === "dollar_weighted" ? " Every point is a yearly rate. Points from less than a year of history swing hard, and say so." : ""}</p>
      </div>
      ${s.allocation.length ? raw(`<div class="card"><h2>Allocation</h2><div class="alloc">${s.allocation.map((a, i) => `<i style="width:${a.pct}%;background:${COLORS[i % COLORS.length]}" title="${cap(a.type)} ${a.pct}%"></i>`).join("")}</div><div class="legend">${s.allocation.map((a, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${cap(a.type)} ${a.pct}% · ${fmt(a.amount)}</span>`).join("")}</div><p class="muted">Over holdings with a value only.</p></div>`) : ""}
      <div data-operation-root><div class="actions"><button class="primary" data-action="new">＋ Investment</button>${ai.enabled() ? raw(`<label class="btn">${icon("camera", { size: 17 })} Statement photo <input type="file" accept="image/*" data-action="photo" hidden /></label>`) : ""}</div><div data-operation-status class="operation-status" role="status" aria-live="polite"></div></div>
      <div class="card">${s.rows.length ? raw(s.rows.map(row).join("")) : raw('<div class="empty">No investments yet. Add a position, then log buys, deposits, and dated values.</div>')}</div>`,
    bind(root) {
      bindCharts(root);
      root.querySelector("[data-action=new]").onclick = () => { let prepared; const dialog = modal({ title: "New investment", body: `<div class="inline">${field("Name", inp("name", { required: true, placeholder: "Vanguard S&P 500" }))}${field("Ticker", inp("ticker", { placeholder: "VOO" }))}</div><div class="inline">${field("Type", sel("type", TYPES, "etf"))}${field("Currency", sel("currency", CURRENCIES, base()))}${field("Mode", sel("mode", [["units", "units + price"], ["value", "value only"]], "units", (x) => x[1], (x) => x[0]))}</div>${field("Broker / platform", inp("label"))}<p class="hint">Mode is fixed at creation. Units mode tracks buys/sells and average cost. Value mode tracks deposits and dated values only.</p>`, onSubmit: () => { const c=prepared.candidate;store.insert("holdings",{name:c.name,ticker:c.ticker,type:c.type,currency:c.currency,mode:c.mode,account_label:c.accountLabel,status:"active"}); } }); bindValidation(dialog.form, { validate: v => (prepared=collectHolding({ name:v.get("name"), ticker:v.get("ticker"), type:v.get("type"), currency:v.get("currency"), mode:v.get("mode"), accountLabel:v.get("label") })) }); };
      root.querySelectorAll("[data-open]").forEach((el) => (el.onclick = () => (location.hash = `#/investments/${el.dataset.open}`)));
      // Rebind the same job after redraw so status and departure cleanup stay connected.
      let photoOperation = createOperation({ root: root.querySelector("[data-operation-root]"), key: "investments.statement-photo", ownerGeneration: store.generation() });
      const photoInput = root.querySelector("[data-action=photo]");
      photoInput?.addEventListener("change", async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const pageHash = location.hash, operation = createOperation({ root: root.querySelector("[data-operation-root]"), key: "investments.statement-photo", ownerGeneration: store.generation() });
        photoOperation = operation;
        if (!operation.start("Reading statement…", "reading")) return;
        try {
          const r = await fromImage(file, { signal: operation.signal, onProgress: (message, phase) => operation.progress(message, phase) });
          if (!operation.active() || !root.isConnected || location.hash !== pageHash) return;
          operation.succeed("Statement read. Nothing is saved until you confirm."); statementModal(r);
        } catch { if (operation.active()) operation.fail("Could not read this statement.", "Choose another image or enter the values manually."); }
        finally { if (photoInput.isConnected) photoInput.value = ""; }
      });
      return ({ reason = "navigate" } = {}) => { if (reason !== "redraw") photoOperation?.dispose(reason); };
    },
  };
}
function statementModal(r) {
  const asOf = r.as_of || today();
  const rows = r.rows.map((x,i)=>{const cur=x.currency?String(x.currency).toUpperCase():base();return {...x,i,name:typeof x.name==="string"?x.name:"",cur,m:CURRENCIES.includes(cur)?parseMoney(x.value_text,cur):null};});
  const foreign=[...new Set(rows.filter(x=>CURRENCIES.includes(x.cur)&&x.cur!==base()).map(x=>x.cur))];
  const rates=foreign.map(c=>field(`1 ${c} = how many ${base()} on ${asOf}?`,moneyInput(`rate_${c}`,"","blank = saved manual rate"))+rateLink(c,base(),asOf)).join("");
  const rowName=x=>x.name||`row ${x.i+1}`;
  let prepared;const dialog=modal({title:`Statement as of ${asOf}`,submitLabel:"Apply ticked",body:`<p class="ai-note">Matched by ticker, then exact name. Nothing is saved until you confirm.</p>${field("Statement date",inp("stmt_date",{type:"date",value:asOf}))}<table><tr><th>Include</th><th>Name</th><th class="num">Value</th><th>Match</th></tr>${rows.map(x=>`<tr><td><input type="checkbox" name="inc_${x.i}" value="yes" aria-label="${esc(`Include row ${x.i+1}: ${rowName(x)} (${asOf})`)}" ${x.m?"checked":""}/></td><td>${field(`Row ${x.i+1} name: ${rowName(x)} (${asOf})`,inp(`name_${x.i}`,{value:x.name}))}</td><td class="num">${safeMoney(x.m,x.cur)?fmt(x.m):"unreadable"}</td><td>${field(`Match row ${x.i+1}: ${rowName(x)} (${asOf})`,sel(`match_${x.i}`,[["new","create new"],...list("active").map(h=>[h.id,h.name]),["skip","skip"]],x.match_id||"new",x=>x[1],x=>x[0]))}</td></tr>`).join("")}</table>${rates}`,onSubmit:()=>{const result=prepared;if(Object.keys(result.fields).length)throw new ValidationError({fields:result.fields,rate_pair:result.rate_pair});let n=0;for(const x of result.candidate.rows){let h=x.h;if(x.choice==="new")h=store.insert("holdings",{name:x.holding.name,ticker:x.holding.ticker,type:x.holding.type,currency:x.holding.currency,mode:x.holding.mode,account_label:x.holding.accountLabel,status:"active"});store.insert("valuations",{holding_id:h.id,date:result.candidate.date,value:x.row.m,source:"photo",base_money:x.snap.base_money,fx:x.snap.fx});n++;}toast(`${n} valuations added`);}});
  const dependencies={stmt_date:[...foreign.map(c=>`rate_${c}`)]};for(const x of rows){const inc=`inc_${x.i}`,name=`name_${x.i}`,match=`match_${x.i}`,rate=`rate_${x.cur}`;dependencies[inc]=[name,match,...(foreign.includes(x.cur)?[rate]:[])];dependencies[name]=[match];dependencies[match]=[name,...(foreign.includes(x.cur)?[rate]:[])];}
  bindValidation(dialog.form,{validate:f=>(prepared=collectStatement(rows,f.get("stmt_date"),f)),dependencies});
}
function collectStatement(rows, date, form) {
  const fields = {}, candidate = [];
  const issue = (name, message) => { fields[name] = fields[name] ? `${fields[name]} ${message}` : message; };
  let dateValid = false;
  try { fx.validateDate(date); dateValid = true; } catch { issue("stmt_date", "Choose a valid date, today or earlier."); }
  for (const row of rows) {
    if (form.get(`inc_${row.i}`) !== "yes") continue;
    const name = form.get(`name_${row.i}`), choice = form.get(`match_${row.i}`);
    if (choice === "skip") continue;
    const rowKey = `name_${row.i}`, matchKey = `match_${row.i}`;
    let rowValid = true;
    if (typeof name !== "string" || !name.trim()) { issue(rowKey, "Enter a name."); rowValid = false; }
    if (!CURRENCIES.includes(row.cur)) { issue(matchKey, "Unsupported currency; skip this row or correct it manually."); rowValid = false; }
    if (!safeMoney(row.m, row.cur)) { issue(rowKey, "Statement value is unreadable or unsafe; skip this row or enter it manually."); rowValid = false; }
    const h = choice === "new" ? null : get(choice);
    if (choice !== "new" && (!h || h.currency !== row.cur)) { issue(matchKey, `Choose an investment in ${row.cur}, create new, or skip.`); rowValid = false; }
    let holding = null;
    if (choice === "new") {
      const checked = collectHolding({ name, ticker: row.ticker, type: "other", currency: row.cur, mode: "value" });
      holding = checked.candidate;
      for (const [key, message] of Object.entries(checked.fields)) {
        issue(key === "name" || key === "ticker" ? rowKey : matchKey,
          key === "ticker" ? "Invalid ticker; skip this row or correct it manually." : message);
        rowValid = false;
      }
    }
    candidate.push({ row, name: typeof name === "string" ? name.trim() : "", choice, h, holding, rowValid });
  }
  if (dateValid) for (const x of candidate) {
    if (!CURRENCIES.includes(x.row.cur)) continue;
    const rate = resolveRate(x.row.cur, date, form.get(`rate_${x.row.cur}`), fields, `rate_${x.row.cur}`);
    if (x.rowValid && (x.row.cur === base() || rate)) try { x.snap = frozen(x.row.m, date, rate); }
    catch { issue(`rate_${x.row.cur}`, "Converted amount is too large to save safely."); }
  }
  const { rate_pair, ...visibleFields } = fields;
  return { fields: visibleFields, rate_pair, candidate: { date, rows: candidate } };
}
// Newest first. Ten years of monthly values is 120 rows, so the latest twelve show and the rest wait
// behind "Every value".
function valuesCard(vs) {
  const row = (v) => `<tr><td>${D.fmtDateShort(v.date)}</td><td class="num">${fmt(v.value)}</td><td>${cap(v.source)}</td></tr>`;
  const newest = [...vs].reverse(), head = newest.slice(0, 12), rest = newest.slice(12);
  return `<div class="card"><h2>Values</h2><table>${head.map(row).join("")}</table>${rest.length ? `<details><summary>Every value (${newest.length})</summary><table>${rest.map(row).join("")}</table></details>` : ""}</div>`;
}
export function investmentDetailPage(id) {
  const h = get(id); if (!h) return { title: "Investment", html: "<div class='empty'>Not found</div>", bind() {} };
  const p = position(h), ts = trades(id).reverse(), fl = flows(id).reverse(), vs = vals(id);
  return {
    title: h.name,
    html: html`${raw(disclaimerBlock())}
      <div class="grid2"><div class="stat"><div class="label">Latest value${p.asOf ? " · as of " + D.fmtDateShort(p.asOf) : ""}</div><div class="value">${p.latestValue ? fmt(p.latestValue) : "—"}</div></div>
      <div class="stat"><div class="label">P&L</div><div class="value">${p.pnl ? fmt(p.pnl, { sign: true }) : "—"}</div><div class="sub">${p.pnlReason || (h.mode === "units" ? "value − cost basis" : "value − net contributed")}</div></div>
      ${h.mode === "units" ? raw(`<div class="stat"><div class="label">Units · avg cost</div><div class="value">${fmtUnits(p.units)}</div><div class="sub">avg ${p.avgCost ? fmt(p.avgCost) : "—"} · cost basis ${fmt(p.costBasis)}</div></div><div class="stat"><div class="label">Realised (sold)</div><div class="value">${fmt(p.realised, { sign: true })}</div></div>`) : raw(`<div class="stat"><div class="label">Net contributed</div><div class="value">${p.netContributed ? fmt(p.netContributed) : "—"}</div></div>`)}</div>
      <div class="actions">${h.mode === "units" ? raw('<button class="primary" data-action="buy">Buy</button><button data-action="sell">Sell</button>') : ""}<button data-action="deposit">Deposit</button><button data-action="withdraw">Withdraw</button><button class="primary" data-action="value">Set value</button><button class="danger" data-action="close">${h.status === "closed" ? "Archive" : "Close"}</button></div>
      ${ts.length ? raw(`<div class="card"><h2>Trades</h2><table>${ts.map((t) => `<tr><td>${D.fmtDateShort(t.date)}</td><td>${cap(t.kind)}</td><td class="num">${t.units} @ ${fmt(t.price)}</td><td class="num">${t.fees ? "fees " + fmt(t.fees) : ""}</td></tr>`).join("")}</table></div>`) : ""}
      ${fl.length ? raw(`<div class="card"><h2>Deposits & withdrawals</h2><table>${fl.map((t) => `<tr><td>${D.fmtDateShort(t.date)}</td><td>${cap(t.kind)}</td><td class="num">${fmt(t.money)}</td></tr>`).join("")}</table></div>`) : ""}
      ${vs.length ? raw(valuesCard(vs)) : ""}`,
    bind(root) {
      const entryModal = (options) => bindRateField(modal(options), h);
      const tradeModal = (kind) => { let prepared; const read = f => (prepared = collectTrade(h.id, kind, f.get("date"), f.get("units"), parseMoney(f.get("price"), h.currency), parseMoney(f.get("fees"), h.currency), f.get("rate"), f.get("fees"))); const dialog = entryModal({ title: kind === "buy" ? "Buy" : "Sell", body: `<div class="inline">${field("Units", inp("units", { type: "number", step: "any", required: true }))}${field("Price per unit (" + h.currency + ")", moneyInput("price"))}</div><div class="inline">${field("Fees", moneyInput("fees"))}${field("Date", inp("date", { type: "date", value: today() }))}</div>${rateField(h)}`, onSubmit: () => { const result = prepared; if(Object.keys(result.fields).length) throw new ValidationError({fields:result.fields,rate_pair:result.rate_pair}); const c=result.candidate; store.insert("trades", {holding_id:h.id,kind,date:c.date,units:c.units,price:c.price,fees:c.fees,base_money:c.snap.base_money,fx:c.snap.fx,transaction_id:null}); toast("Recorded"); } }); bindValidation(dialog.form,{validate:f=>read(f),dependencies:{date:["rate"],units:["price","fees"],price:["units","fees"],fees:["price","units"]}}); return dialog; };
      root.querySelector("[data-action=buy]")?.addEventListener("click", () => tradeModal("buy"));
      root.querySelector("[data-action=sell]")?.addEventListener("click", () => tradeModal("sell"));
      const flowModal = (kind) => { let prepared; const read=f=>(prepared=collectEntry(h.id,kind,f.get("date"),parseMoney(f.get("amount"),h.currency),f.get("rate"),true)); const dialog=entryModal({ title:cap(kind),body:`<div class="inline">${field("Amount ("+h.currency+")",moneyInput("amount"))}${field("Date",inp("date",{type:"date",value:today()}))}</div>${rateField(h)}`,onSubmit:()=>{const result=prepared;if(Object.keys(result.fields).length)throw new ValidationError({fields:result.fields,rate_pair:result.rate_pair});const c=result.candidate;store.insert("cash_flows",{holding_id:h.id,kind,date:c.date,money:c.money,base_money:c.snap.base_money,fx:c.snap.fx,transaction_id:null});}});bindValidation(dialog.form,{validate:read,dependencies:{date:["rate"],amount:["rate"]}});return dialog;};
      root.querySelector("[data-action=deposit]").onclick = () => flowModal("deposit");
      root.querySelector("[data-action=withdraw]").onclick = () => flowModal("withdrawal");
      root.querySelector("[data-action=value]").onclick = () => valueModal(h.id);
      root.querySelector("[data-action=close]").onclick = () => modal({ title: h.status === "closed" ? "Archive?" : "Close position?", body: "<p>History kept.</p>", submitLabel: "Yes", danger: true, onSubmit: () => { update(h.id, { status: h.status === "closed" ? "archived" : "closed" }); }, onSuccess: () => { location.hash = "#/investments"; } });
    },
  };
}

// Manual rates only. Current calculations may change; saved snapshots never do.
import { store, nowIso } from "./store.js";
import { convert, exponent, CURRENCIES } from "./money.js";
import { todayIn, deviceTz, daysBetween } from "./dates.js";

const today = () => todayIn(store.one("profile")?.timezone || deviceTz());
export function validatePair(from, to) {
  if (!CURRENCIES.includes(from) || !CURRENCIES.includes(to)) throw new Error("Choose two supported currencies.");
  if (from === to) throw new Error("Choose two different currencies. A currency already equals itself.");
}
export function validateRate(value) {
  const rate = String(value ?? "").trim();
  // Ordinary decimals only: no exponent notation, signs, zero, Infinity or rounded-away inputs.
  if (!/^\d+(\.\d+)?$/.test(rate) || rate.length > 40 || !Number.isFinite(Number(rate)) || Number(rate) <= 0) throw new Error("Enter an exchange rate above zero, such as 1.30 or 0.0091.");
  return rate;
}
export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today()) throw new Error("Choose a valid date, today or earlier.");
  return date;
}
const validRow = (r) => {
  try { validatePair(r.from, r.to); validateRate(r.rate); return r.source === "user" && !r.deleted_at; } catch { return false; }
};
const newest = (rows) => rows.reduce((best, r) => !best || r.fetched_at >= best.fetched_at ? r : best, null);

// The old public name remains for callers. There is no fetching, expiry or automatic refresh.
export function liveRate(from, to) {
  if (from === to) return { rate: "1", source: "same", fetched_at: nowIso() };
  return newest(store.all("fx_rates").filter((r) => r.from === from && r.to === to && !r.on && validRow(r)));
}
export function setUserRate(from, to, value) {
  validatePair(from, to); const rate = validateRate(value);
  return store.insert("fx_rates", { from, to, rate, source: "user", fetched_at: nowIso() });
}
export function setUserRateOn(from, to, date, value) {
  validatePair(from, to); validateDate(date); const rate = validateRate(value);
  return store.insert("fx_rates", { from, to, rate, source: "user", on: date, fetched_at: nowIso() });
}

// Explicit historical rates only. Keep the approved seven-day, preceding-rate window.
// A future rate, including today's current rate, never stands in for a past day.
export function rateOn(from, to, date) {
  if (from === to) return { rate: "1", source: "same" };
  const rows = store.all("fx_rates").filter((r) => r.from === from && r.to === to && validRow(r) && r.on && r.on <= date && daysBetween(r.on, date) <= 7);
  return rows.reduce((best, r) => !best || r.on > best.on || (r.on === best.on && r.fetched_at >= best.fetched_at) ? r : best, null);
}
export const rateAt = (from, to, date, currentDay = today()) => date === currentDay ? (liveRate(from, to) || rateOn(from, to, date)) : rateOn(from, to, date);
export const missingRateReason = (from, to, date) => `Exchange rate missing: ${from} → ${to}${date ? ` for ${date}` : ""}`;
export const rateUrl = (from, to, date) => `#/settings?${new URLSearchParams({ "rate-from": from, "rate-to": to, ...(date ? { "rate-date": date } : {}) })}`;
export function missingRateError(from, to, date) {
  const err = new Error(`${missingRateReason(from, to, date)}. Enter it in Settings or type it here.`);
  err.rate_pair = { from, to, date }; return err;
}

// Current totals use current manual rates; a dated read uses only its allowed historical rate.
export function toBase(m, base, date = null) {
  if (!m) return { money: null, rate: null, reason: "amount absent" };
  if (m.currency === base) return { money: m, rate: null };
  const r = date ? rateAt(m.currency, base, date, today()) : liveRate(m.currency, base);
  if (!r) return { money: null, rate: null, reason: missingRateReason(m.currency, base, date) };
  const converted = convert(m, base, r.rate);
  if (!Number.isSafeInteger(m.amount) || !Number.isSafeInteger(converted.amount)) return { money: null, rate: r, reason: `Amount too large to convert safely: ${m.currency} → ${base}` };
  return { money: converted, rate: r };
}
function freeze(m, base, r, date) {
  if (!r) return { base_money: null, fx: null };
  validatePair(m.currency, base);
  const baseMoney = convert(m, base, r.rate);
  if (!Number.isSafeInteger(m.amount) || !Number.isSafeInteger(baseMoney.amount)) throw new Error("That conversion is too large to save safely. Check the amount and rate.");
  return { base_money: baseMoney, fx: { from: m.currency, to: base, rate: r.rate, source: "user", at: nowIso(), ...(date ? { on: date } : {}) } };
}
const typed = (value) => value == null || value === "" ? null : { rate: validateRate(value), source: "user" };
export function snapshotFor(m, base, userRate) {
  if (m.currency === base) return { base_money: m, fx: null };
  return freeze(m, base, typed(userRate) || liveRate(m.currency, base));
}
export function snapshotOn(m, base, date, userRate) {
  if (m.currency === base) return { base_money: m, fx: null };
  validateDate(date);
  const r = typed(userRate) || rateOn(m.currency, base, date);
  if (!r) return null;
  const snap = freeze(m, base, r, date);
  // Keep the historical snapshot's existing field order (also used by the fixed demo fixture).
  const { at, on, ...fields } = snap.fx;
  return { ...snap, fx: { ...fields, on, at } };
}
export function snapshotAt(m, base, date, currentDay = today(), userRate) {
  if (m.currency === base) return { base_money: m, fx: null };
  validateDate(date);
  if (date < currentDay && !userRate) return snapshotOn(m, base, date) || { base_money: null, fx: null };
  return freeze(m, base, typed(userRate) || rateAt(m.currency, base, date, currentDay), date);
}

// Visibility is based on financial data, not an unused cached pair, AI text or old preferences.
// Nested Money covers entered prices, imported drafts, extras and old snapshots after a base change.
const FOREIGN_TABLES = ["accounts", "transactions", "recurring_rules", "import_batches", "holdings", "trades", "cash_flows", "valuations", "nw_extras", "nw_snapshots", "goals", "goal_contributions", "debts", "debt_payments", "policies", "budgets", "reconciliations"];
export function foreignCurrencies(base) {
  const currencies = new Set();
  const visit = (v) => {
    if (!v || typeof v !== "object") return;
    if (CURRENCIES.includes(v.currency) && v.currency !== base) currencies.add(v.currency);
    for (const x of Object.values(v)) if (x && typeof x === "object") visit(x);
  };
  for (const table of FOREIGN_TABLES) for (const row of store.all(table)) visit(row);
  return [...currencies].sort();
}
export const impliedRate = (out, inn) => {
  if (!out || !inn || out.amount === 0) return null;
  const v = (inn.amount / 10 ** exponent(inn.currency)) / (out.amount / 10 ** exponent(out.currency));
  return v.toFixed(6);
};

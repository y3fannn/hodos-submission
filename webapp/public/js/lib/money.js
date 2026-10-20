// Money = {amount: integer minor units, currency: ISO 4217}. No floats in stored values.
const EXPONENT = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };
export const CURRENCIES = ["SGD", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "INR", "KRW", "MYR", "NZD", "PHP", "THB", "TWD", "VND", "IDR", "AED", "SEK", "NOK", "DKK", "ZAR", "BRL", "MXN"];

export const exponent = (c) => EXPONENT[c] ?? 2;
export const money = (amount, currency) => ({ amount, currency });
export const isMoney = (m) => m && Number.isInteger(m.amount) && typeof m.currency === "string";

// "12.34" SGD → 1234. Returns null when blank (absent ≠ zero).
export function parseMoney(text, currency) {
  if (text == null) return null;
  let s = String(text).trim().replace(/[,\s]/g, "").replace(/^[A-Za-z$€£¥₩]+/, "").replace(/[A-Za-z]+$/, "");
  if (s === "" || s === "-" || s === ".") return null;
  const neg = s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"));
  s = s.replace(/[()\-+]/g, "");
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const exp = exponent(currency);
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(exp)).slice(0, exp);
  const amount = Number(BigInt(whole || "0") * 10n ** BigInt(exp) + BigInt(fracPadded || "0"));
  return money(neg ? -amount : amount, currency);
}

export function toDecimalString(m) {
  if (!isMoney(m)) return "";
  const exp = exponent(m.currency);
  const neg = m.amount < 0;
  const abs = Math.abs(m.amount);
  const whole = Math.floor(abs / 10 ** exp);
  const frac = String(abs % 10 ** exp).padStart(exp, "0");
  return `${neg ? "-" : ""}${whole}${exp ? "." + frac : ""}`;
}

const fmtCache = {};
export function fmt(m, { sign = false } = {}) {
  if (!isMoney(m)) return "—";
  const key = m.currency;
  try {
    fmtCache[key] ||= new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency, currencyDisplay: "code" });
    const v = m.amount / 10 ** exponent(m.currency);
    const s = fmtCache[key].format(Math.abs(v)).replace(/ /g, " ");
    const signStr = v < 0 ? "−" : sign && v > 0 ? "+" : "";
    return signStr + s;
  } catch {
    return `${toDecimalString(m)} ${m.currency}`;
  }
}

// The unit and the amount are different information and deserve different weight.
// A column of amounts in one currency states its unit once, not on every row.
const bareCache = {};
export function fmtBare(m) {
  if (!isMoney(m)) return "—";
  const exp = exponent(m.currency);
  try {
    bareCache[m.currency] ||= new Intl.NumberFormat(undefined, { minimumFractionDigits: exp, maximumFractionDigits: exp });
    const v = m.amount / 10 ** exp;
    return (v < 0 ? "−" : "") + bareCache[m.currency].format(Math.abs(v));
  } catch { return toDecimalString(m); }
}
export const fmtSplit = (m) => (isMoney(m) ? { unit: m.currency, text: fmtBare(m) } : { unit: "", text: "—" });

export const add = (a, b) => {
  if (!isMoney(a) || !isMoney(b)) return null;
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return money(a.amount + b.amount, a.currency);
};
export const sub = (a, b) => (isMoney(a) && isMoney(b) ? add(a, money(-b.amount, b.currency)) : null);
export const neg = (a) => (isMoney(a) ? money(-a.amount, a.currency) : null);
export const zero = (c) => money(0, c);
export const sum = (list, currency) => list.reduce((acc, m) => (acc && isMoney(m) ? add(acc, m) : null), zero(currency));

// rate = decimal string. amount × rate, exponent-adjusted, integer result via BigInt.
export function convert(m, toCurrency, rate) {
  if (!isMoney(m) || rate == null) return null;
  if (m.currency === toCurrency) return money(m.amount, toCurrency);
  const [w, f = ""] = String(rate).split(".");
  const scale = f.length;
  const rateInt = BigInt(w + f);
  const expFrom = exponent(m.currency), expTo = exponent(toCurrency);
  let num = BigInt(m.amount) * rateInt * 10n ** BigInt(expTo);
  let den = 10n ** BigInt(scale + expFrom);
  const q = num / den, r = num % den;
  const rounded = (r * 2n >= den ? q + 1n : r * 2n <= -den ? q - 1n : q);
  return money(Number(rounded), toCurrency);
}

// Percentage as integer 0–100+ of a/b in same currency; null when absent.
export const pct = (a, b) => (isMoney(a) && isMoney(b) && b.amount !== 0 ? Math.round((a.amount / b.amount) * 100) : null);

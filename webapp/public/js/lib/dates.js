// Calendar dates YYYY-MM-DD in profile timezone. Timestamps UTC ISO.
export function todayIn(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
export const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const parse = (d) => { const [y, m, dd] = d.split("-").map(Number); return { y, m, d: dd }; };
export const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const toUtc = (d) => { const { y, m, d: dd } = parse(d); return Date.UTC(y, m - 1, dd); };
export const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => fromUtc(toUtc(d) + n * 86400000);
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
export function addMonths(d, n, anchorDay) {
  const { y, m, d: dd } = parse(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? dd, daysInMonth(ny, nm));
  return iso(ny, nm, day);
}
export const clampDay = (y, m, day) => iso(y, m, Math.min(day, daysInMonth(y, m)));
export const weekday = (d) => new Date(toUtc(d)).getUTCDay(); // 0=Sun
export const monthKey = (d) => d.slice(0, 7);
export function monthsBetween(a, b) { const A = parse(a), B = parse(b); return (B.y - A.y) * 12 + (B.m - A.m); }
export function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(toUtc(d)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); } catch { return d; }
}
export function fmtDateShort(d) {
  if (!d) return "—";
  try { return new Date(toUtc(d)).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }); } catch { return d; }
}
// A point on a time axis. Inside a year or two a day and a month say it; once the line runs longer
// than that the day is noise and the year is the thing you need, so the label changes with the span.
export function fmtAxis(d, spanDays = 0) {
  if (!d) return "—";
  const opts = spanDays > 730 ? { month: "short", year: "2-digit", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" };
  try { return new Date(toUtc(d)).toLocaleDateString(undefined, opts); } catch { return d; }
}
// Budget month: starts on start_day. Returns {start, end} containing date d.
export function budgetMonth(d, startDay) {
  const { y, m, d: dd } = parse(d);
  const s = Math.min(startDay, daysInMonth(y, m));
  let start;
  if (dd >= s) start = iso(y, m, s);
  else { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; start = clampDay(py, pm, startDay); }
  const { y: sy, m: sm } = parse(start);
  const nm = sm === 12 ? 1 : sm + 1, ny = sm === 12 ? sy + 1 : sy;
  const end = addDays(clampDay(ny, nm, startDay), -1);
  return { start, end };
}
export const prevBudgetMonth = (bm, startDay) => budgetMonth(addDays(bm.start, -1), startDay);
export const inRange = (d, r) => d >= r.start && d <= r.end;

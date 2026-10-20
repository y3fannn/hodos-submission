// Insights: dashboard (code only), briefing (AI words over code numbers), deep dive.
import { store, nowIso } from "../lib/store.js";
import { featurePaused, pausedPage } from "../lib/feature-policy.js";
import { money, fmt, sub, toDecimalString, exponent, parseMoney } from "../lib/money.js";
import * as D from "../lib/dates.js";
import { html, raw, toast, esc, field, sel, lineChart, bindCharts, rankedBars, aiMade, rateLinks, commitAction } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { base, today, profile } from "./profile.js";
import * as C from "./categories.js";
import * as T from "./transactions.js";
import * as B from "./budgets.js";
import * as NW from "./networth.js";
import * as G from "./goals.js";
import * as H from "./investments.js";
import * as AL from "./alerts.js";

const sumBase = (txs) => T.baseTotals(txs).total;
const spendIn = (r) => T.live().filter((t) => t.kind === "expense" && D.inRange(t.date, r));
const incomeIn = (r) => T.live().filter((t) => t.kind === "income" && D.inRange(t.date, r));
const hasHistoryBefore = (date) => T.live().some((t) => t.date < date);

export function dashboard() {
  const m = B.month(), pm = B.prevMonth(m);
  const spend = sumBase(spendIn(m)), lastSpend = sumBase(spendIn(pm)), inc = incomeIn(m), income = inc.length ? sumBase(inc) : null;
  const lastInc = incomeIn(pm);
  const sv = B.savings(m);
  const bills = T.upcoming(today(), D.addDays(today(), store.one("insight_settings")?.bills_days ?? 14)).map((u) => ({ ...u, base: (u.money.currency === base() ? u.money : null) }));
  const nw = NW.now(), last = NW.priorMonthly();
  const nwChange = nw.total && last?.total && last.base_currency === base() ? sub(nw.total, last.total) : null;
  const goals = G.list("active").map((g) => ({ g, s: G.status(g) }));
  const uncat = T.live().filter((t) => t.kind !== "transfer" && !t.category_id).length;
  return { month: m, spend, lastSpend, income, lastIncome: lastInc.length ? sumBase(lastInc) : null, saved: sv.saved, savingsRate: sv.rate, budgets: B.status(m), bills, nw, nwChange, lastSnapshot: last, goals, uncat, unread: AL.unread().length, hasLast: hasHistoryBefore(m.start) };
}

// ---------- briefing ----------
// The briefing works towards one thing: a bigger net worth. The app can do little about money coming
// in, so it looks at money going out, and puts the easiest, biggest saving first (ruled 2026-09-19).
// Code finds every lever and does every sum. The model picks two or three, in the order given, and
// writes the words. The one judgement it makes is which subscriptions do the same job; it names them
// by id, and code adds up what they cost together. Nothing it says is stored beyond the briefing.
const EFFORT_ORDER = { low: 0, medium: 1, high: 2 };
export const EFFORT_LABEL = { low: "Easy", medium: "Some effort", high: "A habit" };
const txt = (minor) => toDecimalString(money(Math.round(minor), base()));
const lastN = (period, n) => { const out = []; let p = period; for (let i = 0; i < n; i++) { p = B.prevMonth(p); out.push(p); } return out; };
const groupName = (t) => C.groupOf(C.get(t.category_id))?.name || "Uncategorised";

export function statsFor(period) {
  const prev = B.prevMonth(period), before = lastN(period, 3);
  const byCat = (txs) => { const o = {}; for (const t of txs) { const k = groupName(t); o[k] = (o[k] || 0) + (T.baseAmount(t)?.amount || 0); } return o; };
  const incomplete = [...new Set([period, prev, ...before].flatMap((r) => T.baseTotals([...spendIn(r), ...incomeIn(r)]).reasons))];
  const cur = byCat(spendIn(period)), last = byCat(spendIn(prev));
  const usual = {}; for (const r of before) for (const [k, v] of Object.entries(byCat(spendIn(r)))) usual[k] = (usual[k] || 0) + v / before.length;
  const categories = incomplete.length ? [] : Object.keys({ ...cur, ...last }).map((name) => ({ name, this_period: txt(cur[name] || 0), last_period: txt(last[name] || 0), usual_3_months: txt(usual[name] || 0) })).sort((a, c) => Number(c.this_period) - Number(a.this_period));
  const merch = {}; for (const t of spendIn(period)) if (t.merchant) merch[t.merchant] = (merch[t.merchant] || 0) + (T.baseAmount(t)?.amount || 0);
  const merchants = incomplete.length ? [] : Object.entries(merch).sort((a, c) => c[1] - a[1]).slice(0, 10).map(([name, a]) => ({ name, amount: txt(a) }));
  const budgets = B.status(period).map((s) => ({ name: s.name, limit: s.limit ? toDecimalString(s.limit) : null, spent: s.spent ? toDecimalString(s.spent) : null, pct: s.pct }));
  const sv = B.savings(period);
  const nw = NW.now(), snaps = NW.snapshots().filter((s) => s.trigger === "monthly" && s.total && s.base_currency === base());
  const nwPrev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const goals = G.list("active").map((g) => { const s = G.status(g); return { name: g.name, progress: s.progress ? toDecimalString(s.progress) : null, target: toDecimalString(g.target), needed_per_month: s.monthlyNeeded ? toDecimalString(s.monthlyNeeded) : null }; });
  const hs = H.summary();
  return { period, currency: base(), incomplete_reasons: incomplete, categories, merchants, budgets, savings: { income: sv.income ? toDecimalString(sv.income) : null, spent: sv.spent ? toDecimalString(sv.spent) : null, saved: sv.saved ? toDecimalString(sv.saved) : null, target: sv.target ? toDecimalString(sv.target) : null, rate_pct: sv.rate }, net_worth: { now: nw.total ? toDecimalString(nw.total) : null, change_since_last_month: nw.total && nwPrev ? toDecimalString(sub(nw.total, nwPrev.total)) : null }, goals, investments_total: hs.totalBase ? toDecimalString(hs.totalBase) : null };
}

// Every lever carries its effort, what it is worth in a year, and its maths as label + amount text.
// Ranked easiest first, then biggest, so "low effort, high impact" leads.
export function leversFor(period, st = statsFor(period)) {
  const L = [];
  if (st.incomplete_reasons?.length) return L;
  const push = (l) => L.push({ ...l, yearly_text: txt(l.yearly) });
  const spend = spendIn(period);
  const subs = T.subscriptions().filter((x) => x.perMonth);
  // 1. Every subscription, listed. Many people pay for things they have forgotten.
  if (subs.length) {
    const t = T.subscriptionTotals(subs);
    push({ id: "subscriptions", effort: "low", yearly: t.perYear.amount, title: `Your ${t.count} subscription${t.count === 1 ? "" : "s"}`,
      maths: [...subs.slice(0, 12).map((x) => ({ label: `${x.name}${x.found ? " (noticed, not set up)" : ""}, a month`, amount_text: toDecimalString(x.perMonth) })), { label: "All of them, a month", amount_text: toDecimalString(t.perMonth) }, { label: "All of them, a year", amount_text: toDecimalString(t.perYear) }] });
  }
  // 2. Regular payments that started in the last two months: a free trial that turned paid looks like this.
  const since = (x) => x.since || T.live().filter((t) => t.recurring_rule_id === x.rule.id).map((t) => t.date).sort()[0] || null;
  const fresh = subs.filter((x) => { const f = since(x); return f && D.daysBetween(f, period.end) <= 60; });
  if (fresh.length) push({ id: "new_recurring", effort: "low", yearly: fresh.reduce((t, x) => t + x.perYear.amount, 0), title: `${fresh.length} regular payment${fresh.length === 1 ? "" : "s"} started recently`,
    maths: fresh.map((x) => ({ label: `${x.name}, since ${since(x)}, a year`, amount_text: toDecimalString(x.perYear) })) });
  // 3. A subscription whose price went up in the last year.
  const rises = [];
  for (const x of subs.filter((x) => x.rule)) {
    const posts = T.live().filter((t) => t.recurring_rule_id === x.rule.id && T.baseAmount(t) && D.daysBetween(t.date, period.end) <= 395).sort((a, b) => a.date.localeCompare(b.date));
    if (posts.length < 2) continue;
    const now = T.baseAmount(posts[posts.length - 1]).amount, was = [...posts].reverse().find((t) => T.baseAmount(t).amount !== now)?.base_money.amount;
    if (was != null && now > was) rises.push({ x, was, now, extra: Math.round((now - was) * T.perMonthFactor(x.rule) * 12) });
  }
  if (rises.length) push({ id: "price_rise", effort: "low", yearly: rises.reduce((t, r) => t + r.extra, 0), title: `${rises.length === 1 ? "A price" : `${rises.length} prices`} went up`,
    maths: rises.flatMap((r) => [{ label: `${r.x.name}, before`, amount_text: txt(r.was) }, { label: `${r.x.name}, now`, amount_text: txt(r.now) }, { label: `${r.x.name}, extra a year`, amount_text: txt(r.extra) }]) });
  // 4. Fees and interest: money that buys nothing. Taxes are left out, being nobody's choice.
  const feeRows = {};
  for (const t of spend) { const c = C.get(t.category_id); if (groupName(t) !== "Fees & taxes" || /tax/i.test(c?.parent_id ? c.name : "")) continue; const k = c?.parent_id ? c.name : "Fees & taxes"; feeRows[k] = (feeRows[k] || 0) + (T.baseAmount(t)?.amount || 0); }
  const fees = Object.values(feeRows).reduce((a, b) => a + b, 0);
  if (fees > 0) push({ id: "fees", effort: "low", yearly: fees * 12, title: "Fees and interest",
    maths: [...Object.entries(feeRows).map(([k, v]) => ({ label: `${k}, this period`, amount_text: txt(v) })), { label: "A year, if every month were like this", amount_text: txt(fees * 12) }] });
  // 5. The same shop, the same amount, the same day, more than once: possibly charged twice.
  const seen = {};
  for (const t of spend) { if (!t.merchant || !T.baseAmount(t)) continue; const k = `${C.normaliseMerchant(t.merchant)}|${T.baseAmount(t).amount}|${t.date}`; (seen[k] ||= []).push(t); }
  const dups = Object.values(seen).filter((g) => g.length > 1);
  if (dups.length) push({ id: "double_charge", effort: "low", yearly: dups.reduce((t, g) => t + T.baseAmount(g[0]).amount * (g.length - 1), 0), title: `${dups.length === 1 ? "A possible" : `${dups.length} possible`} double charge${dups.length === 1 ? "" : "s"}`,
    maths: dups.map((g) => ({ label: `${g[0].merchant} on ${g[0].date}, ${g.length} times`, amount_text: txt(T.baseAmount(g[0]).amount) })) });
  // 6. A category well above its usual: this period against the average of the three before it.
  const rise = st.categories.map((c) => ({ c, up: Math.round((Number(c.this_period) - Number(c.usual_3_months)) * 10 ** exponent(base())) })).filter((r) => Number(r.c.usual_3_months) > 0 && r.up > 0 && r.up >= 0.1 * Number(r.c.usual_3_months) * 10 ** exponent(base())).sort((a, b) => b.up - a.up).slice(0, 2);
  for (const r of rise) push({ id: `rise:${r.c.name}`, effort: "medium", yearly: r.up * 12, title: `${r.c.name} above your usual`,
    maths: [{ label: "This period", amount_text: r.c.this_period }, { label: "Your usual, the 3 before", amount_text: r.c.usual_3_months }, { label: "Above usual", amount_text: txt(r.up) }, { label: "A year, if it stayed there", amount_text: txt(r.up * 12) }] });
  // 7. Over budget.
  for (const b of B.status(period)) if (b.limit && b.pct >= 100) { const over = b.spent.amount - b.limit.amount; push({ id: `over:${b.name}`, effort: "medium", yearly: over * 12, title: `${b.name} over budget`,
    maths: [{ label: "Limit", amount_text: toDecimalString(b.limit) }, { label: "Spent", amount_text: toDecimalString(b.spent) }, { label: "Over by", amount_text: txt(over) }] }); }
  // 8. Small spends that add up: one place, many visits.
  const visits = {};
  for (const t of spend) if (t.merchant && T.baseAmount(t)) { const k = C.normaliseMerchant(t.merchant); (visits[k] ||= { name: t.merchant, n: 0, total: 0 }); visits[k].n++; visits[k].total += T.baseAmount(t).amount; }
  for (const v of Object.values(visits).filter((v) => v.n >= 8).sort((a, b) => b.total - a.total).slice(0, 2)) push({ id: `habit:${v.name}`, effort: "high", yearly: v.total * 12, title: `${v.n} visits to ${v.name}`,
    maths: [{ label: "Visits this period", amount_text: String(v.n) }, { label: "Spent there", amount_text: txt(v.total) }, { label: "A year, at this rate", amount_text: txt(v.total * 12) }] });
  return L.sort((a, b) => EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || b.yearly - a.yearly).slice(0, 6);
}

// The instructions the briefing model runs under. The design note docs/design/2026-09-19-insights.md
// carries the reasoning; this string is the one that is sent.
export const BRIEFING_PROMPT = `You write a short money briefing for one person, once a period. The aim of this app is to help them grow their net worth. They earn what they earn; what the app can help with is the money going out. So you look for savings, and the easiest, biggest saving always comes first.

You receive:
- background: where their money went this period, by category, against last period and their usual; their savings, goals and net worth.
- levers: savings the app's code has already found and priced, ranked easiest and biggest first. Each has an effort (low, medium, high), what it is worth in a year, and its maths.
- subscriptions: every regular payment, with an id, a name and what it costs a month. set_up is false for one the app noticed repeating in their records that they have not set up; they may not know they are paying it, so it is worth naming.

Do this:
1. Pick 2 or 3 levers. Keep them in the order given. Skip one only if there is nothing useful to say about it.
2. For each, write one short paragraph: what the numbers show, then the choices they have, one of which is always to leave it as it is.
3. Look through the subscriptions for any that do the same job: two video streaming services, two music services, two cloud storage plans, two gyms. Return each group in "overlaps" by id, with a few words for the job they share. Name them in your writing if the subscriptions lever is one you picked. Never say what a group costs together; the app adds that up and shows it.
4. On top, write a summary of two sentences: where most of the money went, and the single easiest saving.

Rules:
- Use only numbers that appear in the input, written exactly as they appear there. Never add, subtract, multiply, round or convert. If you want a number the input does not have, say it in words instead.
- Give choices, never orders. Never write should, must, need to, or have to.
- Never guess why they spent something. Say what the numbers show.
- Nothing about investments beyond the total, and never anything about buying, selling or holding.
- Plain, friendly words a 15-year-old would follow. Short sentences. No jargon.
- The self-description says who they are. Use it to pick examples that fit their life, never to assume their income or their family.`;

// Exactly what the model sees, and the levers behind it. Subscriptions go by merchant name and price,
// the same kind of thing as the top merchants already sent; never notes or account names.
export function briefingInput(period) {
  const st = statsFor(period), levers = leversFor(period, st);
  const subs = T.subscriptions().filter((x) => x.perMonth).map((x) => ({ id: x.id, name: x.name, per_month: toDecimalString(x.perMonth), set_up: !x.found }));
  return { levers, input: { period, self_description: profile()?.self_description, currency: base(), background: st, levers: levers.map(({ id, title, effort, yearly_text, maths }) => ({ id, title, effort, yearly_text, maths })), subscriptions: subs } };
}
export function validateBriefing(o, input) {
  const ids = input.levers.map((l) => l.id);
  const want = Math.min(2, ids.length);
  if (o.options.length < want || o.options.length > 3) return "2–3 options required";
  let last = -1;
  for (const op of o.options) {
    const i = ids.indexOf(op.lever_id);
    if (i < 0) return "unknown lever";
    if (i <= last) return "levers out of the order given";
    last = i;
    const p = ai.validateProse(op.prose, input); if (p) return p;
  }
  const subIds = new Set(input.subscriptions.map((x) => x.id)), used = new Set();
  for (const g of o.overlaps || []) {
    if (!Array.isArray(g.ids) || g.ids.length < 2) return "an overlap needs two or more subscriptions";
    for (const id of g.ids) { if (!subIds.has(id)) return "unknown subscription in overlaps"; if (used.has(id)) return "a subscription in two overlaps"; used.add(id); }
    const k = ai.validateProse(g.kind || "", input); if (k) return k;
  }
  return ai.validateProse(o.summary, input);
}
// What overlapping subscriptions cost together. The model grouped them; code does the sum.
export function overlapCosts(overlaps) {
  const subs = T.subscriptions();
  return (overlaps || []).map((g) => { const items = g.ids.map((id) => subs.find((x) => x.id === id)).filter((x) => x?.perMonth); const m = items.reduce((t, x) => t + x.perMonth.amount, 0), y = items.reduce((t, x) => t + x.perYear.amount, 0); return { kind: g.kind, names: items.map((x) => x.name), perMonth: money(m, base()), perYear: money(y, base()) }; }).filter((g) => g.names.length > 1);
}
export async function buildBriefing(period, { isCurrent = () => true, inMemoryOnly = false } = {}) {
  if (featurePaused("briefings")) return null;
  const generation = store.generation();
  const stillOwned = () => generation === store.generation() && isCurrent();
  const { input, levers } = briefingInput(period);
  const row = { period: { kind: "month", ...period }, stats: input.background, levers, options: [], overlaps: [], summary: null, generated_at: nowIso(), read_at: null, failed_reason: null };
  if (input.background.incomplete_reasons.length) { row.failed_reason = input.background.incomplete_reasons.join("; "); }
  else if (!ai.enabled()) { row.failed_reason = ai.whyDisabled(); }
  else if (!levers.length) { row.failed_reason = "nothing to save on this period"; }
  else {
    try {
      const out = await ai.call("write_briefing", { tier: "strong", max_tokens: 2000, system: BRIEFING_PROMPT, input,
        schema: { type: "object", required: ["summary", "options"], properties: { summary: { type: "string" }, options: { type: "array", items: { type: "object", required: ["lever_id", "prose"], properties: { lever_id: { type: "string" }, prose: { type: "string" } } } }, overlaps: { type: "array", items: { type: "object", required: ["ids", "kind"], properties: { ids: { type: "array", items: { type: "string" } }, kind: { type: "string" } } } } } },
        validate: (o) => validateBriefing(o, input) });
      row.summary = out.summary; row.overlaps = overlapCosts(out.overlaps);
      row.options = out.options.map((o) => { const l = levers.find((x) => x.id === o.lever_id); return { title: l.title, effort: l.effort, yearly_text: l.yearly_text, maths: l.maths, prose: o.prose, lever_id: l.id }; });
    } catch (e) { row.failed_reason = e.message; }
  }
  if (!row.options.length) row.options = levers.slice(0, 3).map((l) => ({ title: l.title, effort: l.effort, yearly_text: l.yearly_text, maths: l.maths, prose: null, lever_id: l.id }));
  if (!stillOwned()) return null;
  const receipt = store.captureAction(`briefing:${period.start}:${crypto.randomUUID()}`, () => {
    const saved = store.insert("briefings", row);
    AL.fire({ type: "briefing_ready", source: { feature: "insights", entity_id: saved.id }, dedupe_key: `briefing:${period.start}`, title: `Briefing ready: ${D.fmtDateShort(period.start)} – ${D.fmtDateShort(period.end)}`, body: row.failed_reason ? "Numbers only; words unavailable." : row.summary.slice(0, 120) });
    return saved;
  });
  if (receipt.changed && !inMemoryOnly) {
    await store.commit(receipt);
    if (receipt.state !== "durable") throw new Error("Device storage did not confirm this briefing save.");
  }
  return receipt.value;
}
export async function briefingDue({ inMemoryOnly = false } = {}) {
  if (featurePaused("briefings")) return null;
  const cur = B.month(), last = B.prevMonth(cur);
  if (store.all("briefings").some((b) => b.period.start === last.start)) return null;
  if (!hasHistoryBefore(last.start) || !T.live().some((t) => D.inRange(t.date, last))) return null;
  return buildBriefing(last, { inMemoryOnly });
}
export async function deepDive({ kind, id, months = 3 }) {
  if (featurePaused("deepDive")) return null;
  const cur = B.month(); const periods = []; let p = cur; for (let i = 0; i < months; i++) { periods.push(p); p = B.prevMonth(p); }
  const filt = (t) => (kind === "category" ? C.subtreeIds(id).includes(t.category_id) : kind === "merchant" ? C.normaliseMerchant(t.merchant) === id : true);
  const byMonth = periods.reverse().map((r) => { const total = sumBase(spendIn(r).filter(filt)); return { month: r.start.slice(0, 7), total: total ? toDecimalString(total) : null }; });
  const all = periods.flatMap((r) => spendIn(r).filter(filt));
  const top = {}; for (const t of all) { const k = kind === "category" ? t.merchant || "(no merchant)" : C.labelId(t.category_id); top[k] = (top[k] || 0) + (T.baseAmount(t)?.amount || 0); }
  const totalAll = sumBase(periods.flatMap(spendIn)), totalSlice = sumBase(all);
  const incomplete = T.baseTotals(all).reasons;
  const stats = { slice: { kind, name: kind === "category" ? C.labelId(id) : id, months }, by_month: byMonth, incomplete_reasons: incomplete, top: incomplete.length ? [] : Object.entries(top).sort((a, c) => c[1] - a[1]).slice(0, 8).map(([name, a]) => ({ name, amount: toDecimalString(money(a, base())) })), total: totalSlice ? toDecimalString(totalSlice) : null, share_of_all_spend_pct: totalAll?.amount && totalSlice ? Math.round((totalSlice.amount / totalAll.amount) * 100) : null, count: all.length, currency: base() };
  let prose = null, reason = null;
  if (ai.enabled()) { try { const out = await ai.call("explain_deep_dive", { tier: "strong", system: "Explain these spending numbers in plain words. Use only numbers in the input, exactly as written. Never say should/must/need to. Describe; do not instruct.", input: stats, schema: { type: "object", required: ["prose"], properties: { prose: { type: "string" } } }, validate: (o) => ai.validateProse(o.prose, stats) }); prose = out.prose; } catch (e) { reason = e.message; } } else reason = ai.whyDisabled();
  return { stats, prose, reason };
}

// ---------- pages ----------
// The model is sent plain decimals ("2173.68") and its words are checked against them; the page shows
// the same amounts the way every other screen does ("SGD 2,173.68").
const shown = (text) => { if (text == null || text === "") return "—"; const m = parseMoney(text, base()); return m ? fmt(m) : String(text); };
export function briefingPage(id) {
  if (featurePaused("briefings")) return pausedPage("briefings");
  const all = store.all("briefings").sort((a, c) => c.period.start.localeCompare(a.period.start));
  const cur = id ? all.find((x) => x.id === id) : all[0];
  const generation = store.generation();
  const view = cur ? `<div class="card"><div class="ai-made-row"><h2 class="grow">${D.fmtDate(cur.period.start)} – ${D.fmtDate(cur.period.end)}</h2>${cur.summary ? aiMade() : ""}</div>${cur.summary ? `<p>${esc(cur.summary)}</p><p class="hint">The words are a model&#39;s. Every figure in them is the app&#39;s own.</p>` : `<p class="muted">No AI words this time: ${esc(cur.failed_reason || "")} The numbers below stand alone.</p>`}
      ${rateLinks(cur.stats.incomplete_reasons || [])}
      ${cur.options.map((o) => `<div class="card"><h3>${esc(o.title)}${o.effort ? `<span class="tag">${EFFORT_LABEL[o.effort]}</span>` : ""}</h3>${o.yearly_text ? `<p class="muted">Worth up to ${esc(shown(o.yearly_text))} a year</p>` : ""}<table>${o.maths.map((m) => `<tr><td>${esc(m.label)}</td><td class="num">${esc(/^Visits/.test(m.label) ? m.amount_text : shown(m.amount_text))}</td></tr>`).join("")}</table>${o.prose ? `<p>${esc(o.prose)}</p>` : ""}</div>`).join("")}
      ${cur.overlaps?.length ? `<div class="card"><h3>Subscriptions that do the same job</h3><table><tr><th></th><th class="num">A month</th><th class="num">A year</th></tr>${cur.overlaps.map((g) => `<tr><td>${esc(g.kind)}: ${esc(g.names.join(" + "))}</td><td class="num">${fmt(g.perMonth)}</td><td class="num">${fmt(g.perYear)}</td></tr>`).join("")}</table><p class="muted">The AI grouped these by what they do. The app added up the cost.</p></div>` : ""}
      ${cur.stats.investments_total ? `<p class="muted">Investments total ${esc(shown(cur.stats.investments_total))}.</p>${H.disclaimerBlock()}` : ""}
      <details><summary class="muted">Every number the AI saw</summary><pre style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify(cur.stats, null, 1))}</pre></details></div>` : `<div class="empty">No briefing yet.</div>`;
  return {
    title: "Briefing",
    html: html`<div class="actions"><button data-action="build">Build for last month now</button></div><p class="muted">Normally built once, on first open after a budget month ends. One AI call per period. ${ai.enabled() ? "" : "AI off: numbers only."}</p>${raw(view)}
      ${all.length > 1 ? raw(`<div class="card"><h2>Past</h2>${all.map((x) => `<div class="row clickable" data-b="${x.id}"><div class="grow"><div class="title">${D.fmtDateShort(x.period.start)} – ${D.fmtDateShort(x.period.end)}</div></div></div>`).join("")}</div>`) : ""}`,
    bind(root) {
      root.querySelector("[data-action=build]").onclick = async () => {
        const generation = store.generation(), hash = location.hash;
        const active = () => root.isConnected && generation === store.generation() && hash === location.hash;
        const last = B.prevMonth(B.month()), ex = store.all("briefings").find((b) => b.period.start === last.start);
        if (ex) {
          if (!(await import("../lib/ui.js")).confirm("Rebuild?", "A briefing for last month exists. This replaces the briefing with one based on the saved records. Continue?")) return;
          try { await commitAction(() => store.softDelete("briefings", ex.id)); } catch { return; }
        }
        if (!active()) return;
        toast("Building…");
        try { const saved = await buildBriefing(last, { isCurrent: active }); if (saved && active()) toast("Done"); }
        catch (error) { if (active()) toast(error.message); }
      };
      root.querySelectorAll("[data-b]").forEach((el) => (el.onclick = () => (location.hash = `#/briefing/${el.dataset.b}`)));
    },
    afterBind(root) {
      if (!root.isConnected || generation !== store.generation() || store.persistenceState().error || store.hasPendingCommit()) return;
      const row = cur && store.get("briefings", cur.id);
      if (!row || row.read_at) return;
      const receipt = store.captureAction(`briefing-read:${row.id}`, () => store.update("briefings", row.id, { read_at: nowIso() }));
      store.commit(receipt).catch(() => {}); // Global saving state owns bookkeeping failures; reading still works.
    },
  };
}
export function deepDivePage() {
  if (featurePaused("deepDive")) return pausedPage("deepDive");
  const cats = C.list("expense"); const merchants = [...new Set(T.live().map((t) => t.merchant).filter(Boolean))].sort();
  return {
    title: "Deep dive",
    html: html`<div class="card"><p class="muted">Pick a category or a shop to see where the money went, month by month. Leave both empty for all spending.</p><form data-form="dd"><div class="inline">${raw(field("Category", sel("cat", [{ id: "", n: "All" }, ...cats.map((c) => ({ id: c.id, n: C.label(c) }))], "", (c) => c.n, (c) => c.id)))}${raw(field("or shop", sel("merchant", ["", ...merchants], "", (m) => m || "Any")))}${raw(field("Months", sel("months", ["3", "6", "12"])))}</div><div class="actions right"><button class="primary">Compute</button></div></form></div><div data-out></div>`,
    bind(root) {
      root.querySelector("[data-form=dd]").onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target); const out = root.querySelector("[data-out]"); out.innerHTML = '<div class="empty">Computing…</div>';
        const kind = f.get("cat") ? "category" : f.get("merchant") ? "merchant" : "period"; const id = kind === "category" ? f.get("cat") : kind === "merchant" ? C.normaliseMerchant(f.get("merchant")) : null;
        const r = await deepDive({ kind, id, months: Number(f.get("months")) });
        const pts = r.stats.by_month.map((m) => ({ x: m.month.slice(5), y: m.total == null ? null : Number(m.total) }));
        const bars = r.stats.top.map((t) => ({ label: t.name, value: Number(t.amount) }));
        // pi-lens-ignore: no-inner-html-js
        out.innerHTML = `<div class="card">
          <h2>${esc(r.stats.slice.name || "All spending")}</h2>
          <div class="hero">${esc(shown(r.stats.total))}</div>
          ${r.stats.incomplete_reasons.length ? `<p class="hint">${esc(r.stats.incomplete_reasons.join("; "))}</p>${rateLinks(r.stats.incomplete_reasons)}` : ""}
          <p class="muted">over ${r.stats.slice.months} months · ${r.stats.count} records${r.stats.share_of_all_spend_pct != null ? ` · ${r.stats.share_of_all_spend_pct}% of everything you spent` : ""}</p>
          <h3>Month by month</h3>
          ${pts.length > 1 ? lineChart(pts, { fmtY: (v) => shown(v.toFixed(2)), id: "dd" }) : '<div class="empty">One month only, so there is no trend to draw yet</div>'}
          <h3>Where it went</h3>
          ${rankedBars(bars, { limit: 8, fmt: (v) => shown(v.toFixed(2)) })}
          ${r.prose ? `<p>${esc(r.prose)}</p>` : `<p class="muted">No words this time: ${esc(r.reason || "")} The numbers above stand alone.</p>`}
        </div>`;
        bindCharts(out);
      };
    },
  };
}

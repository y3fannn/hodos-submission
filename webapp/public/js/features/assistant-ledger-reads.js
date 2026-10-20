// Read-only projections over the existing saved ledgers. No names, free-text reasons or raw rows enter data.
import { store } from "../lib/store.js";
import { base as profileBase, today as profileToday } from "./profile.js";
import * as G from "./goals.js";
import * as DB from "./debts.js";
import * as H from "./investments.js";
import { LEDGER_QUERIES, LEDGER_FIELDS, LEDGER_REFERENCES, LEDGER_PREFIX, FX_FIELDS } from "../lib/assistant-ledger-schema.js";
import { validateRate, validatePair } from "../lib/fx.js";
import { validDate } from "../lib/assistant-tasks.js";

const complete = { state: "complete", reason: null };
const empty = { state: "empty", reason: "no_records" };
const incomplete = reason => ({ state: "incomplete", reason });
const usableMoney = m => m && Number.isSafeInteger(m.amount) && typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency) ? m : null;
const scalar = s => { if (typeof s !== "string" && typeof s !== "number" || typeof s === "string" && !s.trim()) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const list = (table) => store.all(table);
export function fxShape(fx) {
  if (!fx || typeof fx !== "object") return null;
  const {from,to,rate,source,on,at} = fx;
  if (typeof rate !== "string" || !["user","provider"].includes(source)) return null;
  try { validatePair(from,to); validateRate(rate); } catch { return null; }
  const timestamp=typeof at==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)&&Number.isFinite(Date.parse(at))&&new Date(at).toISOString()===at?at:null;
  return {from,to,rate,source,on:validDate(on)?on:null,at:timestamp};
}
function readGoals() {
  const rows = G.list();
  const data = rows.map(g => {
    const s = G.status(g);
    return { goal_id: g.id, target: usableMoney(g.target), target_date: g.target_date ?? null, account_id: g.account_id ?? null, start_balance: usableMoney(g.start_balance), started_on: g.started_on ?? null, status: g.status === "completed" ? "achieved" : g.status, completed_at: g.completed_at ?? null, progress: usableMoney(s.progress), remaining: usableMoney(s.remaining), months_left: Number.isFinite(s.monthsLeft) ? s.monthsLeft : null, monthly_needed: usableMoney(s.monthlyNeeded), overdue: s.overdue === true, achieved: s.achieved === true };
  });
  const missing = data.some(x => !x.target || x.progress == null || x.remaining == null);
  return { data, display: rows.map((g, i) => ({ goal: g.name, ...data[i] })), availability: !rows.length ? empty : missing ? incomplete("missing_value") : complete };
}
function readContributions() {
  const goals = list("goals"), data = [];
  for (const g of goals) for (const c of G.contributions(g.id)) data.push({ contribution_id: c.id, goal_id: c.goal_id, transaction_id: c.transaction_id ?? null, money: usableMoney(c.money), date: c.date });
  const missing = data.some(x => !x.money || !x.date);
  return { data, display: data.map(x => ({ ...x, goal: goals.find(g => g.id === x.goal_id)?.name })), availability: !data.length ? empty : missing ? incomplete("missing_value") : complete };
}
function readDebts() {
  const rows = DB.list();
  const data = rows.map(d => {
    const bal = DB.balanceOf(d);
    const validInputs = usableMoney(bal) && usableMoney(d.payment) && scalar(d.rate_apr) != null;
    const raw = validInputs ? DB.projection(d) : null;
    const projection = raw && !raw.reason ? raw : null;
    return { debt_id: d.id, type: d.type, currency: d.currency, balance: usableMoney(bal), original_balance: usableMoney(d.original_balance), apr: scalar(d.rate_apr), rate_type: d.rate_type ?? null, payment: usableMoney(d.payment), payment_day: d.payment_day ?? null, pay_from_account_id: d.pay_from_account_id ?? null, category_id: d.category_id ?? null, started_on: d.started_on ?? null, maturity_date: d.maturity_date ?? null, lock_in_until: d.lock_in_until ?? null, lead_days: DB.leadDays(d), status: d.status, linked_account_id: d.linked_account_id ?? null, recurring_rule_id: d.recurring_rule_id ?? null, months_to_clear: projection?.monthsToClear ?? null, total_interest: usableMoney(projection?.totalInterest), payoff_date: projection?.payoffDate ?? null, never_clears: projection?.neverClears ?? null, shortfall: usableMoney(projection?.shortfall), monthly_interest: usableMoney(projection?.monthlyInterest), _projectionMissing: !projection };
  });
  const missing = data.some(x => !x.balance || !x.payment || x._projectionMissing);
  const clean = data.map(({ _projectionMissing, ...d }) => d);
  return { data: clean, display: rows.map((d, i) => ({ debt: d.name, ...clean[i] })), availability: !rows.length ? empty : missing ? incomplete("missing_value") : complete };
}
function readRepayments() {
  const debts = list("debts"), data = [];
  for (const d of debts) for (const p of DB.payments(d.id)) data.push({ repayment_id: p.id, debt_id: p.debt_id, transaction_id: p.transaction_id ?? null, date: p.date, amount: usableMoney(p.amount), interest: usableMoney(p.interest), principal: usableMoney(p.principal), balance_after: usableMoney(p.balance_after) });
  const missing = data.some(x => !x.amount || !x.principal || !x.balance_after || !x.date);
  return { data, display: data.map(x => ({ ...x, debt: debts.find(d => d.id === x.debt_id)?.name })), availability: !data.length ? empty : missing ? incomplete("missing_value") : complete };
}
function readInvestmentHistory() {
  const holdings = list("holdings"), data = [];
  for (const h of holdings) {
    for (const t of H.trades(h.id)) data.push({ record_type: "trade", trade_id: t.id, holding_id: h.id, platform_id: h.account_label ? h.id : null, kind: t.kind, date: t.date, units: scalar(t.units), price: usableMoney(t.price), fees: usableMoney(t.fees), base_money: usableMoney(t.base_money), fx: fxShape(t.fx), transaction_id: t.transaction_id ?? null });
    for (const f of H.flows(h.id)) data.push({ record_type: "flow", flow_id: f.id, holding_id: h.id, platform_id: h.account_label ? h.id : null, kind: f.kind, date: f.date, money: usableMoney(f.money), base_money: usableMoney(f.base_money), fx: fxShape(f.fx), transaction_id: f.transaction_id ?? null });
    for (const v of H.vals(h.id)) data.push({ record_type: "valuation", valuation_id: v.id, holding_id: h.id, platform_id: h.account_label ? h.id : null, date: v.date, value: usableMoney(v.value), source: v.source, base_money: usableMoney(v.base_money), fx: fxShape(v.fx) });
  }
  data.sort((a, b) => a.date.localeCompare(b.date));
  const missing = data.some(x => !x.date || x.record_type === "trade" && (x.units == null || !x.price) || x.record_type === "flow" && !x.money || x.record_type === "valuation" && !x.value);
  return { data, display: data.map(x => ({ ...x, holding: holdings.find(h => h.id === x.holding_id)?.name })), availability: !data.length ? empty : missing ? incomplete("missing_value") : complete };
}
function readInvestmentReturns({ today }) {
  const summary = H.summary(), returns = H.returns(today), holdings = H.list();
  const data = holdings.map(h => {
    const p = H.position(h);
    return { holding_id: h.id, platform_id: h.account_label ? h.id : null, type: h.type, currency: h.currency, mode: h.mode, status: h.status, units: h.mode === "units" ? p.units : null, average_cost: usableMoney(p.avgCost), cost_basis: usableMoney(p.costBasis), net_contributed: usableMoney(p.netContributed), current_value: usableMoney(p.latestValue), as_of: p.asOf ?? null, pnl: usableMoney(p.pnl), realised: usableMoney(p.realised) };
  });
  const flows = H.flowsBase({upTo:today});
  const meta = { summary_type:"portfolio",return_period:flows.length?{start:flows[0].date,end:today}:null, allocation: summary.allocation.map(a => ({ type: a.type, amount: usableMoney(a.amount), percent: a.pct })), total_base: usableMoney(summary.totalBase), partial: usableMoney(summary.partial), oldest_as_of: summary.oldestAsOf ?? null, value: usableMoney(returns.value), simple_percent: Number.isFinite(returns.simplePct) ? returns.simplePct : null, dollar_weighted_percent: Number.isFinite(returns.dollarWeightedPct) ? returns.dollarWeightedPct : null, net_contributed_total: usableMoney(returns.netContributed), as_of_returns: returns.asOf };
  const missing = summary.incomplete_reasons.length > 0 || returns.reasons.length > 0 || data.some(x => x.current_value == null);
  return { data:[...data,meta], display:[...data.map((h,i)=>({holding:holdings[i].name,...h})),meta], availability: !holdings.length ? empty : missing ? incomplete("missing_value") : complete };
}
const handlers = { goal_records: readGoals, goal_contributions: readContributions, debt_records: readDebts, debt_repayments: readRepayments, investment_history: readInvestmentHistory, investment_returns: readInvestmentReturns };
export function runLedgerRead(kind, params = {}, { base = profileBase(), today = profileToday() } = {}) {
  if (!Object.hasOwn(LEDGER_QUERIES, kind) || Object.keys(params || {}).length) return null;
  const result = handlers[kind]({ base, today });
  return { kind, ...result };
}
// These imports are intentionally exported as metadata for the parent boundary integration.
export { LEDGER_FIELDS, LEDGER_REFERENCES, LEDGER_PREFIX, FX_FIELDS };

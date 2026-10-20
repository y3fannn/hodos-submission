// Canonical wire metadata for saved ledger readers. Safe to import in server code: no browser/storage dependencies.
const enumOf = values => ({ enum: values.split(" ") });
const fxFields = { from: "currency", to: "currency", rate: "decimal", source: enumOf("user provider"), on: "date", at: "datetime" };
const money = "money", date = "date", ref = "ref", bool = "boolean", number = "number";
export const FX_FIELDS = Object.freeze(fxFields);
export const LEDGER_QUERIES = Object.freeze({
  goal_records: { type: "query", params: [] }, goal_contributions: { type: "query", params: [] },
  debt_records: { type: "query", params: [] }, debt_repayments: { type: "query", params: [] },
  investment_history: { type: "query", params: [] }, investment_returns: { type: "query", params: [] },
});
export const LEDGER_FIELDS = Object.freeze({
  goal_records: { goal_ref: ref, target: money, target_date: date, account_ref: ref, start_balance: money, started_on: date, status: enumOf("active achieved paused archived"), completed_at: "datetime", progress: money, remaining: money, months_left: number, monthly_needed: money, overdue: bool, achieved: bool },
  goal_contributions: { contribution_ref: ref, goal_ref: ref, transaction_ref: ref, money, date },
  debt_records: { debt_ref: ref, type: enumOf("mortgage car personal student card other"), currency: "currency", balance: money, original_balance: money, apr: number, rate_type: enumOf("fixed variable"), payment: money, payment_day: number, pay_from_account_ref: ref, category_ref: ref, started_on: date, maturity_date: date, lock_in_until: date, lead_days: [number], status: enumOf("active cleared archived"), linked_account_ref: ref, recurring_rule_ref: ref, months_to_clear: number, total_interest: money, payoff_date: date, never_clears: bool, shortfall: money, monthly_interest: money },
  debt_repayments: { repayment_ref: ref, debt_ref: ref, transaction_ref: ref, date, amount: money, interest: money, principal: money, balance_after: money },
  investment_history: { record_type: enumOf("trade flow valuation"), trade_ref: ref, flow_ref: ref, valuation_ref: ref, holding_ref: ref, platform_ref: ref, kind: enumOf("buy sell deposit withdrawal"), date, units: number, price: money, fees: money, money, value: money, source: enumOf("manual photo"), base_money: money, fx: fxFields, transaction_ref: ref },
  investment_returns: { summary_type: enumOf("portfolio"), return_period: {start:date,end:date}, holding_ref: ref, platform_ref: ref, type: enumOf("stock etf fund bond crypto cash other"), currency: "currency", mode: enumOf("units value"), status: enumOf("active closed archived"), units: number, average_cost: money, cost_basis: money, net_contributed: money, current_value: money, as_of: date, pnl: money, realised: money, allocation: [{ type: enumOf("stock etf fund bond crypto cash other"), amount: money, percent: number }], total_base: money, partial: money, oldest_as_of: date, value: money, simple_percent: number, dollar_weighted_percent: number, net_contributed_total: money, as_of_returns: date },
});
export const LEDGER_REFERENCES = Object.freeze({ goal_id: "goals", contribution_id: "goal_contributions", debt_id: "debts", repayment_id: "debt_payments", holding_id: "holdings", trade_id: "trades", flow_id: "cash_flows", valuation_id: "valuations", platform_id: "holdings@account_label", transaction_id: "transactions", account_id: "accounts", pay_from_account_id: "accounts", linked_account_id: "accounts", category_id: "categories", recurring_rule_id: "recurring_rules" });
export const LEDGER_PREFIX = Object.freeze({ goals: "Goal", goal_contributions: "Contribution", debts: "Debt", debt_payments: "Repayment", holdings: "Holding", trades: "Trade", cash_flows: "Flow", valuations: "Valuation", transactions: "Entry", accounts: "Account", categories: "Category", recurring_rules: "Bill" });

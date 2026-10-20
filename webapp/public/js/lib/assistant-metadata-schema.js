// Explicit financial projections. Pure metadata, usable by browser and proxy.
const enums = values => ({enum:values.split(" ")});
export const FINANCIAL_ALERT_TYPES = ["budget_threshold","price_change","recurring_candidate","recurring_posted","debt_lockin","debt_maturity","debt_cleared","insurance_renewal","goal_done","briefing_ready"];
export const METADATA_QUERIES = Object.fromEntries(["other_assets","net_worth_snapshots","reconciliations","saved_rates","category_records","financial_settings","financial_alerts"].map(kind=>[kind,{type:"query",params:[]}]));
export const METADATA_FIELDS = {
 other_assets:{asset_ref:"ref",type:enums("property vehicle other_asset other_liability"),value:"money",currency:"currency",as_of:"date",archived:"boolean",base_value:"money"},
 net_worth_snapshots:{snapshot_ref:"ref",taken_at:"datetime",trigger:enums("monthly manual"),base_currency:"currency",total:"money",incomplete:"boolean",missing_count:"number",components:[{name:enums("accounts credit holdings debts extras_assets extras_liabilities"),value:"money"}],rates_used:[{from:"currency",to:"currency",rate:"decimal",as_of:"datetime"}]},
 reconciliations:{reconciliation_ref:"ref",account_ref:"ref",statement_date:"date",statement_balance:"money",computed_balance:"money",gap:"money",confirmed_at:"datetime",line_count:"number",matched:"number",added:"number",ignored:"number",flagged:"number",lines:[{resolution:enums("matched added ignored flagged"),entry_ref:"ref",date:"date",money:"money",kind:enums("income expense transfer")}]},
 saved_rates:{from:"currency",to:"currency",rate:"decimal",source:enums("user same"),on:"date",fetched_at:"datetime"},
 category_records:{category_ref:"ref",parent_ref:"ref",replacement_ref:"ref",kind:enums("income expense"),group:"boolean",subcategory:"boolean",merged:"boolean",archived:"boolean",uncategorised:"boolean",total:"money",count:"number",missing:"number"},
 financial_settings:{budget_start_day:"number",default_budget_thresholds:["number"],expected_income_override:"money",debt_lead_days:["number"],insurance_lead_days:["number"],net_worth_snapshot_day:"number",bills_days:"number"},
 financial_alerts:{type:{enum:FINANCIAL_ALERT_TYPES},severity:enums("info warn critical"),created_at:"datetime",read:"boolean",dismissed:"boolean",entry_ref:"ref",budget_ref:"ref",debt_ref:"ref",policy_ref:"ref",goal_ref:"ref"},
};
export const METADATA_REFERENCES = {asset_id:"nw_extras",snapshot_id:"nw_snapshots",reconciliation_id:"reconciliations",account_id:"accounts",entry_id:"transactions",category_id:"categories",parent_id:"categories",replacement_id:"categories",budget_id:"budgets",debt_id:"debts",policy_id:"policies",goal_id:"goals"};
export const METADATA_PREFIX = {nw_extras:"Asset",nw_snapshots:"Snapshot",reconciliations:"Reconciliation",budgets:"Budget"};

// Fixed read-only extensions. Pure metadata shared by browser and proxy.
const enums = values => ({enum:values.split(" ")});
const period = {start:"date",end:"date"};
export const CORE_QUERIES = {
  budget_details:{type:"query",params:["month_offset"]},
  recurring_details:{type:"query",params:[]},
};
export const CORE_REFERENCES = {budget_id:"budgets",parent_id:"categories",replacement_id:"categories",linked_account_id:"accounts",pay_from_account_id:"accounts",transaction_id:"transactions",asset_id:"nw_extras"};
export const CORE_PREFIX = {budgets:"Budget"};
export const CORE_FIELDS = {
  budget_details:{budget_ref:"ref",category_ref:"ref",scope:enums("category savings"),period,start_day:"number",limit:"money",spent:"money",left:"money",upcoming:"money",upcoming_count:"number",safe:"money",percent:"number",missing:"number",target:{amount:"money",percent_of_income:"number"},thresholds:["number"],active_from:"date",summary_type:enums("allocation savings"),expected_income:"money",expected_source:enums("user rules none"),expected_income_override:"money",allocated:"money",left_to_allocate:"money",over_allocated:"boolean",income:"money",saved:"money",savings_target:"money",savings_rate:"number",on_track:"boolean",settings_as_of:enums("current")},
  recurring_details:{bill_ref:"ref",owner:enums("transaction debt"),account_ref:"ref",category_ref:"ref",kind:enums("income expense"),amount:"money",schedule:{freq:enums("daily weekly monthly yearly"),interval:"number",start:"date",anchor:"number",end:"date"},last_posted_on:"date",next_due:"date",paused:"boolean",archived:"boolean",skipped_dates:["date"],price_changed:"boolean",period,occurrence_count:"number",per_month:"money",per_year:"money",summary_type:enums("subscriptions"),count:"number",unpriced:"number"},
};

// Explicit code-owned financial projections and wire checks. No storage or private-label detection.
import { validDate } from "./assistant-tasks.js";
import { toDecimalString } from "./money.js";
import { LEDGER_FIELDS, FX_FIELDS } from "./assistant-ledger-schema.js";
import { CORE_FIELDS } from "./assistant-core-schema.js";
import { METADATA_FIELDS } from "./assistant-metadata-schema.js";
import { REFERENCE_EXACT,referenceTokens } from "./assistant-references.js";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const REF = REFERENCE_EXACT;
const enums = values => ({ enum: values.split(" ") });
const currency = v => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const period = { start:"date", end:"date", from:"date", to:"date" };
const schedule = { freq:enums("daily weekly monthly yearly"), interval:"number", start:"date", anchor:"number", end:"date", day:"number", weekday:"number", day_of_month:"number" };
const projection = { months_to_clear:"number", total_interest:"money", payoff_date:"date", never_clears:"boolean", reason:enums("source_unavailable") };
const component = { name:enums("accounts credit holdings debts extras_assets extras_liabilities"), value:"money" };
const FIELDS = {
  ...LEDGER_FIELDS,...CORE_FIELDS,...METADATA_FIELDS,
  spend_by_category:{ category_ref:"ref", total:"money", period, count:"number" },
  budget_status:{ category_ref:"ref", period, limit:"money", spent:"money", left:"money", upcoming:"money", safe:"money", percent:"number", missing:"number" },
  savings:{ period, income:"money", spent:"money", saved:"money", target:"money", rate:"number", on_track:"boolean" },
  net_worth:{ total:"money", components:[component], base_currency:"currency", as_of:"date" },
  goals:{ goal_ref:"ref", target:"money", target_date:"date", started_on:"date", status:enums("active achieved archived cancelled paused"), progress:"money", remaining:"money", monthly_needed:"money", overdue:"boolean", achieved:"boolean" },
  debts:{ debt_ref:"ref", type:enums("mortgage personal car student card other"), currency:"currency", balance:"money", payment:"money", apr:"number", rate_type:enums("fixed variable"), projection },
  insurance:{ policy_ref:"ref", insurer_ref:"ref", type:enums("life health critical_illness disability home vehicle travel other"), cover:"money", premium:"money", frequency:enums("monthly quarterly yearly one_off"), start_date:"date", end_date:"date", renewal_date:"date", lead_days:["number"], status:enums("active lapsed archived"), recurring_rule_ref:"ref", account_ref:"ref", summary_type:enums("active_totals"), per_year:"money", count:"number", base_currency:"currency" },
  holdings:{ holding_ref:"ref", type:enums("stock stocks fund etf bond crypto cash commodity property other"), currency:"currency", mode:enums("units value"), value:"money", as_of:"date", cost_basis:"money", pnl:"money", base_value:"money" },
  upcoming_bills:{ bill_ref:"ref", amount:"money", next_due:"date", date:"date", schedule },
  search_transactions:{ summary_type:enums("income expense"), period, total:"money", count:"number", missing:"number", entry_ref:"ref", kind:enums("income expense transfer"), date:"date", money:"money", entered_money:"money", entered_fx:FX_FIELDS, base_money:"money", counter_money:"money", category_ref:"ref", account_ref:"ref", counter_account_ref:"ref", recurring_rule_ref:"ref", confirmed_at:"datetime", confirmed:"boolean", fx:FX_FIELDS, cancelled:"boolean", deleted:"boolean", cancellation_reason:enums("refund error cancelled"), source:enums("form text photo csv notification recurring assistant") },
  accounts:{ account_ref:"ref", type:enums("bank cash wallet credit other"), currency:"currency", opening_balance:"money", opened_on:"date", balance:"money", base_balance:"money", credit_limit:"money", statement_day:"number", debt_ref:"ref", available_credit:"money", status:enums("active archived") },
};
const REASONS = new Set(["no_records","missing_saved_conversion","missing_value","unknown_rate","no_occurrence_in_window","history_unavailable","source_unavailable","generator_limit"]);
function valueOf(value, schema, mapReference, wire, referenceKey) {
  if (value == null) return null;
  if (schema === "money") {
    if (!object(value) || !Number.isSafeInteger(value.amount) || !currency(value.currency)) throw new Error("Invalid financial money.");
    const projected = { amount:value.amount, currency:value.currency, decimal:toDecimalString(value) };
    if (wire && (!exact(value,["amount","currency","decimal"]) || value.decimal !== projected.decimal)) throw new Error("Invalid wire money.");
    return projected;
  }
  if(schema === "decimal" && typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && value.length<=40 && Number.isFinite(Number(value)) && Number(value)>0)return value;
  if(schema === "datetime" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value)return value;
  if (schema === "number" && typeof value === "number" && Number.isFinite(value) || schema === "boolean" && typeof value === "boolean" || schema === "date" && validDate(value) || schema === "currency" && currency(value)) return value;
  if (schema === "ref") { const alias = wire ? value : mapReference(referenceKey,value); if (typeof alias === "string" && REF.test(alias)) return alias; }
  if (schema?.enum?.includes(value)) return value;
  if (Array.isArray(schema) && Array.isArray(value)) return value.map(v => valueOf(v,schema[0],mapReference,wire,referenceKey));
  if (object(schema) && !schema.enum && object(value)) return projectFields(value,schema,mapReference,wire);
  throw new Error("Invalid financial field.");
}
function projectFields(row, fields, mapReference, wire) {
  if (!object(row)) throw new Error("Financial row is invalid.");
  if (wire && !exact(row,Object.keys(fields))) throw new Error("Unexpected financial field.");
  const out = {};
  for (const [key,schema] of Object.entries(fields)) {
    const localKey = !wire && key.endsWith("_ref") ? key.replace(/_ref$/,"_id") : key;
    if (!Object.hasOwn(row,localKey)) continue;
    out[key] = valueOf(row[localKey],schema,mapReference,wire,localKey);
  }
  return out;
}
export function projectResult(kind,data,mapReference) {
  if (!Object.hasOwn(FIELDS,kind) || !Array.isArray(data)) throw new Error("Unregistered financial result.");
  return data.map(row => projectFields(row,FIELDS[kind],mapReference,false));
}
export function validateProtectedContext(input) {
  try {
    if (!exact(input,["references","results","last_turns"]) || ![input.references,input.results,input.last_turns].every(Array.isArray) || input.last_turns.length>10) return "Invalid protected context.";
    const aliases = new Set();
    for (const r of input.references) {
      if (!exact(r,["alias","kind"]) || typeof r.alias!=="string" || !REF.test(r.alias) || aliases.has(r.alias) || REF.exec(r.alias)[1].toLowerCase()!==r.kind) return "Invalid financial reference.";
      aliases.add(r.alias);
    }
    for (const r of input.results) {
      if (!exact(r,["kind","data","availability"]) || !FIELDS[r.kind] || !Array.isArray(r.data) || !exact(r.availability,["state","reason"]) || !["complete","empty","incomplete","unavailable"].includes(r.availability.state) || r.availability.reason!=null&&!REASONS.has(r.availability.reason)) return "Invalid financial result.";
      for (const row of r.data) projectFields(row,FIELDS[r.kind],(_key,id)=>id,true);
      const refs = JSON.stringify(r.data).match(referenceTokens())||[];
      if (refs.some(ref=>!aliases.has(ref))) return "Unknown financial reference.";
    }
    for (const t of input.last_turns) {
      if (!exact(t,["role","text","parts"]) || typeof t.text!=="string") return "Invalid history turn.";
      if (t.role==="user") { if(t.parts!=null||t.text.length>10000)return "Invalid raw user history."; continue; }
      if (t.role!=="assistant" || !Array.isArray(t.parts)) return "Generated history lacks safe parts.";
      let text="";
      for (const p of t.parts) {
        if (!exact(p,["type","text","alias"])) return "Invalid history part.";
        if (p.type==="text"&&typeof p.text==="string"&&p.alias==null) text+=p.text;
        else if(p.type==="ref"&&aliases.has(p.alias)&&p.text==null)text+=p.alias;
        else return "Invalid history reference.";
      }
      if(text!==t.text || text.length>30000)return "Restored labels cannot be replayed.";
    }
    return null;
  } catch { return "Protected financial fields failed validation."; }
}

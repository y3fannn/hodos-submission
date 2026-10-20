// Saved financial metadata readers. Native helpers own calculations; labels stay display-local.
import {store} from "../lib/store.js";
import * as NW from "./networth.js";
import * as T from "./transactions.js";
import * as C from "./categories.js";
import * as B from "./budgets.js";
import * as DB from "./debts.js";
import * as I from "./insurance.js";
import * as fx from "../lib/fx.js";
import {METADATA_QUERIES,FINANCIAL_ALERT_TYPES} from "../lib/assistant-metadata-schema.js";
const ok={state:"complete",reason:null}, empty={state:"empty",reason:"no_records"};
const result=(kind,data,display=data,availability= data.length?ok:empty)=>({kind,data,display,availability});
const incomplete=(reason="missing_value")=>({state:"incomplete",reason});
const validDate=s=>typeof s==="string"&&/^\d{4}-\d\d-\d\d$/.test(s);
function runMetadataRead(kind,params={}) {
 if(!Object.hasOwn(METADATA_QUERIES,kind)) return null;
 let data=[],display=[],availability;
 switch(kind){
 case "other_assets": {const now=NW.now(), bases=new Map(now.detail.extras.map(e=>[e.id,e.base]));const rows=store.all("nw_extras");data=rows.map(e=>({asset_id:e.id,type:e.type,value:e.value,currency:e.value?.currency,as_of:e.as_of,archived:!!e.archived_at,base_value:e.archived_at?null:(bases.get(e.id)||null)}));display=rows.map((e,i)=>({label:e.name,...data[i]}));availability=rows.some(e=>!e.archived_at&&!bases.get(e.id))?incomplete("unknown_rate"):data.length?ok:empty;break;}
 case "net_worth_snapshots": {const rows=NW.snapshots();data=rows.map(s=>({snapshot_id:s.id,taken_at:s.taken_at,trigger:s.trigger,incomplete:!s.total||!!s.incomplete_reasons?.length,missing_count:s.incomplete_reasons?.length||0,base_currency:s.base_currency,total:s.total||null,components:Object.entries(s.components||{}).map(([name,value])=>({name,value:value||null})),rates_used:(s.rates_used||[]).map(r=>({from:r.from,to:r.to,rate:r.rate,as_of:r.as_of||null}))}));availability=rows.some(s=>!s.total||s.incomplete_reasons?.length)?incomplete("missing_value"):data.length?ok:empty;break;}
 case "reconciliations": {const rows=store.all("reconciliations");data=rows.map(r=>{const lines=Array.isArray(r.lines)?r.lines:[];const counts={matched:0,added:0,ignored:0,flagged:0};for(const l of lines)if(Object.hasOwn(counts,l.resolution))counts[l.resolution]++;return {reconciliation_id:r.id,account_id:r.account_id,statement_date:r.statement_date,statement_balance:r.statement_balance,computed_balance:r.computed_balance,gap:r.gap,confirmed_at:r.confirmed_at,line_count:lines.length,...counts,lines:lines.map(l=>({resolution:l.resolution,entry_id:l.match||null,date:l.statement_row?.date||null,money:l.statement_row?.amount||null,kind:["income","expense","transfer"].includes(l.statement_row?.kind)?l.statement_row.kind:null}))};});availability=data.length?ok:empty;break;}
 case "saved_rates": {const rows=store.all("fx_rates").filter(r=>!r.deleted_at);data=rows.flatMap(r=>{try{fx.validatePair(r.from,r.to);fx.validateRate(r.rate);if(r.source!=="user")return [];return [{from:r.from,to:r.to,rate:r.rate,source:"user",on:validDate(r.on)?r.on:null,fetched_at:r.fetched_at}];}catch{return [];}});availability=data.length?ok:empty;break;}
 case "category_records": {const cats=store.all("categories"),rows=T.live(),out=[];for(const c of cats){const ids=new Set(C.subtreeIds(c.id)),matched=rows.filter(t=>t.kind===c.kind&&ids.has(t.category_id)),totals=T.baseTotals(matched);out.push({category_id:c.id,parent_id:c.parent_id||null,replacement_id:c.merged_into_id||null,kind:c.kind,group:C.isGroup(c),subcategory:!!c.parent_id,merged:!!c.merged_into_id,archived:!!c.archived_at,uncategorised:false,total:totals.total,count:matched.length,missing:totals.missing});}for(const kind of ["income","expense"]){const matched=rows.filter(t=>t.kind===kind&&!cats.some(c=>c.id===t.category_id));const totals=T.baseTotals(matched);out.push({category_id:null,parent_id:null,replacement_id:null,kind,group:false,subcategory:false,merged:false,archived:false,uncategorised:true,total:totals.total,count:matched.length,missing:totals.missing});}data=out;display=out.map(row=>({label:row.category_id?C.labelId(row.category_id):"Uncategorised",...row}));availability=out.some(r=>r.missing)?incomplete("missing_saved_conversion"):data.length?ok:empty;break;}
 case "financial_settings": {const b=B.settings(),d=DB.settings(),i=I.settings(),n=NW.settings(),ins=store.one("insight_settings")||{};data=[{budget_start_day:b.start_day,default_budget_thresholds:b.default_thresholds,expected_income_override:b.expected_income_override??null,debt_lead_days:d.lead_days,insurance_lead_days:i.lead_days,net_worth_snapshot_day:n.snapshot_day,bills_days:ins.bills_days??14}];break;}
 case "financial_alerts": {const allowed=new Set(FINANCIAL_ALERT_TYPES),map={price_change:["transactions","entry_id"],budget_threshold:["budgets","budget_id"],debt_lockin:["debts","debt_id"],debt_maturity:["debts","debt_id"],debt_cleared:["debts","debt_id"],insurance_renewal:["policies","policy_id"],goal_done:["goals","goal_id"]};const rows=store.all("alerts").filter(a=>allowed.has(a.type));data=rows.map(a=>{const target=map[a.type];const entity=target&&a.source?.entity_id&&store.get(target[0],a.source.entity_id);return {type:a.type,severity:["info","warn","critical"].includes(a.severity)?a.severity:"info",created_at:a.fired_at,read:!!a.read_at,dismissed:!!a.dismissed_at,...(entity?{[target[1]]:entity.id}:{})};});availability=data.length?ok:empty;break;}
 }
 return result(kind,data,display.length?display:data,availability);
}
export {runMetadataRead};

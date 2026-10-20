// Registered, code-owned local reads. Only `data` is passed to the privacy projection.
import { QUERY_KINDS, cleanParams } from "../lib/assistant-tasks.js";
import { runLedgerRead, fxShape } from "./assistant-ledger-reads.js";
import { runCoreRead } from "./assistant-core-reads.js";
import { runMetadataRead } from "./assistant-metadata-reads.js";
import * as T from "./transactions.js";
import * as C from "./categories.js";
import * as A from "./accounts.js";
import * as B from "./budgets.js";
import * as NW from "./networth.js";
import * as G from "./goals.js";
import * as DB from "./debts.js";
import * as H from "./investments.js";
import * as I from "./insurance.js";
import { today, base } from "./profile.js";
import { checkLocalReferences,localReference } from "./assistant-data.js";
const availableFor = (rows, reason="no_records") => rows.length ? {state:"complete",reason:null} : {state:"empty",reason};
const statusFor = (rows, missing=false, reason="missing_value") => missing ? {state:"incomplete",reason} : availableFor(rows);
function uniqueName(rows, label, name) { const matches=rows.filter(x=>label(x).trim().toLowerCase()===name.trim().toLowerCase()); if(matches.length!==1) throw new Error(matches.length ? `“${name}” matches more than one local record; choose one explicitly.` : `No current record matches “${name}”.`); return matches[0]; }
function groupCategory(t) { return C.groupOf(C.get(t.category_id)); }
function runRead(request, {localReferences={}}={}) {
 if(!checkLocalReferences(request))throw new Error("Saved information changed. Ask again or use Records.");
 localReferences={...localReferences,account:localReference(request,"account_name")||localReferences.account,category:localReference(request,"category_name")||localReference(request,"category")||localReferences.category};
 const kind=request?.kind; if(!Object.hasOwn(Object.fromEntries(QUERY_KINDS.map(k=>[k,true])),kind)) throw new Error("Unsupported read request.");
 const p=cleanParams(kind,request.params||{});
 const extension=runLedgerRead(kind,p)||runCoreRead(kind,p)||runMetadataRead(kind,p);if(extension)return extension;
 let data=[],display=[],availability;
 switch(kind){
 case "spend_by_category": {
  let period=p.from||p.to ? {start:p.from||p.to,end:p.to||p.from} : (p.month_offset?B.prevMonth(B.month()):B.month());
  if(p.from&&!p.to||p.to&&!p.from) throw new Error("Provide both start and end dates for a spending range.");
  let cat=null; if(p.category) {const chosen=localReferences.category;if(chosen){cat=C.get(chosen);if(!cat||C.label(cat).trim().toLowerCase()!==p.category.trim().toLowerCase())throw new Error("Chosen category is no longer an exact current match.");}else cat=uniqueName(C.list(),C.label,p.category);}
  const ids=cat?new Set(C.subtreeIds(cat.id)) : null;
  const rows=T.live().filter(t=>t.kind==="expense"&&t.date>=period.start&&t.date<=period.end&&(!ids||ids.has(t.category_id)));
  const totals=T.baseTotals(rows); const sums=new Map();
  for(const t of rows){const g=groupCategory(t),id=g?.id||null; if(!sums.has(id))sums.set(id,{category_id:id,amount:0,count:0});sums.get(id).count++;const m=T.baseAmount(t);if(m)sums.get(id).amount+=m.amount;}
  data=[...sums.values()].map(x=>({category_id:x.category_id,total:totals.total?{amount:x.amount,currency:base()}:null,period,count:x.count}));
  display=data.map(x=>({category:x.category_id?C.label(C.get(x.category_id)):"Uncategorised",total:x.total,period,count:x.count}));
  availability=totals.missing?{state:"incomplete",reason:"missing_saved_conversion"}:availableFor(data); break;
 }
 case "budget_status": {const m=p.month_offset?B.prevMonth(B.month()):B.month();const src=B.status(m);data=src.map(s=>({category_id:s.category?.id||null,period:{start:m.start,end:m.end},limit:s.limit,spent:s.spent,left:s.left,upcoming:s.upcoming,safe:s.safe,percent:s.pct,missing:s.missing}));display=src.map((s,i)=>({category:s.name,...data[i]}));availability=statusFor(data,src.some(s=>s.missing));break;}
 case "savings": {const m=p.month_offset?B.prevMonth(B.month()):B.month(),s=B.savings(m);data=[{period:{start:m.start,end:m.end},income:s.income,spent:s.spent,saved:s.saved,target:s.target,rate:s.rate,on_track:s.onTrack}];display=data;availability=s.reason?{state:"incomplete",reason:s.reasons?.length?"missing_saved_conversion":"source_unavailable"}:availableFor(data);break;}
 case "net_worth": {const n=NW.now();const components=Object.entries(n.components).map(([key,value])=>({name:key,value}));data=[{total:n.total,components,base_currency:n.base_currency,as_of:today()}];display=[{...data[0],incomplete_reasons:n.incomplete_reasons}];availability=n.total?{state:"complete",reason:null}:{state:"incomplete",reason:"missing_value"};break;}
 case "goals": {const rows=G.list();data=rows.map(g=>{const s=G.status(g);return {goal_id:g.id,target:g.target,target_date:g.target_date,started_on:g.started_on,status:g.status==="completed"?"achieved":g.status,progress:s.progress,remaining:s.remaining,monthly_needed:s.monthlyNeeded,overdue:s.overdue,achieved:s.achieved};});display=rows.map((g,i)=>({goal:g.name,...data[i]}));availability=availableFor(data);break;}
 case "debts": {const rows=DB.list();data=rows.map(d=>{const q=DB.projection(d);return {debt_id:d.id,type:d.type,currency:d.currency,balance:DB.balanceOf(d),payment:d.payment,apr:d.rate_apr==null?null:Number(d.rate_apr),rate_type:d.rate_type||null,projection:q.reason?{reason:"source_unavailable"}:{months_to_clear:q.monthsToClear,total_interest:q.totalInterest,payoff_date:q.payoffDate,never_clears:q.neverClears}};});display=rows.map((d,i)=>({debt:d.name,...data[i]}));availability=statusFor(data,data.some(x=>x.balance==null));break;}
 case "insurance": {const rows=I.list(),s=I.totals();data=rows.map(r=>({policy_id:r.id,insurer_id:r.insurer?r.id:null,type:r.type,cover:r.cover,premium:r.premium,frequency:r.frequency,start_date:r.start_date,end_date:r.end_date,renewal_date:r.renewal_date,lead_days:r.lead_days,status:r.status,recurring_rule_id:r.recurring_rule_id,account_id:r.account_id}));data.push({summary_type:"active_totals",cover:s.cover,per_year:s.perYear,count:s.count,base_currency:base()});display=rows.map((r,i)=>({label:`${r.insurer} ${r.type}`,...data[i]}));display.push(data.at(-1));availability=!rows.length?{state:"empty",reason:"no_records"}:s.reasons.length||rows.some(r=>!r.cover||!r.premium)||s.cover==null||s.perYear==null?{state:"incomplete",reason:"missing_value"}:{state:"complete",reason:null};break;}
 case "holdings": {const s=H.summary();data=s.rows.map(r=>({holding_id:r.h.id,type:r.h.type,currency:r.h.currency,mode:r.h.mode,value:r.p.latestValue,as_of:r.p.asOf,cost_basis:r.p.costBasis,pnl:r.p.pnl,base_value:r.baseVal}));display=s.rows.map((r,i)=>({holding:r.h.name,...data[i]}));availability=s.incomplete_reasons.length?{state:"incomplete",reason:"missing_value"}:availableFor(data);break;}
 case "upcoming_bills": {const rules=T.rules().filter(r=>!r.paused_at&&r.template.kind==="expense");if(!p.unbounded&&(!p.from||!p.to))throw new Error("Choose both bill start and end dates, or request unbounded schedules.");
  if(p.unbounded){data=rules.map(r=>({bill_id:r.id,amount:r.template.money,next_due:T.nextDue(r),schedule:r.schedule}));}
  else {const hits=[];for(const r of rules)for(const date of T.allDueDates(r,p.to,{from:p.from}))hits.push({bill_id:r.id,date,amount:r.template.money});data=hits.sort((a,b)=>a.date.localeCompare(b.date));}
  display=data.map(x=>({...x,bill:rules.find(r=>r.id===x.bill_id)?.name}));availability=availableFor(data,"no_occurrence_in_window");break;}
 case "search_transactions": {let accountId,categoryId;
  if(p.account_name){const chosen=localReferences.account;if(chosen){const a=A.get(chosen);if(!a||a.name.trim().toLowerCase()!==p.account_name.trim().toLowerCase())throw new Error("Chosen account is no longer an exact current match.");accountId=chosen;}else accountId=uniqueName(A.active(),a=>a.name,p.account_name).id;}
  if(p.category_name){const chosen=localReferences.category;if(chosen){const c=C.get(chosen);if(!c||C.label(c).trim().toLowerCase()!==p.category_name.trim().toLowerCase())throw new Error("Chosen category is no longer an exact current match.");categoryId=chosen;}else categoryId=uniqueName(C.list(),C.label,p.category_name).id;}
  const boundEntry=localReference(request,"q");
  if(boundEntry&&!T.get(boundEntry))throw new Error("Saved information changed. Ask again or use Records.");
  const rows=T.search({q:p.q||"",kind:p.kind,from:p.from,to:p.to,accountId,categoryId,showCancelled:p.show_cancelled===true}).filter(row=>!boundEntry||row.id===boundEntry);
  data=rows.map(t=>({entry_id:t.id,kind:t.kind,date:t.date,money:t.money,entered_money:t.entered_money||null,entered_fx:fxShape(t.entered_fx),base_money:T.baseAmount(t),counter_money:t.counter_money,category_id:t.category_id,account_id:t.account_id,counter_account_id:t.counter_account_id,recurring_rule_id:t.recurring_rule_id||null,confirmed_at:t.confirmed_at||null,confirmed:Boolean(t.confirmed_at),fx:fxShape(t.fx),cancelled:Boolean(t.voided_at),deleted:Boolean(t.deleted_at),cancellation_reason:["refund","error","cancelled"].includes(t.void_reason)?t.void_reason:null,source:t.source}));
  for(const k of ["income","expense"]){const matching=rows.filter(t=>t.kind===k&&!t.voided_at);const total=T.baseTotals(matching);data.push({summary_type:k,period:{start:p.from||null,end:p.to||null},total:total.total,count:matching.length,missing:total.missing});}
  display=rows.slice(0,5).map(t=>({date:t.date,kind:t.kind,amount:t.money,currency:t.money.currency,category:C.labelId(t.category_id),merchant:t.merchant}));
  availability=rows.some(t=>t.kind!=="transfer"&&!T.baseAmount(t))?{state:"incomplete",reason:"missing_saved_conversion"}:availableFor(rows);break;}
 case "accounts": {const rows=A.withBalances(true);data=rows.map(a=>({account_id:a.id,type:a.type,currency:a.currency,opening_balance:a.opening_balance,opened_on:a.opened_on,balance:a.balance,base_balance:a.base_balance,credit_limit:a.credit_limit,statement_day:a.statement_day??null,debt_id:a.debt_id||null,available_credit:a.type==="credit"?A.available(a):null,status:a.archived_at?"archived":"active"}));display=rows.map((a,i)=>({account:a.name,...data[i]}));availability=statusFor(data,rows.some(a=>!a.base_balance));break;}
 }
 return {kind,display:kind==="search_transactions"?display.slice(0,5):display,data,availability};
}
export {runRead};

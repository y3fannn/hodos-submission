// Select existing code-owned budget/recurring figures; never interpret labels or write.
import * as B from "./budgets.js";
import * as T from "./transactions.js";
import { store } from "../lib/store.js";
const availability = (rows,missing) => missing ? {state:"incomplete",reason:"missing_value"} : rows.length ? {state:"complete",reason:null} : {state:"empty",reason:"no_records"};
export function runCoreRead(kind,p={}) {
  if(kind === "budget_details") {
    const m = p.month_offset ? B.prevMonth(B.month()) : B.month();
    const settings = B.settings(), statuses = B.status(m), a = B.allocation(m), s = B.savings(m);
    const data = statuses.map(x=>({budget_id:x.budget.id,category_id:x.category?.id||null,scope:x.budget.scope,period:{start:m.start,end:m.end},start_day:settings.start_day,limit:x.limit,spent:x.spent,left:x.left,upcoming:x.upcoming,upcoming_count:x.upcomingCount,safe:x.safe,percent:x.pct,missing:x.missing,thresholds:x.budget.thresholds,active_from:x.budget.active_from,settings_as_of:"current"}));
    const savings = s.budget;
    if(savings) data.push({budget_id:savings.id,scope:"savings",period:{start:m.start,end:m.end},start_day:settings.start_day,target:B.limitFor(savings,m).target,thresholds:savings.thresholds,active_from:savings.active_from,settings_as_of:"current"});
    data.push({summary_type:"allocation",period:{start:m.start,end:m.end},settings_as_of:"current",expected_income:a.expected.money,expected_source:a.expected.source,expected_income_override:settings.expected_income_override||null,allocated:a.allocated,left_to_allocate:a.leftToAllocate,over_allocated:a.overAllocated});
    data.push({summary_type:"savings",period:{start:m.start,end:m.end},income:s.income,spent:s.spent,saved:s.saved,savings_target:s.target,savings_rate:s.rate,on_track:s.onTrack});
    return {kind,data,display:data,availability:availability(data,a.reasons.length||statuses.some(x=>x.upcoming==null||x.spent==null))};
  }
  if(kind === "recurring_details") {
    const m = B.month(), subscriptions = T.subscriptions(), priced = new Map(subscriptions.filter(x=>x.rule).map(x=>[x.rule.id,x]));
    const changes = new Set(store.all("alerts").filter(a=>a.type==="price_change"&&a.source?.feature==="transactions").map(a=>store.get("transactions",a.source.entity_id)?.recurring_rule_id).filter(Boolean));
    const rows = store.all("recurring_rules"), data = rows.map(r=>({bill_id:r.id,owner:r.owner,account_id:r.template.account_id,category_id:r.template.category_id,kind:r.template.kind,amount:r.template.money,schedule:{freq:r.schedule.freq,interval:r.schedule.interval,start:r.schedule.start,anchor:r.schedule.anchor,end:r.schedule.end},last_posted_on:r.last_posted_on,next_due:r.paused_at||r.archived_at?null:T.nextDue(r),paused:!!r.paused_at,archived:!!r.archived_at,skipped_dates:r.skipped_dates||[],price_changed:changes.has(r.id),period:{start:m.start,end:m.end},occurrence_count:r.paused_at||r.archived_at?0:T.allDueDates(r,m.end,{from:m.start,ignorePosted:true}).length,per_month:priced.get(r.id)?.perMonth||null,per_year:priced.get(r.id)?.perYear||null}));
    const totals = T.subscriptionTotals(subscriptions);
    data.push({summary_type:"subscriptions",count:totals.count,per_month:totals.perMonth,per_year:totals.perYear,unpriced:totals.unpriced});
    return {kind,data,display:data,availability:rows.length?availability(data,totals.unpriced):{state:"empty",reason:"no_records"}};
  }
  return null;
}

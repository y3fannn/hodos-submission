// Saved financial onboarding state only. Ordinary settings/forms own financial writes.
import { store } from "../lib/store.js";
import { esc } from "../lib/ui.js";
import { profile } from "./profile.js";
import * as A from "./accounts.js";
import * as T from "./transactions.js";
export function setupState(){
 const p=profile(),rules=T.rules(),accounts=A.active(),budget=store.one("budget_settings"),skipped=p?.assistant_setup_skipped||{};
 const flags={has_account:accounts.length>0,has_income:rules.some(r=>r.template?.kind==="income"),has_bills:rules.some(r=>r.template?.kind==="expense"),budget_start_day:budget?.start_day??null};
 const steps=[{id:"currency",label:"Currency and timezone",done:!!p?.base_currency&&!!p?.timezone},{id:"account",label:"First account",done:flags.has_account},{id:"income",label:"Regular income",done:flags.has_income},{id:"bills",label:"Regular bills",done:flags.has_bills},{id:"budget-day",label:"Budget start day",done:!!p?.assistant_budget_day_reviewed}].map(s=>({...s,skipped:!!skipped[s.id]}));
 return {steps,current:steps.find(s=>!s.done&&!s.skipped)?.id||null,flags};
}
export function setupView({onDraft,onSkip,onResume,onBudgetReviewed}={}){
 const state=setupState();
 return {html:`<details ${state.current==='account'?'open':''}><summary>Financial setup</summary><p>Continue from what you have saved, or skip a step and return later.</p><ol>${state.steps.map(s=>`<li>${esc(s.label)}: ${s.done?"Saved":s.skipped?"Skipped":"Not yet saved"}${!s.done?` <button type="button" data-setup-skip="${s.id}">${s.skipped?"Resume":"Skip"}</button>`:""}</li>`).join("")}</ol>${!state.flags.has_account?'<p>Create an account before reviewing regular income or bills. You can describe everything together below, or upload supported files; review the account draft first.</p>':''}<p><a href="#/settings">Currency, timezone and budget day in Settings</a></p><div class="actions"><button type="button" data-setup-draft="account">Add account</button><button type="button" data-setup-draft="income" ${!state.flags.has_account?'disabled':''}>Add regular income</button><button type="button" data-setup-draft="bills" ${!state.flags.has_account?'disabled':''}>Add regular bill</button><button type="button" data-setup-reviewed>Use saved budget day ${state.flags.budget_start_day??"—"}</button></div></details>`,bind(root){
 root.querySelectorAll("[data-setup-skip]").forEach(b=>b.onclick=()=>{const step=state.steps.find(s=>s.id===b.dataset.setupSkip);if(step.skipped)onResume?.(step.id);else onSkip?.(step.id);});
 root.querySelectorAll("[data-setup-draft]").forEach(b=>b.onclick=()=>onDraft?.(b.dataset.setupDraft==="account"?{kind:"add_account",params:{}}:{kind:"create_recurring",params:{kind:b.dataset.setupDraft==="income"?"income":"expense"}}));
 root.querySelector("[data-setup-reviewed]").onclick=()=>onBudgetReviewed?.();
 }};
}

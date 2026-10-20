// MVP chat: protected financial questions and fixed directions; imports live in Add.
import { session } from "../lib/session.js";
import { featurePaused, pausedPage } from "../lib/feature-policy.js";
import { toast, confirm } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { createAssistantRun } from "../lib/assistant-run.js";
import { retryDraftPersistence } from "../lib/assistant-drafts.js";
import { history, epoch, clearConversation, discardPendingAccess } from "../lib/assistant-conversation.js";
import { runRead } from "./assistant-reads.js";
import { MVP_QUERY_KINDS } from "../lib/assistant-tasks.js";
import { chatView } from "./assistant-view.js";
export { history } from "../lib/assistant-conversation.js";
export { BUTTONS, QUERY_KINDS, ACTION_KINDS, cleanParams } from "../lib/assistant-tasks.js";
export { amountFromText } from "./assistant-actions.js";
export const REFUSAL="I can't give financial advice, including whether to buy, sell or hold anything. I can show recorded figures. For advice, please speak to a licensed financial adviser.";
export const NEVER=["export","wipe","base_currency","ai_off"];
export const HOW_TO={
 add_records:"Add → Upload files. Choose an existing account and one file, then review and confirm the extracted transactions. Create accounts manually in Accounts first.",
 records:"Records → open the entry to edit or cancel it. Changes use the normal form and your confirmation.",
 accounts:"Accounts shows current accounts and balances. Accounts → ＋ Account creates one manually.",
 budgets:"Open Budgets for budget and savings figures or changes.",goals:"Open Goals for progress or contributions.",debts:"Open Debts for balances and supported monthly estimates.",insurance:"Open Insurance for policies and reminders.",investments:"Open Investments for holdings and returns.",networth:"Open Net worth for totals and snapshots.",
 export:"Settings → Your data → Export backup.",wipe:"Settings → Your data → Wipe everything. Export first if you want a copy; wiping cannot be undone.",base_currency:"Settings → Profile → Base currency, then Save. Old snapshots retain their original currency.",ai_off:"Settings → Allow AI help, then Save.",restore:"Settings → Your data → Restore backup. This replaces the records on this device.",theme:"Settings → Appearance.",overseas:"Settings → Overseas mode, then choose the currency.",budget_month:"Settings → Budget month → Starts on day, then Save.",reminders:"Settings → Dates and reminders.",add_account:"Accounts → ＋ Account. Create financial accounts manually; Assistant does not create account drafts.",transfer:"Accounts → Transfer. Paying a credit card is a transfer.",balance_check:"Accounts → Balance check.",recurring:"Settings → Recurring → ＋ Rule.",category:"Settings → Categories → New category.",add_debt:"Debts → ＋ Loan, or Link a credit card.",add_policy:"Insurance → ＋ Policy.",add_investment:"Investments → ＋ Investment. Open an investment to log trades or values.",add_extra:"Net worth → ＋ Property, vehicle, other.",home_screen:"Settings → Home panel, or press and hold the panel on Home."
};
let activeRun=null, viewState={}, viewEpoch=null;
export function clearPendingSend(){activeRun?.cancel();activeRun=null;viewState={};viewEpoch=null;discardPendingAccess();}
export function runQuery(request){if(!MVP_QUERY_KINDS.includes(request?.kind))throw new Error("Use the normal feature screen for this question.");return runRead(request);}
export async function clear(){activeRun?.cancel();await clearConversation();activeRun=null;viewState={};session.render();}
// Retain the old public entry safely: neither old links nor saved chat can reopen financial drafts.
export function performAction(){toast("Use Add for new records, Accounts for accounts, or Records to edit saved entries.");return false;}
export function createChatPage({callAI=ai.call,redraw=()=>session.render()}={}) {
 let scopeCurrent=true;
 const currentEpoch=epoch();if(viewEpoch!==currentEpoch){activeRun?.cancel();activeRun=null;viewState={};viewEpoch=currentEpoch;}
 const pending=!!(activeRun&&!['complete','failed','cancelled'].includes(activeRun.phase));
 const events={messages:history(),pending,error:activeRun?.phase==="failed"?activeRun.error:null,viewState,
   onSend:async(text,ack)=>{if(pending||!ai.consented())return false;activeRun=createAssistantRun({text,callAI,read:runQuery,directions:HOW_TO,refusal:REFUSAL,onUserSaved:ack,onChange:redraw,isCurrent:()=>scopeCurrent&&viewEpoch===currentEpoch&&ai.consented()});return activeRun.start();},
   onCancel:()=>{activeRun?.cancel();redraw();},
   onClear:async()=>{if(await confirm("Clear conversation?","This removes this chat from this device, not from any backups already exported.",{submitLabel:"Clear",danger:true})){activeRun?.cancel();try{await clearConversation();activeRun=null;viewState={};redraw();}catch(e){toast(e.message);}}},
   // Recovery of an already-confirmed captured save is not a new draft or extraction retry.
   onDraftRetry:async()=>{try{await retryDraftPersistence();redraw();}catch(e){toast(e.message);}},
 };
 const page=chatView(events);
 const bind=page.bind;page.bind=root=>{const dispose=bind(root);return ({reason="departure"}={})=>{dispose?.();if(reason!=="redraw"){scopeCurrent=false;activeRun?.cancel({silent:true});}};};
 return page;
}
export function chatPage(query){
 if(featurePaused("assistant"))return {...pausedPage("assistant"),bind(){if(query)window.history.replaceState(null,"","#/chat");}};
 const page=ai.enabled()?createChatPage():{title:"Assistant",html:!ai.consented()?'<section class="card" data-assistant-blocked><h1>Assistant is disabled</h1><p>Enable Allow AI help in Settings to use Assistant.</p><a class="btn" href="#/settings?enable-ai=1">Enable Assistant in Settings</a></section>':ai.offHtml(),bind(){}};
 if(query){const bind=page.bind;page.bind=root=>{window.history.replaceState(null,"","#/chat");return bind?.(root);};}
 return page;
}
export async function send(text,options={}){
 if(options.signal?.aborted||!ai.consented()||featurePaused("assistant"))return false;
 activeRun=createAssistantRun({text,read:runQuery,directions:HOW_TO,refusal:REFUSAL,...options});return activeRun.start();
}

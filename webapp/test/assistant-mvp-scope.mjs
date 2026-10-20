// Combined local scope, answer-fallback and old-chat controls check. No provider/network.
import assert from 'node:assert/strict';
import {store} from '../public/js/lib/store.js';
import {TASKS,MVP_QUERY_KINDS,decodeProviderOutput,validateOutput} from '../public/js/lib/assistant-tasks.js';
import {createAssistantRun} from '../public/js/lib/assistant-run.js';
import {history,clearConversation} from '../public/js/lib/assistant-conversation.js';
import {chatView} from '../public/js/features/assistant-view.js';
import {HOW_TO,runQuery} from '../public/js/features/assistant.js';
const started=new Date().toISOString();store.open(null,async()=>{},'mvp-scope-fixture');
try{
 store.insert('profile',{base_currency:'USD',timezone:'UTC',consent:{ai_provider:true}});store.insert('budget_settings',{start_day:1});
 const account=store.insert('accounts',{name:'PRIVATE bank',type:'bank',currency:'USD',opened_on:'2020-01-01',opening_balance:{amount:0,currency:'USD'}});
 store.insert('transactions',{account_id:account.id,kind:'expense',date:'2026-10-14',money:{amount:10000,currency:'USD'},merchant:'PRIVATE merchant',source:'form'});
 const plan={intent:'question',requests:[{kind:'search_transactions',params:{from:'2026-10-01',to:'2026-10-31'}}],actions:[],topic:null,text:null};
 let reads=0,inputs=[];const run=createAssistantRun({text:'Show recorded October spending.',read:r=>{reads++;return runQuery(r);},callAI:async(task,o)=>{inputs.push(o.input);return task==='assistant_plan'?plan:{text:'• Recorded expense: 25.00 USD.'};}});
 await run.start();assert.equal(run.phase,'failed');assert.equal(reads,1);assert(history().some(m=>m.figures?.length));assert(!history().some(m=>m.origin==='ai'));assert(!JSON.stringify(inputs).includes('PRIVATE'));
 await clearConversation();const manual=createAssistantRun({text:'Create an account.',directions:HOW_TO,callAI:async()=>({intent:'how_to',requests:[],actions:[],topic:'add_account',text:null})});await manual.start();assert.equal(manual.phase,'complete');assert(history().some(m=>m.text.includes('Accounts → ＋ Account')));assert.equal(store.all('accounts').length,1);
 for(const kind of ['add_account','edit_transaction','create_goal'])assert.throws(()=>decodeProviderOutput('assistant_plan',{intent:'action',requests:[],actions:[{kind,params:[]}],topic:null,text:null}));
 assert(validateOutput('assistant_plan',{...plan,requests:[{kind:'debts',params:{}}]}));assert.throws(()=>runQuery({kind:'debts',params:{}}));
 const html=chatView({messages:[{id:'old',role:'assistant',text:'Old proposal',actions:[{kind:'add_account',params:{}}]}]}).html;
 assert(!html.includes('type="file"'));assert(!html.includes('data-draft='));assert(html.includes('href="#/add"'));assert(html.includes('href="#/accounts"'));assert(html.includes('href="#/transactions"'));
 assert(TASKS.assistant_answer.system.includes('three short bullet'));assert(TASKS.assistant_answer.system.includes('80 words'));assert.equal(MVP_QUERY_KINDS.length,3);
 console.log(JSON.stringify({started,ended:new Date().toISOString(),scopeBlocked:true,manualDirections:true,figuresRetained:true,privateLabelsExcluded:true,noChatUploadsOrDrafts:true,shortPrompt:true}));
}finally{store.close();}

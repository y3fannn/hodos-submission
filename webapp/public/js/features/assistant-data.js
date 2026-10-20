// Explicit financial context, temporary aliases and local-only draft reference bindings.
import { projectResult, validateProtectedContext } from "../lib/assistant-privacy.js";
import { REFERENCE_EXACT, referenceTokens, PRIVATE_REFERENCE_FIELDS } from "../lib/assistant-references.js";
import { LEDGER_REFERENCES, LEDGER_PREFIX } from "../lib/assistant-ledger-schema.js";
import { CORE_REFERENCES, CORE_PREFIX } from "../lib/assistant-core-schema.js";
import { METADATA_REFERENCES, METADATA_PREFIX } from "../lib/assistant-metadata-schema.js";
import { store } from "../lib/store.js";
import { ownerId, accessRevision } from "../lib/vault.js";
import { epoch } from "../lib/assistant-conversation.js";
import * as C from "./categories.js";
export {runRead} from "./assistant-reads.js";
const PREFIX = { accounts:"Account",categories:"Category",goals:"Goal",transactions:"Entry",recurring_rules:"Bill",debts:"Debt",policies:"Policy",holdings:"Holding",nw_extras:"Asset",...LEDGER_PREFIX,...CORE_PREFIX,...METADATA_PREFIX };
const ID_TABLE = {account_id:"accounts",counter_account_id:"accounts",category_id:"categories",goal_id:"goals",entry_id:"transactions",debt_id:"debts",holding_id:"holdings",bill_id:"recurring_rules",policy_id:"policies",insurer_id:"policies@insurer",recurring_rule_id:"recurring_rules",...LEDGER_REFERENCES,...CORE_REFERENCES,...METADATA_REFERENCES};
const SLOT_TABLE = {account_name:"accounts",from_account:"accounts",to_account:"accounts",category_name:"categories",category:"categories",goal_name:"goals",holding_name:"holdings",q:"transactions"};
const alphabetic = n => { let s=""; for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s; };
const sourceRow = (table,id) => store.get(table,id)||store.all(table,{includeDeleted:true}).find(r=>r.id===id);
const label = (table,row,field) => field?row[field]:table==="categories"?C.label(row):table==="policies"?`${row.insurer} ${row.type}`:row.name||row.merchant||row.ticker||PREFIX[table];
function aliasFor(source,id,aliases,refs) {
 const [table,field]=String(source).split("@"),prefix=field?PRIVATE_REFERENCE_FIELDS[source]:PREFIX[table];
 const row=prefix&&sourceRow(table,id);if(!row||field&&typeof row[field]!=="string")throw new Error("Financial reference is unavailable.");
 const key=`${source}:${id}`;let entry=aliases.get(key);
 if(!entry){const index=[...aliases.values()].filter(v=>v.prefix===prefix).length;entry={table,id,field:field||null,prefix,alias:`[${prefix} ${aliases.nonce} ${alphabetic(index)}]`};aliases.set(key,entry);}
 entry.label=label(table,row,field);entry.generation=store.generation();entry.snapshot=JSON.stringify(row);
 if(!refs.some(r=>r.alias===entry.alias))refs.push({alias:entry.alias,kind:prefix.toLowerCase()});return entry.alias;
}
export function buildContext({results=[],history=[],retry=null}={}) {
 const aliases=retry?.aliases instanceof Map?retry.aliases:new Map();
 if(aliases.generation!=null&&aliases.generation!==store.generation())throw new Error("Access changed; start a new request.");
 if(!aliases.nonce)aliases.nonce=[...crypto.getRandomValues(new Uint8Array(7))].map(n=>String.fromCharCode(65+n%26)).join("");aliases.generation=store.generation();
 const refs=[];
 const safeResults=results.map(r=>{try{return {kind:r.kind,data:projectResult(r.kind,r.data,(key,id)=>aliasFor(ID_TABLE[key],id,aliases,refs)),availability:r.availability||{state:"complete",reason:null}};}catch{return {kind:r.kind,data:[],availability:{state:"unavailable",reason:"source_unavailable"}};}});
 const last_turns=[];
 for(const m of history.slice(-10)){
  if(m.role==="user"){last_turns.push({role:"user",text:m.text});continue;}if(!Array.isArray(m.safe_parts))continue;
  const parts=m.safe_parts.map(p=>{
   if(p.type==="text"&&typeof p.text==="string")return {type:"text",text:p.text};
   if(p.type==="ref"&&p.table&&p.id){try{return {type:"ref",alias:aliasFor(p.field?`${p.table}@${p.field}`:p.table,p.id,aliases,refs)};}catch{return {type:"text",text:"[Earlier financial reference is no longer available; ask for current records.]"};}}
   throw new Error("Generated history cannot be safely prepared.");
  });last_turns.push({role:"assistant",text:parts.map(p=>p.type==="ref"?p.alias:p.text).join(""),parts});
 }
 const input={references:refs,results:safeResults,last_turns};const problem=validateProtectedContext(input);if(problem)throw new Error(problem);return {input,aliases};
}
export function restoreReply(text,context){
 const parts=[];let out="",pos=0,match;const token=referenceTokens(),raw=String(text);
 while((match=token.exec(raw))){out+=raw.slice(pos,match.index);if(match.index>pos)parts.push({type:"text",text:raw.slice(pos,match.index)});
  const entry=context?.aliases&&[...context.aliases.values()].find(v=>v.alias===match[0]);
  if(!entry||entry.generation!==store.generation()||JSON.stringify(sourceRow(entry.table,entry.id))!==entry.snapshot)throw new Error("Reply contains an unknown or stale financial reference.");
  out+=entry.label;parts.push({type:"ref",table:entry.table,id:entry.id,...(entry.field?{field:entry.field}:{})});pos=token.lastIndex;
 }out+=raw.slice(pos);if(pos<raw.length)parts.push({type:"text",text:raw.slice(pos)});return {text:out,parts,safe_parts:parts};
}
export function bindPlanReferences(operation,context){
 const params={...operation.params},refs=[];
 for(const [param,value] of Object.entries(params)){
  if(typeof value!=="string"||!REFERENCE_EXACT.test(value))continue;
  const entry=context?.aliases&&[...context.aliases.values()].find(v=>v.alias===value);
  if(!entry||entry.field||entry.table!==SLOT_TABLE[param]||entry.generation!==store.generation()||JSON.stringify(sourceRow(entry.table,entry.id))!==entry.snapshot)throw new Error("That financial reference changed or is unavailable. Ask again or use the normal screen.");
  const row=sourceRow(entry.table,entry.id);params[param]=param==="q"?"":label(entry.table,row);
  refs.push({param,table:entry.table,id:entry.id,snapshot:entry.snapshot});
 }
 return {...operation,params,...(refs.length?{local_refs:{owner:ownerId(),access:accessRevision(),generation:store.generation(),conversation:epoch(),refs}}:{})};
}
export function checkLocalReferences(operation){
 const scope=operation?.local_refs;if(!scope)return true;
 if(scope.owner!==ownerId()||scope.access!==accessRevision()||scope.generation!==store.generation()||scope.conversation!==epoch()||!Array.isArray(scope.refs))return false;
 return scope.refs.every(r=>SLOT_TABLE[r.param]===r.table&&typeof r.id==="string"&&JSON.stringify(store.get(r.table,r.id))===r.snapshot);
}
export function localReference(operation,param){
 if(!checkLocalReferences(operation))throw new Error("Saved information changed. Review again; no change saved.");
 return operation.local_refs?.refs.find(r=>r.param===param)?.id||null;
}

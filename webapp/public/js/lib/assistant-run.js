// One acknowledged exchange. Code reads and normal reviews; AI never saves financial records.
import * as ai from "./ai.js";
import { LIMITS, cleanParams, validateOutput } from "./assistant-tasks.js";
import { appendMessage, history, epoch } from "./assistant-conversation.js";
import { buildContext, restoreReply, bindPlanReferences, checkLocalReferences } from "../features/assistant-data.js";
import {orderDrafts} from './assistant-drafts.js';
import { profile, today, tz } from "../features/profile.js";
export function createAssistantRun({ text, signal = null, callAI = ai.call, read, onUserSaved = () => {}, onChange = () => {}, isCurrent = () => true, directions = {}, refusal = "I can show recorded figures, but cannot advise buying, selling or holding." } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > LIMITS.message) throw new Error("Enter a message of no more than 10,000 characters.");
  const expected = epoch(), userId = crypto.randomUUID();
  let controller = null, version = 0, phase = "new", failed = null, planning = null, results = [], context = null, userSaved = false, pendingReply = null;
  const current = token => token === version && expected === epoch() && !controller?.signal.aborted && isCurrent();
  const metadata = () => {
    const description = profile()?.self_description;
    return { message:text, today:today(), timezone:tz(), description:["student","working","retiree","other"].includes(description)?description:"other" };
  };
  const update = next => { phase=next; onChange(run); };
  const save = async (token, key, message, extra) => {
    if (!current(token)) return null;
    pendingReply={key,message,extra};
    const saved = await appendMessage("assistant",message,extra,{id:`${userId}:${key}`,expected,replace:key==="figures"});
    pendingReply=null;
    if (current(token)) onChange(run);
    return saved;
  };
  const readAll = async token => {
    const out=[];
    for(const request of planning.requests) {
      if(!current(token))return null;
      try { if(!checkLocalReferences(request))throw new Error("Saved information changed. Ask again or use Records."); if(typeof read!=="function")throw new Error("Reader not connected."); out.push(await read({kind:request.kind,params:cleanParams(request.kind,request.params),local_refs:request.local_refs})); }
      catch {out.push({kind:request.kind,display:[],data:[],availability:{state:"unavailable",reason:"source_unavailable"}});}
    }
    return out;
  };
  const execute = async (retry=false) => {
    if(signal?.aborted){phase="cancelled";return false;}
    if(phase!=="new"&&!failed)return false;
    const retryPhase=failed;
    const token=++version; controller?.abort(); controller=new AbortController(); failed=null; run.error=null;
    const abort=()=>run.cancel();signal?.addEventListener('abort',abort,{once:true});
    try {
      if(retryPhase==="reply_save"&&pendingReply){
        const item=pendingReply;
        await appendMessage("assistant",item.message,item.extra,{id:`${userId}:${item.key}`,expected,retry:true});
        pendingReply=null;
        if(item.key!=="figures"){update("complete");return userSaved;}
      }
      if(!userSaved) {
        update("message_save");
        const message=await appendMessage("user",text,{}, {id:userId,expected,retry});
        if(!message||!current(token))return false;
        userSaved=true; onUserSaved();
      }
      if(!current(token))return false;
      if(retryPhase!=="explanation"&&retryPhase!=="reply_save") {
        update("planning");
        context=buildContext({history:history().filter(m=>m.id!==userId),retry:retryPhase==="planning"?context:null});
        const previous=history().filter(m=>m.role==="assistant").at(-1);
        run.awaitingClarification=previous?.intent==="ambiguous"&&!!previous.clarification;
        planning=await callAI("assistant_plan",{input:{...metadata(),awaiting_clarification:run.awaitingClarification,context:context.input},signal:controller.signal});
        if(!current(token))return true;
        const invalid=validateOutput("assistant_plan",planning); if(invalid)throw new Error(invalid);
        planning={...planning,requests:planning.requests.map(x=>bindPlanReferences(x,context)),actions:planning.actions.map(x=>bindPlanReferences(x,context))};
      }
      if(planning.intent==="question") {
        update("reading"); results=await readAll(token);
        if(!results||!current(token))return true;
        context=buildContext({results,history:history().filter(m=>m.id!==userId&&!m.id?.startsWith(`${userId}:`)),retry:retryPhase==="explanation"?context:null});
        const safe=restoreReply(JSON.stringify(context.input.results),context);
        await save(token,"figures","Code-calculated figures",{origin:"code",intent:"question",figures:results,safe_parts:safe.safe_parts});
        if(!current(token))return true;
        update("explanation");
        const input={...metadata(),context:context.input};
        const output=await callAI("assistant_answer",{input,signal:controller.signal,validate:o=>ai.validateProse(o.text,input.context.results)});
        if(!current(token))return true;
        const invalid=validateOutput("assistant_answer",output)||ai.validateProse(output.text,input.context.results); if(invalid)throw new Error("The AI wording was rejected; code figures remain available.");
        const reply=restoreReply(output.text,context);
        await save(token,"answer",reply.text,{origin:"ai",intent:"question",safe_parts:reply.safe_parts});
      } else if(["action","onboarding"].includes(planning.intent)) {
        const actions=orderDrafts(planning.actions).map(a=>({kind:a.kind,params:cleanParams(a.kind,a.params),...(a.local_refs?{local_refs:a.local_refs}:{})}));
        await save(token,"drafts","Drafts are ready. Review the normal form and confirm any change yourself.",{origin:"code",intent:planning.intent,actions,safe_parts:[{type:"text",text:"Financial drafts prepared for user review; no change confirmed."}]});
      } else if(planning.intent==="how_to"||planning.intent==="refuse") {
        const message=planning.intent==="refuse"?refusal:directions[planning.topic]||"Use the normal feature screen for this request.";
        await save(token,"directions",message,{origin:"code",safe_parts:[{type:"text",text:message}]});
      } else {
        const output=planning.text||"Which financial record or period do you mean?";
        const invalid=ai.validateProse(output,{...metadata(),context:context.input});
        if(invalid)throw new Error("The AI wording was rejected. Continue here or use the normal screen.");
        const reply=restoreReply(output,context);
        await save(token,"reply",reply.text,{origin:"ai",intent:planning.intent,safe_parts:reply.safe_parts,...(planning.intent==="ambiguous"?{clarification:{destination:planning.clarification.destination},...(run.awaitingClarification&&planning.clarification.unresolved?{manual_destination:planning.clarification.destination}:{})}:{})});
      }
      if(current(token))update("complete");
      return userSaved;
    } catch(error) {
      if(!current(token))return userSaved;
      failed=pendingReply?"reply_save":phase==="reading"?"explanation":phase;
      update("failed");
      run.error=error.message||"This step did not finish. Retry explicitly or use the normal screen.";
      onChange(run);
      return userSaved;
    } finally { signal?.removeEventListener('abort',abort); }
  };
  const run={
    get phase(){return phase;},get failedPhase(){return failed;},get userSaved(){return userSaved;},get actions(){return planning?.actions?.map(a=>({kind:a.kind,params:cleanParams(a.kind,a.params),...(a.local_refs?{local_refs:a.local_refs}:{})}))||[];},get results(){return results;},get context(){return context;},error:null,
    start:()=>execute(false),retry:()=>execute(true),
    cancel({silent=false}={}){version++;controller?.abort();phase="cancelled";if(!silent)onChange(run);},
    current:()=>expected===epoch()&&isCurrent(),
  };
  return run;
}

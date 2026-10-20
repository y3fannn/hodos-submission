// Thin read-only MVP chat. Parent owns persistence, provider calls and cancellation.
import { esc, aiMade } from "../lib/ui.js";
import { fmt } from "../lib/money.js";
import { MANUAL_SCREENS } from "../lib/assistant-tasks.js";
import { draftStatus } from '../lib/assistant-drafts.js';
const valueText = v => v == null ? "—" : typeof v === "object" ? (Number.isSafeInteger(v.amount)&&v.currency ? fmt(v) : Object.entries(v).filter(([k])=>!k.endsWith("_id")).map(([k,x])=>`${k.replace(/_/g," ")}: ${valueText(x)}`).join(" · ")) : String(v);
const figures = list => (list||[]).map(result => {
  const rows=Array.isArray(result.display)?result.display:[];
  return `<section><h3>${esc(result.kind.replace(/_/g," "))}</h3>${rows.length?`<table>${rows.map(row=>`<tr><td>${esc(row.label||row.account||row.category||row.goal||row.debt||row.holding||row.bill||row.date||"Recorded figures")}</td><td>${esc(valueText(row.value??Object.fromEntries(Object.entries(row).filter(([k])=>!["label","account","category","goal","debt","holding","bill"].includes(k)&&!k.endsWith("_id")))))}</td></tr>`).join("")}</table>`:"<p>No matching recorded figures are available.</p>"}${result.availability?.state==="incomplete"||result.availability?.state==="unavailable"?'<p class="hint">Some information is unavailable. Missing information is not zero.</p>':""}</section>`;
}).join("");
export function chatView({messages=[],onSend,onClear,onCancel,onDraftRetry,pending=false,error=null,viewState={},reset=false}={}) {
  if(reset){viewState.top=0;viewState.anchor=null;viewState.unread=0;viewState.count=messages.length;viewState.composer="";delete viewState.composerKey;}
  viewState.composerKey ||= crypto.randomUUID();
  const arrivals=messages.slice(viewState.count??messages.length).filter(m=>m.role==="assistant").length;
  if(!viewState.atBottom&&arrivals)viewState.unread=Math.min(2,(viewState.unread||0)+arrivals);
  viewState.count=messages.length;
  const content=messages.map((m,i)=>`<article class="msg ${m.role}" data-message="${esc(m.id||i)}" tabindex="-1">${m.origin==="ai"?`<span class="ai-inline">${aiMade("AI-written reply")}</span> `:`<span class="sr-only">${m.role==="user"?"You":"Code"}: </span>`}<p class="message-text" style="white-space:pre-wrap">${esc(m.text)}</p>${m.role==="user"&&Array.isArray(m.file_names)&&m.file_names.some(name=>typeof name==="string"&&name.trim())?`<ul class="chat-files" aria-label="Previously selected files">${m.file_names.filter(name=>typeof name==="string"&&name.trim()).map(name=>`<li class="chat-file"><span>${esc(name)}</span></li>`).join("")}</ul>`:""}${Object.hasOwn(MANUAL_SCREENS,m.manual_destination)?`<a class="btn" data-manual-screen href="#/${esc(m.manual_destination)}">Open ${esc(MANUAL_SCREENS[m.manual_destination])}</a>`:""}${figures(m.figures)}${(m.actions||[]).map((_a,n)=>draftStatus(m,n)==='saved'?'<p class="hint">Saved after confirmation. Do not repeat this change.</p>':draftStatus(m,n)==='pending'?'<p class="hint">Confirmation applied; device saving is still pending.</p><button type="button" data-draft-retry>Retry saving only</button>':'<p class="hint">Chat drafts are unavailable. Use Add, Accounts or Records.</p>').join("")}</article>`).join("");
  return {title:"Assistant",html:`<section class="assistant-chat"><div class="actions chat-controls"><button type="button" data-clear>Clear conversation</button></div><p class="muted chat-intro">Ask about spending, transactions and account figures. The app calculates; AI explains briefly. <a href="#/add">Import one file in Add</a> · <a href="#/accounts">Create accounts</a> · <a href="#/transactions">Edit in Records</a></p><div class="chat" data-chat-scroll tabindex="0">${content}${error?`<div class="chat-error"><p class="error" role="alert">${esc(error)}</p><p>Any calculated figures remain above. Ask again or use the normal screen.</p><a class="btn" href="#/transactions">Open Records</a><a class="btn" href="#/add">Open Add</a></div>`:""}</div><button type="button" class="chat-latest" data-latest aria-label="Go to latest message">↓${viewState.unread?` ${viewState.unread}`:""}</button><form class="chat-input" data-chat-form><label class="sr-only" for="assistant-message">Message to Assistant</label><textarea id="assistant-message" name="text" rows="1" enterkeyhint="send" maxlength="10000" placeholder="Ask about recorded spending" ${pending?"disabled":""} data-composer-key="${esc(viewState.composerKey)}">${esc(viewState.composer||"")}</textarea><button type="submit" class="chat-send" aria-label="Send message" title="Send message" ${pending?"disabled":""}><svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-7 7 7-7 7 7"/></svg></button>${pending?'<button type="button" data-cancel>Cancel</button>':""}</form></section>`,bind(root){
    const form=root.querySelector("[data-chat-form]"),input=form.elements.text,pane=root.querySelector("[data-chat-scroll]"),latest=root.querySelector("[data-latest]"),shell=root.querySelector('.assistant-chat');
    const nearBottom=()=>pane.scrollHeight-pane.scrollTop-pane.clientHeight<24;
    const capture=()=>{viewState.top=pane.scrollTop;viewState.atBottom=nearBottom();const item=[...pane.querySelectorAll("[data-message]")].find(n=>n.getBoundingClientRect().bottom>pane.getBoundingClientRect().top);if(item)viewState.anchor={id:item.dataset.message,offset:item.getBoundingClientRect().top-pane.getBoundingClientRect().top};if(viewState.atBottom)viewState.unread=0;};
    const update=()=>{capture();latest.hidden=viewState.atBottom;latest.textContent=`↓${viewState.unread?` ${viewState.unread}`:""}`;};
    const grow=(node=input)=>{node.style.height="auto";const style=getComputedStyle(node);node.style.height=`${node.scrollHeight+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth)}px`;};
    const visual=window.visualViewport,nav=document.querySelector('.tabbar');
    let bound=false;
    const restoreReading=()=>{
      if(viewState.atBottom!==false)pane.scrollTop=pane.scrollHeight;
      else {pane.scrollTop=viewState.top||0;const anchor=[...pane.querySelectorAll('[data-message]')].find(n=>n.dataset.message===viewState.anchor?.id);if(anchor)pane.scrollTop+=anchor.getBoundingClientRect().top-pane.getBoundingClientRect().top-viewState.anchor.offset;}
    };
    const layout=()=>{
      const height=visual?.height||innerHeight,visibleBottom=(visual?.offsetTop||0)+height;
      const clearance=parseFloat(getComputedStyle(document.body).getPropertyValue('--nav-clearance'))||parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h'))||0;
      const navBox=nav?.getBoundingClientRect(),bottom=Math.min(visibleBottom,navBox?.height?navBox.top:innerHeight-clearance);
      const page=shell.closest('.page'),box=(page||shell).getBoundingClientRect(),pad=page?parseFloat(getComputedStyle(page).paddingLeft)||0:0;
      shell.style.setProperty('--chat-left',`${box.left+pad}px`);
      shell.style.setProperty('--chat-width',`${Math.max(0,box.width-2*pad)}px`);
      shell.style.setProperty('--chat-bottom',`${Math.max(0,innerHeight-bottom)}px`);
      const top=shell.querySelector('.chat-intro').getBoundingClientRect().bottom+12;
      const chrome=form.getBoundingClientRect().height-input.getBoundingClientRect().height;
      input.style.maxHeight=`${Math.max(44,Math.min(240,height*.35,bottom-top-chrome-24))}px`;
      pane.style.top=`${top}px`;
      pane.style.bottom=`${Math.max(0,innerHeight-form.getBoundingClientRect().top)}px`;
      latest.style.bottom=`${Math.max(0,innerHeight-form.getBoundingClientRect().top+16)}px`;
      latest.style.right=`${Math.max(0,innerWidth-form.getBoundingClientRect().right)}px`;
    };
    const resize=()=>{if(bound)capture();layout();grow();layout();if(bound){restoreReading();update();}};
    window.addEventListener('resize',resize);visual?.addEventListener('resize',resize);visual?.addEventListener('scroll',resize);
    const ro=new ResizeObserver(resize);ro.observe(form);if(nav)ro.observe(nav);
    input.oninput=()=>{viewState.composer=input.value;resize();};
    let submitting=false;
    input.onkeydown=event=>{if(event.key!=="Enter"||event.shiftKey||event.isComposing||event.keyCode===229||event.repeat)return;event.preventDefault();if(!input.disabled&&!submitting&&input.value.trim())form.requestSubmit();};resize();
    form.onsubmit=async event=>{event.preventDefault();if(submitting||input.disabled||!input.value.trim())return;const text=input.value;submitting=true;viewState.composer=text;try{await onSend?.(text,()=>{if(viewState.composer===text)viewState.composer="";const current=root.querySelector('[data-composer-key]');if(current?.dataset.composerKey===viewState.composerKey&&current.value===text){current.value=viewState.composer;current.dispatchEvent(new Event('input',{bubbles:true}));}});}finally{submitting=false;}};
    // A dropped file cannot navigate away or start an alternate import path.
    const drop=e=>{e.preventDefault();},drag=e=>e.preventDefault();shell.addEventListener('dragover',drag);shell.addEventListener('drop',drop);
    root.querySelector("[data-clear]").onclick=()=>onClear?.();root.querySelector("[data-cancel]")?.addEventListener("click",()=>onCancel?.());
    root.querySelectorAll('[data-draft-retry]').forEach(b=>b.onclick=()=>onDraftRetry?.());
    latest.onclick=()=>{pane.scrollTop=pane.scrollHeight;update();pane.querySelector("article:last-of-type")?.focus({preventScroll:true});};
    restoreReading();bound=true;pane.addEventListener("scroll",update);update();
    return ()=>{bound=false;capture();form.onsubmit=null;input.oninput=null;input.onkeydown=null;shell.removeEventListener('dragover',drag);shell.removeEventListener('drop',drop);window.removeEventListener('resize',resize);visual?.removeEventListener('resize',resize);visual?.removeEventListener('scroll',resize);ro.disconnect();pane.removeEventListener("scroll",update);};
  }};
}

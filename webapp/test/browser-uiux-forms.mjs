// Shared-dialog keyboard/accessibility behavior and a durable transaction save in disposable demo data.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";

const server = await startServer({ AUTH: "off" });
let browser;
try {
  console.log('[DEBUG-u4] browser startup');
  browser = await startChrome({ width: 360, height: 900 });
  const { cmd, js, waitFor } = browser;
  await cmd("Page.navigate", { url: server.url + "?demo=1#/home" });
  await waitFor(`!!document.querySelector('.home-panel') && !!localStorage.getItem('pfa.demo')`);
  await js(`document.querySelector('[data-tab=add]').click()`);
  await waitFor(`!!document.querySelector('[data-door=expense]')`);
  const trigger = await js(`document.querySelector('[data-door=expense]').getAttribute('data-door')`);
  assert.equal(trigger, "expense");
  await js(`(() => { const b=document.querySelector('[data-door=expense]'); b.focus(); b.click(); })()`);
  await waitFor(`!!document.querySelector('[role=dialog] form [name=amount]')`);
  assert.equal(await js(`(() => { const d=document.querySelector('[role=dialog]'), id=d.getAttribute('aria-labelledby'); return d.getAttribute('role')==='dialog' && d.getAttribute('aria-modal')==='true' && !!id && document.getElementById(id)?.tagName==='H2'; })()`), true, "dialog has its visible heading as a unique accessible name");
  assert.equal(await js(`document.querySelector('#app').inert && document.querySelector('#tabbar').inert`), true, "background shell cannot be interacted with");
  assert.equal(await js(`document.querySelector('[role=dialog]').contains(document.activeElement)`), true, "initial focus enters the dialog");
  await js(`document.querySelector('.modal-backdrop').click()`);
  assert.equal(await js(`!!document.querySelector('[role=dialog]')`), true, "financial form stays open after a backdrop click");
  await js(`(() => { const d=document.querySelector('[role=dialog]'), nodes=[...d.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(x=>x.getClientRects().length); nodes[0].focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})); return document.activeElement===nodes.at(-1); })()`);
  assert.equal(await js(`(() => { const d=document.querySelector('[role=dialog]'), nodes=[...d.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(x=>x.getClientRects().length); return document.activeElement===nodes.at(-1); })()`), true, "Shift+Tab wraps from the first control to the last");
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  assert.equal(await js(`document.activeElement?.dataset?.door === 'expense'`), true, "Escape returns focus to the action that opened the form");

  console.log('[DEBUG-u4] dialog checks complete; transaction validation');
  // U4: invalid inputs expose named errors, never mutate, and remain correctable.
  const beforeValidation = await js(`(async () => { const {store}=await import('./js/lib/store.js'); await store.retryPending(); return JSON.stringify(store.snapshot()); })()`);
  await js(`document.querySelector('[data-door=expense]').click()`);
  await waitFor(`!!document.querySelector('[role=dialog] form [name=amount]')`);
  assert.equal(await js(`document.querySelector('[name=amount]').hasAttribute('aria-invalid')`), false, "composing starts without errors");
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.elements.amount.value='0'; f.elements.date.value='2099-01-01'; f.elements.note.value='Keep this note'; f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[name=amount]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`document.querySelector('[name=date]').getAttribute('aria-invalid')`), "true", "one Confirm exposes every invalid field");
  assert.equal(await js(`document.activeElement?.name`), "amount", "focus goes to the first invalid field");
  assert.equal(await js(`(() => { const c=document.querySelector('[name=amount]'); return !!c.id && c.getAttribute('aria-describedby').split(' ').some(id=>document.getElementById(id)?.textContent.includes('zero')); })()`), true, "amount error is associated with its control");
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), beforeValidation, "invalid Confirm has no financial or learning side effects");
  await js(`(() => { const c=document.querySelector('[name=amount]'); c.value='12.34'; c.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal(await js(`document.querySelector('[name=amount]').hasAttribute('aria-invalid')`), false, "corrected amount clears its own error");
  assert.equal(await js(`document.querySelector('[name=date]').getAttribute('aria-invalid')`), "true", "correcting amount does not hide the date error");
  assert.equal(await js(`document.querySelector('[name=note]').value`), "Keep this note", "other inputs survive correction");
  await js(`(async () => { const {today}=await import('./js/features/profile.js'); const c=document.querySelector('[name=date]'); c.value=today(); c.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await js(`document.querySelector('[name=date]').hasAttribute('aria-invalid')`), false, "date correction clears its error");
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), beforeValidation, "correction alone never saves");
  const categoryId = await js(`document.querySelector('[name=category_id]').id`);
  await js(`(() => { const c=document.querySelector('[name=kind]'); c.value='income'; c.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await js(`document.querySelector('[name=category_id]').id`), categoryId, "kind replacement keeps the category id");
  assert.equal(await js(`(() => { const c=document.querySelector('[name=category_id]'); return !!c.id && [...c.labels].some(l=>l.textContent.includes('Category')); })()`), true, "category stays labelled after kind replacement");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);

  console.log('[DEBUG-u4] recurring validation');
  const beforeRule = await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`);
  await js(`document.querySelector('[data-door=rule]').click()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=start]')`);
  await js(`(async () => { const f=document.querySelector('[data-modal-form]'), {today}=await import('./js/features/profile.js'), {addDays}=await import('./js/lib/dates.js'); f.elements.amount.value='0'; f.elements.name.value='U4 future recurring'; f.elements.start.value=addDays(today(),7); f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[name=amount]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), beforeRule, "invalid recurring amount has no rule/post/learning writes");
  await js(`(() => { const c=document.querySelector('[name=amount]'); c.value='2.50'; c.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal(await js(`document.querySelector('[name=amount]').hasAttribute('aria-invalid')`), false, "recurring amount correction clears its error");
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), beforeRule, "recurring correction alone saves nothing");
  await js(`(() => { const c=document.querySelector('[name=kind]'); c.value='income'; c.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await js(`(() => { const c=document.querySelector('[name=category_id]'); return !!c.id && [...c.labels].some(l=>l.textContent.includes('Category')); })()`), true, "recurring category stays labelled after kind replacement");
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  assert.equal(await js(`(async () => (await import('./js/lib/store.js')).store.all('recurring_rules').filter(r=>r.name==='U4 future recurring').length)()`), 1, "future recurring rule is saved exactly once");
  assert.equal(await js(`(async () => (await import('./js/lib/store.js')).store.all('transactions').length)()`), JSON.parse(beforeRule).tables.transactions.filter(t=>!t.deleted_at).length, "future schedule posts no transaction early");

  console.log('[DEBUG-u4] held durable save');
  const baseline = await js(`(async () => {
    const {store,DEMO_KEY}=await import('./js/lib/store.js');await store.retryPending();
    const snapshot=store.snapshot(),count=store.all('transactions').length;let held=false;
    snapshot.tables.profile[0].subcategories_enabled=false;snapshot.tables.profile[0].subcategory_prompt_shown_at=null;
    store.open(snapshot,async (captured) => {
      if(!held){held=true;await new Promise(resolve=>{window.releaseDialogSave=resolve;});}
      localStorage.setItem(DEMO_KEY,JSON.stringify(captured));
    });return count;
  })()`);
  await js(`(() => { const b=document.querySelector('[data-door=expense]'); b.focus(); b.click(); })()`);
  await waitFor(`!!document.querySelector('[role=dialog] form [name=amount]')`);
  await js(`(() => { const f=document.querySelector('[role=dialog] form'); f.elements.amount.value='12.34'; f.requestSubmit(); })()`);
  await waitFor(`!!window.releaseDialogSave && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
  assert.equal(await js(`(() => { const f=document.querySelector('[role=dialog] form'); return f.getAttribute('aria-busy')==='true' && !f.querySelector('[data-action=modal-cancel]').disabled; })()`), true, "Cancel stays available without claiming it can undo a confirmed save");
  assert.equal(await js(`(async()=>(await import('./js/lib/store.js')).store.one('profile').subcategory_prompt_shown_at)()`), null, "optional onboarding cannot replace Saving or be marked shown early");
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.transactions.length`), baseline, "held write has not reached device storage");
  await js(`window.releaseDialogSave()`);
  await waitFor(`document.querySelector('[role=dialog] h2')?.textContent==='Turn on subcategories?'`, 10000);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.transactions.length`), baseline + 1, "exactly one transaction reaches storage before the form closes and onboarding opens");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  await js(`location.hash='#/settings'`);
  await waitFor(`!!document.querySelector('[data-form=budget-settings]')`);
  console.log('[DEBUG-u4] settings validation');
  const settingsBaseline = await js(`(async () => { const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot()); })()`);
  for (const value of ['0','32','1.5','']) {
    await js(`(() => { const f=document.querySelector('[data-form=budget-settings]'); f.elements.start_day.value=${JSON.stringify(value)}; f.requestSubmit(); })()`);
    await waitFor(`document.querySelector('[name=start_day]')?.getAttribute('aria-invalid')==='true'`);
    assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), settingsBaseline, `invalid budget day ${JSON.stringify(value)} never saves or clamps`);
    await js(`(() => { const c=document.querySelector('[name=start_day]'); c.value='1';c.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert.equal(await js(`document.querySelector('[name=start_day]').hasAttribute('aria-invalid')`), false, "Settings correction clears the field error");
  }
  assert.equal(await js(`['th0','th1','th2'].every((name,i)=>{const c=document.querySelector('[name='+name+']');return !!c.id&&[...c.labels].some(l=>l.textContent.includes('Budget alert '+(i+1)))&&!!c.closest('fieldset')?.querySelector('legend');})`), true, "budget alert boxes have distinct names and a real group heading");
  assert.equal(await js(`['ins0','ins1','ins2','debt0','debt1','debt2'].every(name=>{const c=document.querySelector('[name='+name+']');return !!c.id&&c.labels.length===1&&!!c.closest('fieldset')?.querySelector('legend');})`), true, "insurance/loan reminder boxes have distinct labels and group headings");
  await js(`(() => { const f=document.querySelector('[data-form=timing]');f.elements.bills_days.value='91';f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[name=bills_days]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), settingsBaseline, "invalid bills window does not silently clamp or save");
  await js(`(() => { const f=document.querySelector('[data-form=profile]');f.elements.timezone.value='Not/A_Timezone';f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[name=timezone]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), settingsBaseline, "invalid timezone writes nothing");
  await js(`(() => { const c=document.querySelector('[name=timezone]');c.value=${JSON.stringify(JSON.parse(settingsBaseline).tables.profile[0].timezone)};c.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal(await js(`document.querySelector('[name=timezone]').hasAttribute('aria-invalid')`), false, "timezone correction clears its error");
  assert.equal(await js(`(async () => JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`), settingsBaseline, "Settings correction alone writes nothing");
  await js(`(() => { const f=document.querySelector('[data-form=budget-settings]');f.elements.start_day.value='2';f.requestSubmit(); })()`);
  await waitFor(`JSON.parse(localStorage.getItem('pfa.demo')).tables.budget_settings[0].start_day===2 && document.querySelector('[data-form=budget-settings]')?.getAttribute('aria-busy')!=='true'`);
  assert.equal(await js(`(async () => (await import('./js/lib/store.js')).store.one('budget_settings').start_day)()`), 2, "corrected Settings day reaches device storage after explicit Save");

  console.log('[DEBUG-u4] Goal and extra validation');
  // Remaining small callers share this browser/store fixture, not duplicate suites.
  await js(`location.hash='#/goals'`);
  await waitFor(`!!document.querySelector('[data-action=new]') && document.querySelector('#topbar-title')?.textContent==='Goals'`);
  const goalBefore = await js(`(async()=>{const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot())})()`);
  await js(`document.querySelector('[data-action=new]').click()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=target]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.name.value=' ';f.elements.target.value='bad';f.elements.date.value='';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=target]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`['name','target','date'].every(n=>document.querySelector('[data-modal-form]').elements[n].getAttribute('aria-invalid')==='true')`),true,'Goal exposes independent errors together');
  assert.equal(await js(`(async()=>JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`),goalBefore,'invalid Goal writes nothing');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');for(const [n,v] of [['name','U4 Goal'],['target','100.00'],['date','2099-01-01']]){f.elements[n].value=v;f.elements[n].dispatchEvent(new Event('input',{bubbles:true}))}})()`);
  assert.equal(await js(`document.querySelectorAll('[data-modal-form] [aria-invalid=true]').length`),0,'Goal correction clears every error');
  assert.equal(await js(`(async()=>JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`),goalBefore,'Goal correction alone never writes');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`!document.querySelector('[data-modal-form]')`);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.goals.filter(g=>g.name==='U4 Goal').length`),1,'Goal confirmed candidate reaches device storage once');
  const goalId = await js(`(async()=>(await import('./js/lib/store.js')).store.all('goals').find(g=>g.name==='U4 Goal').id)()`);
  await js(`document.querySelector('[data-contrib="${goalId}"]').click()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=amount]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.amount.value='';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=amount]')?.getAttribute('aria-invalid')==='true'`);
  await js(`(()=>{const c=document.querySelector('[name=amount]');c.value='-1.00';c.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-modal-form]').requestSubmit()})()`);
  await waitFor(`!document.querySelector('[data-modal-form]')`);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.goal_contributions.filter(c=>c.goal_id==='${goalId}'&&c.money.amount===-100).length`),1,'Goal withdrawal remains valid and saves once');

  await js(`location.hash='#/networth/assets'`);
  await waitFor(`!!document.querySelector('[data-add-extra]')`);
  const extraBefore = await js(`(async()=>{const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot())})()`);
  await js(`document.querySelector('[data-add-extra]').click()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=as_of]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.name.value=' ';f.elements.value.value='bad';f.elements.as_of.value='';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=value]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`(async()=>JSON.stringify((await import('./js/lib/store.js')).store.snapshot()))()`),extraBefore,'invalid extra leaves all financial data unchanged');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');for(const [n,v] of [['name','U4 Extra'],['value','0.00'],['as_of','2099-01-01']]){f.elements[n].value=v;f.elements[n].dispatchEvent(new Event('input',{bubbles:true}))}})()`);
  assert.equal(await js(`document.querySelectorAll('[data-modal-form] [aria-invalid=true]').length`),0,'extra correction clears named errors, including date');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`!document.querySelector('[data-modal-form]')`);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.nw_extras.filter(e=>e.name==='U4 Extra'&&e.value.amount===0&&e.as_of==='2099-01-01').length`),1,'extra preserves explicit zero and valid future as-of date');

  // About-you validation uses a disposable mounted view, never real device enrollment.
  await js(`(async () => { const {onboardingPage}=await import('./js/features/profile.js');const fixture=document.createElement('section');fixture.id='setup-validation-probe';document.body.append(fixture);const page=onboardingPage({onStart:()=>{window.setupAdvanced=true}});fixture.innerHTML=page.html;window.setupDispose=page.bind(fixture);const f=fixture.querySelector('form');f.elements.name.value='   ';f.elements.timezone.value='Not/A_Timezone';f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('#setup-validation-probe [name=name]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`!!window.setupAdvanced`), false, "invalid About you never advances to device setup");
  await js(`(() => { const f=document.querySelector('#setup-validation-probe form');f.elements.name.value='Test user';f.elements.name.dispatchEvent(new Event('input',{bubbles:true}));f.elements.timezone.value='UTC';f.elements.timezone.dispatchEvent(new Event('input',{bubbles:true}));f.requestSubmit(); })()`);
  assert.equal(await js(`!!window.setupAdvanced`), true, "corrected About you advances only after Next");
  await js(`window.setupDispose?.();document.querySelector('#setup-validation-probe').remove()`);
  assert.equal(browser.problems().length, 0, browser.problems().join("\n"));
  console.log("PASS shared dialog name, background inertness, keyboard trap, Cancel focus, backdrop retention and durable demo save");
} finally {
  browser?.close(); server.stop();
}

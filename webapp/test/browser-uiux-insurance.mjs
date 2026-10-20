// Insurance U4 forms use an owned disposable demo store and no real providers/data.
import assert from 'node:assert/strict';
import {startServer,startChrome} from './browser-kit.mjs';
const server=await startServer({AUTH:'off'});let browser;
try {
 browser=await startChrome({width:360,height:900});const {cmd,js,waitFor}=browser;
 await cmd('Page.navigate',{url:`${server.url}?demo=1#/insurance`});
 await waitFor(`!!document.querySelector('[data-action=new]')&&!!localStorage.getItem('pfa.demo')`);
 await js(`(async()=>{const {store}=await import('./js/lib/store.js');const P=await import('./js/features/profile.js');const {seedDemoSteps}=await import('./js/features/seed.js');const {session}=await import('./js/lib/session.js');store.open(null,null,'insurance-browser-demo');P.createProfile(P.DEMO_PROFILE());store.captureAction('insurance-demo-fixture',()=>{for(const step of seedDemoSteps()){}});const saved=store.snapshot();localStorage.setItem('pfa.demo',JSON.stringify(saved));store.open(saved,async db=>localStorage.setItem('pfa.demo',JSON.stringify(db)),'insurance-browser-demo');session.mode='demo';session.render();})()`);
 await waitFor(`!!document.querySelector('[data-action=new]')&&!!localStorage.getItem('pfa.demo')`);
 const snapshot=()=>js(`(async()=>{const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot());})()`);
 const before=await snapshot(),durable=JSON.parse(await js(`localStorage.getItem('pfa.demo')`));
 await js(`document.querySelector('[data-action=new]').click()`);await waitFor(`!!document.querySelector('[data-modal-form] [name=premium]')`);
 assert.equal(await js(`['insurer','premium','cover','lead0'].every(n=>!document.querySelector('[name='+n+']').hasAttribute('aria-invalid'))`),true,'new policy starts without errors');
 await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.insurer.value='  ';f.elements.premium.value='bad money';f.elements.cover.value='oops';f.elements.frequency.value='monthly';f.elements.renewal_date.value='';f.elements.lead0.value='0';f.requestSubmit()})()`);
 await waitFor(`document.querySelector('[name=insurer]')?.getAttribute('aria-invalid')==='true'`);
 assert.equal(await js(`['insurer','premium','cover','renewal_date','lead0'].every(n=>document.querySelector('[name='+n+']')?.getAttribute('aria-invalid')==='true')`),true,'invalid insurer, premium, cover, missing renewal and reminder are named together');
 assert.equal(await js(`document.activeElement===document.querySelector('[name=insurer]')`),true,'first invalid policy input receives focus');
 assert.equal(await snapshot(),before,'invalid policy confirm leaves memory unchanged');assert.deepEqual(JSON.parse(await js(`localStorage.getItem('pfa.demo')`)),durable,'invalid policy confirm leaves durable demo unchanged');
 await js(`(()=>{const f=document.querySelector('[data-modal-form]');for(const [n,v] of [['insurer','Example'],['premium','0.00'],['cover',''],['renewal_date','2027-03-01'],['lead0','30']]){const c=f.elements[n];c.value=v;c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
 assert.equal(await js(`['insurer','premium','cover','renewal_date','lead0'].every(n=>!document.querySelector('[name='+n+']').hasAttribute('aria-invalid'))`),true,'corrections quietly clear independent policy issues');
 assert.equal(await snapshot(),before,'correction alone does not save');
 await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[data-modal-form]')`);
 assert.equal(JSON.parse(await snapshot()).tables.policies.length,JSON.parse(before).tables.policies.length+1,'valid policy saves once');
 const policyId=await js(`(async()=>{const I=await import('./js/features/insurance.js');return I.list().find(p=>p.insurer==='Example').id})()`);
 await js(`document.querySelector('[data-edit="'+${JSON.stringify(policyId)}+'"]')?.click()`);await waitFor(`!!document.querySelector('[data-modal-form] [name=frequency]')`);
 await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.frequency.value='one_off';f.elements.frequency.dispatchEvent(new Event('change',{bubbles:true}));f.requestSubmit()})()`);await waitFor(`!document.querySelector('[data-modal-form]')`);
 assert.equal(await js(`!document.querySelector('[data-renew="'+${JSON.stringify(policyId)}+'"]')&&!!document.querySelector('[data-lapse="'+${JSON.stringify(policyId)}+'"]')`),true,'one-off keeps lapse but hides Mark renewed');
 assert.deepEqual(browser.problems(),[]);
 console.log('PASS Insurance correctable policy validation and confirmed save');
} finally {browser?.close();server.stop();}

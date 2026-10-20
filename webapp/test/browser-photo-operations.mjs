// Statement-photo preparation must report its phase, abort on departure, and never save by itself.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";

const server = await startServer({ AUTH: "off" });
let browser;
try {
  browser = await startChrome({ width: 360, height: 900 });
  const { cmd, js, waitFor } = browser;
  await cmd("Page.navigate", { url: server.url + "?demo=1#/home" });
  await waitFor(`!!document.querySelector('.home-panel') && !!localStorage.getItem('pfa.demo')`);
  await waitFor(`import('./js/lib/store.js').then(({store})=>store.all('debts').length>0)`);
  await js(`(async () => {
    const {store} = await import('./js/lib/store.js'), ai = await import('./js/lib/ai.js');
    const realFetch = window.fetch.bind(window), tasks = ['extract_debt_statement','extract_policy','extract_holdings_statement'];
    window.photoTest = { pending: [], tasks };
    window.fetch = async (resource, options) => {
      const url = String(resource);
      if (url.includes('/api/ai/status')) return new Response(JSON.stringify({configured:true,sign_in_required:false}),{status:200,headers:{'Content-Type':'application/json'}});
      if (url.includes('/api/ai')) {
        const task = JSON.parse(options.body).task;
        if (tasks.includes(task)) return new Promise((resolve,reject) => {
          const request = {task,aborted:false,reply:(output)=>resolve(new Response(JSON.stringify({output}),{status:200,headers:{'Content-Type':'application/json'}})),fail:()=>reject(new Error('Simulated provider failure'))}; photoTest.pending.push(request);
          // Deliberately let replies arrive after abort: callers must reject stale results too.
          options.signal?.addEventListener('abort',() => {request.aborted=true;},{once:true});
        });
      }
      return realFetch(resource, options);
    };
    await ai.refreshStatus();
    const p = store.one('profile'); store.update('profile',p.id,{consent:{...p.consent,ai_provider:true}});
    photoTest.snapshot = () => JSON.stringify(['transactions','debts','policies','holdings','valuations'].map(t=>store.all(t)));
    photoTest.baseline = photoTest.snapshot();
    photoTest.debtId = store.all('debts').find(d=>d.status==='active'&&!d.linked_account_id).id;
  })()`);

  const settle = () => js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const redraw = () => js(`import('./js/lib/session.js').then(({session})=>session.render())`);
  async function startPhoto(route, task, phase, output) {
    const go = async () => { await js(`location.hash=${JSON.stringify(route)}`); await waitFor(`!!document.querySelector('[data-action=photo]')`); await settle(); };
    const select = () => js(`(()=>{const input=document.querySelector('[data-action=photo]'),data=new DataTransfer();data.items.add(new File(['fake'],'statement.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const count = () => js(`photoTest.pending.length`);
    const reply = (index) => js(`photoTest.pending[${index}].reply(${JSON.stringify(output)})`);
    const noWrites = async () => assert.equal(await js(`photoTest.snapshot()`), await js(`photoTest.baseline`), `${task} preparation/review writes no financial records`);
    const busy = async () => {
      assert.equal(await js(`document.querySelector('[data-operation-status]')?.textContent`), phase, `${task} retains live progress`);
      assert.equal(await js(`document.querySelector('[data-operation-root]')?.getAttribute('aria-busy')`), 'true', `${task} retains busy state`);
    };
    await go();
    if (route === '#/insurance') {
      assert.equal(await js(`(()=>{const input=document.querySelector('[data-action=photo]'),label=input?.closest('label');return !!label?.querySelector('svg')&&!/\\$\\{/.test(label.textContent)&&document.querySelector('[data-action=new]')?.textContent.includes('+ Policy')})()`), true, 'Insurance photo control renders its camera icon without literal code and shows + Policy');
    }
    let index = await count(); await select(); await waitFor(`photoTest.pending.length===${index + 1}`);
    await busy();
    await js(`photoTest.oldRoot=document.querySelector('[data-operation-root]')`);
    await redraw();
    assert.equal(await js(`photoTest.oldRoot.isConnected`), false, 'test exercises a real same-screen rebuild');
    await busy();
    await select(); await settle();
    assert.equal(await count(), index + 1, `${task} duplicate activation after redraw makes no second request`);
    await js(`photoTest.pending[${index}].fail()`);
    await waitFor(`!document.querySelector('[data-operation-error]')?.hidden && document.querySelector('[data-operation-error]')?.textContent.includes('Could not read')`);
    const error = await js(`document.querySelector('[data-operation-error]').textContent`);
    await redraw();
    assert.equal(await js(`document.querySelector('[data-operation-error]')?.textContent`), error, `${task} failure survives redraw`);
    assert.equal(await js(`document.querySelector('[data-operation-error]')?.hidden`), false);
    index = await count(); await select(); await waitFor(`photoTest.pending.length===${index + 1}`);
    await redraw(); await busy(); await reply(index);
    await waitFor(`!!document.querySelector('[role=dialog]')`);
    await noWrites();
    await js(`document.querySelector('[data-action=modal-cancel]').click()`);
    console.log(`PASS ${task} retains progress/error across redraw, ignores duplicates and retries into unsaved review`);

    // Departure after a redraw must dispose the original job, not a new empty binding.
    index = await count(); await select(); await waitFor(`photoTest.pending.length===${index + 1}`);
    await redraw(); await busy();
    await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-form=profile]')`);
    assert.equal(await js(`photoTest.pending[${index}].aborted`), true, `${task} aborts its original request on departure after redraw`);
    await go();
    const fresh = await count(); await select(); await waitFor(`photoTest.pending.length===${fresh + 1}`);
    await reply(index); await settle();
    assert.equal(await js(`!!document.querySelector('[role=dialog]')`), false, `${task} old reply cannot reopen review after returning`);
    await busy();
    await reply(fresh); await waitFor(`!!document.querySelector('[role=dialog]')`);
    await noWrites(); await js(`document.querySelector('[data-action=modal-cancel]').click()`);
    console.log(`PASS ${task} aborts departed work and late replies cannot affect a fresh visit`);

    index = await count(); await select(); await waitFor(`photoTest.pending.length===${index + 1}`);
    await redraw();
    await js(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
    assert.equal(await js(`photoTest.pending[${index}].aborted`), true, `${task} pagehide aborts after redraw`);
    await reply(index); await settle();
    assert.equal(await js(`!!document.querySelector('[role=dialog]')`), false, `${task} pagehide suppresses a late review`);
    await noWrites();
    await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-form=profile]')`);
  }

  await startPhoto('#/debts/'+await js('photoTest.debtId'), 'extract_debt_statement', 'Matching statement details…', {balance_text:'900.00',rate_text:'3.5',payment_text:'45.00'});
  await startPhoto('#/insurance', 'extract_policy', 'Matching policy details…', {type:'health',insurer:'Fake photo test',premium_text:'10.00',frequency:'monthly'});
  await startPhoto('#/investments', 'extract_holdings_statement', 'Matching statement positions…', {rows:[{name:'Fake photo holding',value_text:'100.00',match_id:null}]});
} finally {
  await browser?.close();
  server.stop();
}

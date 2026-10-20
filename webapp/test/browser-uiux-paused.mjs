// Closeout containment: real UI and direct entry points, fake records/provider only.
import assert from 'node:assert/strict';
import {startServer, startChrome} from './browser-kit.mjs';
const server = await startServer({AUTH:'off'}); let browser;
try {
  browser = await startChrome({width:360,height:900});
  const {cmd,js,waitFor} = browser;
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.pausedAiCalls=0; const realFetch=window.fetch.bind(window);
    window.fetch=async(url,options)=>{
      const path=String(url?.url||url).split(/[?#]/)[0];
      if(path.endsWith('/api/ai/status')) return new Response(JSON.stringify({configured:true,sign_in_required:false}),{status:200,headers:{'Content-Type':'application/json'}});
      if(path.endsWith('/api/ai')) {window.pausedAiCalls++;throw new Error('Paused feature attempted a provider request');}
      return realFetch(url,options);
    };`});
  await cmd('Page.navigate',{url:server.url+'?demo=1#/home'});
  await waitFor(`!!document.querySelector('.home-panel')&&!!localStorage.getItem('pfa.demo')`);
  await js(`(async()=>{
    const {store}=await import('./js/lib/store.js'), P=await import('./js/features/profile.js'), ai=await import('./js/lib/ai.js');
    window.pausedTest={store}; await store.retryPending();
    const receipt=store.captureAction('paused-fixtures',()=>{
      const p=P.profile();store.update('profile',p.id,{consent:{...p.consent,ai_provider:true}});
      const row=store.insert('briefings',{period:{kind:'month',start:'2026-09-01',end:'2026-09-30'},stats:{currency:'USD',incomplete_reasons:[]},summary:'Private saved briefing',levers:[],options:[],overlaps:[],read_at:null});
      window.pausedTest.briefingId=row.id;
      store.insert('conversations',{messages:[{role:'user',text:'Private saved conversation'}]});
      store.upsertOne('home_layout',{panel_key:'briefing'});
    });await store.commit(receipt);await ai.refreshStatus();
  })()`);
  await waitFor(`document.querySelector('.home-panel')?.dataset.wid==='widget:budget'`);
  assert.equal(await js(`import('./js/lib/ai.js').then(ai=>ai.enabled())`),true,'pause must hold even with consent and configured provider');
  assert.equal(await js(`!!document.querySelector('[data-tab=chat]')`),true);
  assert.equal(await js(`!!document.querySelector('[data-tab=budgets]')`),false);
  const snapshot = () => js(`(async()=>{await pausedTest.store.retryPending();return JSON.stringify(pausedTest.store.snapshot())})()`);
  const before = await snapshot(), durableBefore = await js(`localStorage.getItem('pfa.demo')`);
  const results = await js(`(async()=>{
    const INS=await import('./js/features/insights.js');
    return [await INS.buildBriefing({start:'2026-09-01',end:'2026-09-30'}),await INS.briefingDue(),await INS.deepDive({kind:'period',months:3})];
  })()`);
  assert.deepEqual(results,[null,null,null]);
  assert.equal(await js(`!!document.querySelector('[role=dialog]')`),false);
  assert.equal(await snapshot(),before,'direct calls save no conversation, alert, briefing or financial mutation');
  assert.equal(await js(`localStorage.getItem('pfa.demo')`),durableBefore);
  await js(`location.hash='#/chat?q=Old%20private%20question'`);await waitFor(`!!document.querySelector('[data-chat-form]')&&location.hash==='#/chat'`);assert.equal(await js(`window.pausedAiCalls`),0,'opening Assistant/stale bookmark is not an automatic send');assert.equal(await snapshot(),before,'opening chat does not overwrite saved conversation');
  for(const [hash,key] of [['#/briefing','briefings'],['#/briefing/'+await js(`pausedTest.briefingId`),'briefings'],['#/deepdive','deepDive']]) {
    await js(`location.hash=${JSON.stringify(hash)}`);
    await waitFor(`!!document.querySelector('[data-feature-paused=${key}]')`);
    assert.equal(await js(`document.querySelector('#app').textContent.includes('Private saved')`),false);
    assert.equal(await js(`!!document.querySelector('[data-form=chat],[data-form=dd],[data-action=build]')`),false);
    if(key==='assistant') assert.equal(await js(`location.hash`),'#/chat','old question is removed, never sent');
    assert.equal(await snapshot(),before,'paused route leaves saved data/read flags intact');
  }
  await cmd('Page.reload');
  await waitFor(`!!document.querySelector('[data-feature-paused=deepDive]')&&!!localStorage.getItem('pfa.demo')`);
  await js(`import('./js/lib/store.js').then(({store})=>window.pausedTest={store})`);
  assert.equal(await snapshot(),before,'reload does not automatically generate a briefing or erase data');
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.home_layout[0].panel_key`),'briefing');
  assert.equal(await js(`window.pausedAiCalls`),0);
  console.log('PASS Assistant opens without proactive calls; unrelated direct calls/bookmarks/reload stay paused and saved results survive');

  const loan = await js(`(async()=>{
    const DB=await import('./js/features/debts.js');const d=DB.list('active').find(d=>d.name==='Car loan');
    return {id:d.id,months:DB.projection(d).monthsToClear};
  })()`);
  await js(`location.hash='#/debts/${loan.id}'`);await waitFor(`!!document.querySelector('[data-form=whatif]')`);
  const projection = await js(`([...document.querySelectorAll('.card h2')].find(h=>h.textContent==='Projection')).closest('.card').textContent`);
  assert.ok(projection.includes('Estimated '+loan.months+' months to clear'));
  assert.equal(projection.includes('→'),false,'no calendar payoff promise');
  assert.equal(await js(`JSON.parse(document.querySelector('[data-chart=payoff]').dataset.points).every((p,i)=>p.x===(i===0?'now':String(i)))`),true,'all projected chart labels are payment-month numbers');
  const beforeWhatIf = await snapshot();
  await js(`const f=document.querySelector('[data-form=whatif]');f.elements.extra.value='12.34';f.requestSubmit()`);
  assert.equal(await js(`document.querySelector('[data-whatif]').textContent.includes('Estimated')&&!document.querySelector('[data-whatif]').textContent.includes('→')`),true);
  assert.equal(await snapshot(),beforeWhatIf,'what-if remains read-only');
  console.log('PASS Debt forecasts show estimated months, not invented calendar dates; What-if changes nothing');

  const txCount = await js(`pausedTest.store.all('transactions').length`);
  const savedResults = await js(`JSON.stringify([pausedTest.store.all('briefings'),pausedTest.store.all('conversations')])`);
  await js(`location.hash='#/add'`);await waitFor(`!!document.querySelector('[data-door=expense]')`);
  await js(`document.querySelector('[data-door=expense]').click()`);await waitFor(`!!document.querySelector('[data-modal-form] [name=amount]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');window.manualCloseoutForm=f;f.elements.amount.value='12.34';f.elements.merchant.value='Manual closeout check';f.requestSubmit()})()`);
  await waitFor(`!window.manualCloseoutForm.isConnected`);await snapshot();
  // A successful save may open the independent optional-category prompt.
  if (await js(`document.querySelector('[role=dialog] h2')?.textContent==='Turn on subcategories?'`)) {
    await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  }
  assert.equal(await js(`pausedTest.store.all('transactions').length`),txCount+1);
  assert.equal(await js(`JSON.stringify([pausedTest.store.all('briefings'),pausedTest.store.all('conversations')])`),savedResults);
  assert.equal(await js(`window.pausedAiCalls`),0);
  await js(`location.hash='#/transactions?q=Manual%20closeout%20check'`);
  await waitFor(`document.querySelector('#app')?.textContent.includes('Manual closeout check')`);
  assert.deepEqual(browser.problems(),[]);
  console.log('PASS manual confirmed saving and Records search still work with all problem features paused');
} finally {browser?.close();server.stop();}

// Investment U4 forms and statement preflight in disposable demo storage.
import assert from 'node:assert/strict';
import { startServer, startChrome } from './browser-kit.mjs';
const server=await startServer({AUTH:'off'});let browser;
try {
  browser=await startChrome({width:390,height:1000});const {cmd,js,waitFor}=browser;
  await cmd('Page.navigate',{url:`${server.url}?demo=1#/home`});
  await waitFor(`!!document.querySelector('.home-panel')`);
  await js(`(async()=>{const {store}=await import('./js/lib/store.js'),P=await import('./js/features/profile.js'),{seedDemoSteps}=await import('./js/features/seed.js'),{session}=await import('./js/lib/session.js');store.open(null,null,'investments-browser-demo');P.createProfile(P.DEMO_PROFILE());store.captureAction('investment-demo-fixture',()=>{for(const step of seedDemoSteps()){}});const saved=store.snapshot();localStorage.setItem('pfa.demo',JSON.stringify(saved));store.open(saved,async db=>localStorage.setItem('pfa.demo',JSON.stringify(db)),'investments-browser-demo');const ai=await import('./js/lib/ai.js');window.statementOutput=null;const real=window.fetch.bind(window);window.fetch=async(url,options)=>{const path=String(url);if(path.includes('/api/ai/status'))return new Response(JSON.stringify({configured:true,sign_in_required:false}),{status:200,headers:{'Content-Type':'application/json'}});if(path.includes('/api/ai'))return new Response(JSON.stringify({output:window.statementOutput}),{status:200,headers:{'Content-Type':'application/json'}});return real(url,options)};await ai.refreshStatus();const p=store.one('profile');store.update('profile',p.id,{consent:{...p.consent,ai_provider:true}});session.mode='demo';session.render();location.hash='#/investments';})()`);
  await waitFor(`!!document.querySelector('[data-action=new]')`);
  const snapshot=()=>js(`(async()=>{const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot())})()`);

  console.log('Investment browser: disposable fixture ready');
  const beforeCreate=JSON.parse(await snapshot());
  await js(`document.querySelector('[data-action=new]').click()`);await waitFor(`!!document.querySelector('[name=name]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.name.value='';f.elements.type.value='unsupported';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=name]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`document.querySelector('[name=type]')?.getAttribute('aria-invalid')==='true'`),true,'holding form reports independent name and enum errors');
  assert.equal(await snapshot(),JSON.stringify(beforeCreate),'invalid create writes nothing');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');for(const [n,v] of [['name','UI validation position'],['type','fund']]){f.elements[n].value=v;f.elements[n].dispatchEvent(new Event('input',{bubbles:true}));f.elements[n].dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  assert.equal(await js(`!document.querySelector('[name=name]').hasAttribute('aria-invalid')&&!document.querySelector('[name=type]').hasAttribute('aria-invalid')`),true,'holding correction clears only corrected errors quietly');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);
  const made=await js(`(async()=>{const I=await import('./js/features/investments.js');return I.list().find(h=>h.name==='UI validation position').id})()`);
  await js(`location.hash='#/investments/'+${JSON.stringify(made)}`);
  await waitFor(`!!document.querySelector('[data-action=buy]')`);
  let before=JSON.parse(await snapshot()),tradesBefore=before.tables.trades.length;
  await js(`document.querySelector('[data-action=buy]').click()`);await waitFor(`!!document.querySelector('[name=units]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.units.value='0';f.elements.price.value='bad';f.elements.date.value='2099-01-01';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=units]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`['price','date'].every(n=>document.querySelector('[name='+n+']')?.getAttribute('aria-invalid')==='true')`),true,'trade shows compound units, money, and date issues');
  assert.equal(await snapshot(),JSON.stringify(before),'invalid trade changes no rows');
  await js(`(async()=>{const f=document.querySelector('[data-modal-form]'),{today}=await import('./js/features/profile.js');for(const [n,v] of [['units','1'],['price','10'],['date',today()]]){f.elements[n].value=v;f.elements[n].dispatchEvent(new Event('input',{bubbles:true}));f.elements[n].dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);
  assert.equal(JSON.parse(await snapshot()).tables.trades.length,tradesBefore+1,'corrected trade saves exactly once');

  await js(`document.querySelector('[data-action=deposit]').click()`);await waitFor(`!!document.querySelector('[name=amount]')`);
  before=JSON.parse(await snapshot());const flowsBefore=before.tables.cash_flows.length;
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.amount.value='0';f.elements.date.value='2099-01-01';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=amount]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`document.querySelector('[name=date]')?.getAttribute('aria-invalid')==='true'`),true,'flow reports amount and date issues');assert.equal(await snapshot(),JSON.stringify(before),'invalid flow writes nothing');
  await js(`(async()=>{const f=document.querySelector('[data-modal-form]'),{today}=await import('./js/features/profile.js');f.elements.amount.value='1';f.elements.date.value=today();for(const c of [f.elements.amount,f.elements.date]){c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);assert.equal(JSON.parse(await snapshot()).tables.cash_flows.length,flowsBefore+1,'corrected flow saves exactly once');

  await js(`document.querySelector('[data-action=value]').click()`);await waitFor(`!!document.querySelector('[name=value]')`);
  before=JSON.parse(await snapshot());const valuesBefore=before.tables.valuations.length;
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.value.value='bad';f.elements.date.value='2099-01-01';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=value]')?.getAttribute('aria-invalid')==='true'`);assert.equal(await js(`document.querySelector('[name=date]')?.getAttribute('aria-invalid')==='true'`),true,'value reports amount and date issues');assert.equal(await snapshot(),JSON.stringify(before),'invalid value writes nothing');
  await js(`(async()=>{const f=document.querySelector('[data-modal-form]'),{today}=await import('./js/features/profile.js');f.elements.value.value='0';f.elements.date.value=today();for(const c of [f.elements.value,f.elements.date]){c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);assert.equal(JSON.parse(await snapshot()).tables.valuations.length,valuesBefore+1,'corrected zero value saves exactly once');

  const usd=await js(`(async()=>{const I=await import('./js/features/investments.js');return I.create({name:'USD validation position',type:'fund',currency:'USD',mode:'value'}).id})()`);
  await js(`location.hash='#/investments/'+${JSON.stringify(usd)}`);await waitFor(`!!document.querySelector('[data-action=value]')`);
  await js(`document.querySelector('[data-action=value]').click()`);await waitFor(`!!document.querySelector('[name=rate]')`);
  before=JSON.parse(await snapshot());
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.value.value='bad';f.elements.rate.value='not-a-rate';f.requestSubmit()})()`);
  await waitFor(`document.querySelector('[name=value]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await js(`document.querySelector('[name=rate]')?.getAttribute('aria-invalid')==='true'`),true,'foreign invalid amount and typed rate appear together');assert.equal(await snapshot(),JSON.stringify(before),'foreign validation has no write');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');for(const [n,v] of [['value','1'],['rate','1.3']]){f.elements[n].value=v;f.elements[n].dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);

  console.log('Investment browser: create, trade, flow, value and manual-rate journeys complete');
  await js(`location.hash='#/investments'`); await waitFor(`!!document.querySelector('[data-action=photo]')`);
  await js(`(async()=>{const input=document.querySelector('[data-action=photo]'),data=new DataTransfer();window.statementOutput={as_of:(await import('./js/features/profile.js')).today(),rows:[{name:'Statement good',ticker:null,value_text:'12.00',currency:'SGD',match_id:null},{name:'Statement bad',ticker:null,value_text:'not-money',currency:'SGD',match_id:null}]};const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));data.items.add(new File([image],'statement.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await waitFor(`!!document.querySelector('[name=inc_0]')`);
  assert.equal(await js(`(()=>{const i=document.querySelector('[name=inc_0]'),n=document.querySelector('[name=name_0]'),m=document.querySelector('[name=match_0]');return !!i.getAttribute('aria-label')&&n.labels.length===1&&n.labels[0].textContent.includes('Row 1')&&m.labels.length===1&&m.labels[0].textContent.includes('Match row 1')})()`),true,'statement Include, Name and Match controls have distinct row/date context');
  before=JSON.parse(await snapshot());const holdsBefore=before.tables.holdings.length,valsBefore=before.tables.valuations.length;
  await js(`document.querySelector('[name=inc_1]').checked=true;document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`document.querySelector('[name=name_1]')?.getAttribute('aria-invalid')==='true'`);
  assert.equal(await snapshot(),JSON.stringify(before),'bad second included row blocks all earlier statement writes');
  await js(`(()=>{const c=document.querySelector('[name=inc_1]');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  assert.equal(await js(`!document.querySelector('[name=name_1]').hasAttribute('aria-invalid')`),true,'unchecking bad row quietly clears its row error');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!document.querySelector('[role=dialog]')`);
  const after=JSON.parse(await snapshot());assert.equal(after.tables.holdings.length,holdsBefore+1,'included new statement holding creates after preflight');assert.equal(after.tables.valuations.length,valsBefore+1,'included statement value saves after preflight');
  assert.equal(browser.problems().length,0,browser.problems().join('\n'));
  console.log('PASS investment create/trade/flow/value validation, corrections, and statement preflight');
} finally { browser?.close();server.stop(); }

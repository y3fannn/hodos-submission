// Mobile demo preparation, delayed feedback, cancellation/failure and live budget linkage.
// All identities/financial records are local stand-ins; never touches production.
import assert from 'node:assert/strict';
import { startServer, startChrome, sleep } from './browser-kit.mjs';
const srv=await startServer(), B=await startChrome({width:360,height:900});
let checks=0;
const ok=(v,n)=>{assert.ok(v,n);checks++;console.log('PASS',n);};
const click=(s)=>B.js(`document.querySelector(${JSON.stringify(s)}).click()`);
const entry=()=>B.waitFor(`!!document.querySelector('[data-action=demo]') && document.getElementById('app').getAttribute('aria-busy') !== 'true'`);
const leave=async()=>{await B.js(`import('./js/lib/session.js').then(({session})=>session.endDemo({signup:true}))`);await entry();};
try {
 await B.cmd('Page.navigate',{url:srv.url+'#/signin'}); await entry();
 // A controlled helper operation locks interactions instantly, but fast completion never paints a spinner.
 ok(await B.js(`import('./js/lib/demo-loading.js').then(({beginDemoTransition})=>{const done=beginDemoTransition();const hidden=document.querySelector('.demo-loading').hidden;done();done();return hidden && !document.querySelector('.demo-loading') && !document.getElementById('app').inert;})`),'fast transition stays invisible and cleanup is idempotent');
 for (const theme of ['light','dark']) {
   await B.js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; import('./js/lib/demo-loading.js').then(({beginDemoTransition})=>{window.__finishLoading=beginDemoTransition();window.__loadingAt=performance.now()})`);
   ok(await B.js(`document.querySelector('.demo-loading').hidden && document.getElementById('app').inert && document.querySelector('[data-action=demo]').disabled`),theme+': entry is disabled immediately; overlay initially hidden');
   await B.waitFor(`!document.querySelector('.demo-loading').hidden`);
   ok(await B.js(`performance.now()-window.__loadingAt>=190 && document.querySelector('.demo-loading').getAttribute('role')==='status'`),theme+': centred accessible overlay appears only after delay');
   await B.shot('demo-loading-'+theme);
   await B.cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   ok(await B.js(`getComputedStyle(document.querySelector('.demo-loading-ring')).animationName==='none'`),theme+': reduced motion uses a still ring');
   await B.js(`window.__finishLoading()`);
   ok(await B.js(`!document.querySelector('.demo-loading') && !document.getElementById('app').inert && !document.querySelector('[data-action=demo]').disabled`),theme+': no extra waiting; controls restored');
 }
 await B.cmd('Emulation.setEmulatedMedia',{features:[]});
 // Observe actual work without changing its recipe or scheduling.
 await B.js(`(()=>{const d=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');Object.defineProperty(Element.prototype,'innerHTML',{...d,set(v){if(window.__perf && this.id==='app')window.__perf.renders++;d.set.call(this,v)}});const save=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__perf && k==='pfa.demo'){window.__perf.saves++;const saved=JSON.parse(v);window.__demoAtSave=saved;const t=saved.tables;if(t.accounts.length!==4||t.transactions.length<=1000||t.holdings.length!==6||t.nw_snapshots.length!==25)window.__perf.partialSaves++;}return save.call(this,k,v)};new MutationObserver(()=>{const p=window.__perf,o=document.querySelector('.demo-loading');if(p&&o&&!o.hidden&&p.shownAt===null)p.shownAt=performance.now()-p.start;}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});})()`);
 for (const rate of [1,4]) {
   await B.cmd('Emulation.setCPUThrottlingRate',{rate});
   await B.js(`(()=>{window.__perf={start:performance.now(),renders:0,saves:0,partialSaves:0,shownAt:null,firstFrame:null,frames:0};const frame=()=>{const p=window.__perf;p.frames++;p.firstFrame??=performance.now()-p.start;if(document.getElementById('app').getAttribute('aria-busy')==='true')requestAnimationFrame(frame)};requestAnimationFrame(frame);document.querySelector('[data-action=demo]').click();window.__perf.handlerMs=performance.now()-window.__perf.start;})()`);
   await B.waitFor(`!!document.querySelector('.demo-banner') && !document.querySelector('.demo-loading') && document.getElementById('app').getAttribute('aria-busy') !== 'true'`);
   await sleep(400);
   const p=await B.js(`({...window.__perf,totalMs:performance.now()-window.__perf.start-400})`);
   console.log('DEMO_TIMING',JSON.stringify({rate,...p}));
   ok(p.renders<=4 && p.handlerMs<1000,'CPU '+rate+': bounded page rebuilds and no multi-second click handler');
   ok(p.saves===1 && p.partialSaves===0,'CPU '+rate+': one completed-only sample save');
   ok(await B.js(`import('./js/lib/store.js').then(({store})=>JSON.stringify(window.__demoAtSave)===JSON.stringify(store.snapshot()))`),'CPU '+rate+': persisted sample equals the entire final record set, not a partial seed');
   ok(p.frames>1,'CPU '+rate+': browser can draw during preparation');
   const counts=await B.js(`import('./js/lib/store.js').then(({store})=>store.counts())`);
   ok(counts.accounts===4 && counts.transactions>1000 && counts.holdings===6,'CPU '+rate+': full demo preserved');
   await leave();
 }
 await B.cmd('Emulation.setCPUThrottlingRate',{rate:1});
 // Duplicate controller calls share the same preparation, rather than rebuilding/seeding twice.
 ok(await B.js(`import('./js/lib/session.js').then(({session})=>{const a=session.startDemo(),b=session.startDemo();window.__lastDemo=a;return a===b;})`),'duplicate starts share one job');
 await B.js(`window.__lastDemo`); await B.waitFor(`!!document.querySelector('.demo-banner')`); await leave();
 await B.js(`import('./js/lib/session.js').then(({session})=>{window.__lastDemo=session.startDemo();location.hash='#/signin';})`);
 await B.js(`window.__lastDemo`); await entry();
 ok(await B.js(`!document.querySelector('.demo-banner,.demo-loading') && !localStorage.getItem('pfa.demo') && !document.getElementById('app').inert`),'navigation cancels partial setup and restores entry');
 // An authentication change during a yield must discard all partial samples.
 await B.js(`Promise.all([import('./js/lib/session.js'),import('./js/lib/account.js')]).then(([{session},account])=>{window.__lastDemo=session.startDemo();account.state.signedIn=true;})`);
 await B.js(`window.__lastDemo`);
 ok(await B.js(`!document.querySelector('.demo-banner,.demo-loading') && !localStorage.getItem('pfa.demo')`),'authentication change cannot complete an in-flight demo');
 await B.js(`import('./js/lib/account.js').then(a=>a.refresh()).then(()=>import('./js/lib/session.js')).then(({session})=>session.render())`); await entry();
 // Failure at a fixture write unwinds controls/persistence. Restore the method before retrying.
 await B.js(`import('./js/lib/store.js').then(({store})=>{window.__insert=store.insert;store.insert=function(...args){if(args[0]==='nw_snapshots')throw new Error('DEMO_FAILURE_FIXTURE');return window.__insert.apply(this,args)}})`);
 await click('[data-action=demo]'); await entry();
 ok(await B.js(`!document.querySelector('.demo-loading,.demo-banner') && !localStorage.getItem('pfa.demo') && document.getElementById('toast-root').textContent.includes('Could not open demo')`),'failure discards samples and restores retry with a safe message');
 await B.js(`import('./js/lib/store.js').then(({store})=>{store.insert=window.__insert})`);
 await click('[data-action=demo]'); await B.waitFor(`!!document.querySelector('.demo-banner')`);
 // Real expense form: persistence and screen updates must resume after the batch.
 await B.js(`(async()=>{const b=await import('./js/features/budgets.js'),a=await import('./js/features/accounts.js'),{store}=await import('./js/lib/store.js');window.__bank=store.all('accounts').find(x=>x.name==='Main bank').id;window.__food=store.all('categories').find(x=>x.name==='Food'&&!x.parent_id).id;window.__moneyState=()=>{const f=b.status().find(x=>x.name==='Food');return {spent:f.spent.amount,left:f.left.amount,balance:a.balance(window.__bank).amount,count:store.all('transactions').length}}})()`);
 const before=await B.js(`window.__moneyState()`);
 await B.js(`location.hash='#/add'`);await B.waitFor(`!!document.querySelector('[data-door=expense]')`);await click('[data-door=expense]');await B.waitFor(`!!document.querySelector('[data-modal-form]')`);
 await B.js(`(()=>{const f=document.querySelector('[data-modal-form]');f.account_id.value=window.__bank;f.amount.value='12.50';f.currency.value='SGD';f.category_id.value=window.__food;f.merchant.value='Demo loading budget probe';f.requestSubmit()})()`);
 await B.waitFor(`!document.querySelector('[data-modal-form]') || document.querySelector('.modal h2')?.textContent === 'Turn on subcategories?'`);
 // The first ordinary write may offer the documented optional subcategory setup; it is not a stuck save.
 if (await B.js(`document.querySelector('.modal h2')?.textContent === 'Turn on subcategories?'`)) {
   await click('[data-action=modal-cancel]');
   ok(await B.js(`import('./js/lib/store.js').then(({store}) => !store.one('profile').subcategories_enabled)`),'Not now keeps subcategories optional after the saved expense');
 }
 await B.waitFor(`!document.querySelector('[data-modal-form]')`);await B.js(`location.hash='#/budgets'`);await B.waitFor(`!!document.querySelector('.cat-row')`);
 const after=await B.js(`window.__moneyState()`);
 ok(after.count===before.count+1 && after.spent===before.spent+1250 && after.left===before.left-1250 && after.balance===before.balance-1250,'normal expense writes update the account and budget after preparation');
 ok(await B.js(`!![...document.querySelectorAll('.cat-row')].find(x=>x.querySelector('.cat-name').textContent==='Food')`),'updated Food row renders');
 const problems=B.problems().filter(x=>!x.includes('DEMO_FAILURE_FIXTURE'));
 ok(problems.length===0,'no unexpected browser errors or blocked assets');
 console.log(`${checks} demo-loading browser checks passed; screenshots: ${B.shots}`);
} finally {B.close();srv.stop();}

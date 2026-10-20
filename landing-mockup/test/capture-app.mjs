// Fictional Alex product views, rendered by unchanged native components outside app boot/auth.
// This is image authoring, NOT a real account, provider response, import or security acceptance test.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChrome } from '../../webapp/test/browser-kit.mjs';

const publicRoot = fileURLToPath(new URL('../../webapp/public/', import.meta.url));
const assets = new URL('../assets/', import.meta.url);
const evidence = new URL('../evidence/', import.meta.url);
const started = new Date().toISOString();
const scrollPreview = process.argv.includes('--scroll-preview');
const homeOnly = process.argv.includes('--home-only');
const insuranceOnly = process.argv.includes('--insurance-only');
const assistantRecordsOnly = process.argv.includes('--assistant-records-only');
const marketing = process.argv.includes('--marketing') || assistantRecordsOnly;
const scale = scrollPreview ? 4 : 3;
const scrollNames = new Set(['goals', 'budgets', 'budget-safe', 'assistant']);
const sourceHtml = (await fs.readFile(resolve(publicRoot, 'index.html'), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link[^>]*rel="manifest"[^>]*>/g, '');
const requests = [];
// Static local source only; no server.js, private .env, account database or provider adapter loaded.
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  requests.push({ method: request.method, path: pathname });
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (pathname === '/capture.html') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(sourceHtml); return; }
  // Status stub enables existing native input controls; it never supplies model output or identity.
  if (pathname === '/api/ai/status') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ configured: true, sign_in_required: true })); return; }
  const path = resolve(publicRoot, '.' + pathname);
  if (!path.startsWith(resolve(publicRoot) + sep) || !['.js', '.css', '.svg', '.png'].includes(extname(path))) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { 'Content-Type': { '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png' }[extname(path)] }).end(await fs.readFile(path)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.mkdir(assets, { recursive: true }); await fs.mkdir(evidence, { recursive: true });
let browser;
try {
  browser = await startChrome({ width:420, height:780 });
  const { cmd, js, waitFor } = browser;
  await cmd('Emulation.setDeviceMetricsOverride', { width:420, height:780, deviceScaleFactor:scale, mobile:true });
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
    const NativeDate=Date;
    window.captureDate='2026-10-16T12:00:00Z';
    window.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[window.captureDate]));} static now(){return new NativeDate(window.captureDate).getTime();} };
    const nativeFetch=window.fetch;
    window.fetch=(input,options={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin||options.method&&options.method!=='GET')throw new Error('Capture blocks external/write requests');return nativeFetch(input,options);};
  ` });
  await cmd('Page.navigate', { url:origin+'/capture.html' });
  await waitFor(`!!document.getElementById('app') && !!document.styleSheets.length`);
  await js(`(${prepareAlex.toString()})()`);
  if (marketing) {
    await js(`F.marketing=true; F.populate(); F.T.update(F.coffee.id,{money:F.money(450,'SGD')}); F.plan()`);
    const views=[];
    async function saveMarketing(name, expression, selectors = null) {
      if (assistantRecordsOnly && name !== 'assistant-records') return;
      await cmd('Emulation.setDeviceMetricsOverride',{width:selectors&&!name.endsWith('-mobile')?760:420,height:1000,deviceScaleFactor:3,mobile:false});
      await js(`F.show(${expression},${JSON.stringify(name)})`);
      if(name==='add-filled') await js(`F.T.confirmModal({...F.coffee,merchant:'Station Coffee',note:'Morning coffee',money:F.money(450,'SGD')},{title:'New expense',suppressCategoryAI:true});true`);
      if(name==='salary-review') await js(`document.querySelector('[data-edit="'+F.T.rules().find(r=>r.name==='Salary').id+'"]').click()`);
      let clip;
      if(selectors) {
        await js(`(()=>{const root=document.getElementById('app'),panel=document.createElement('div');panel.className='capture-panel';for(const selector of ${JSON.stringify(selectors)}){const node=root.querySelector(selector);if(!node)throw new Error('Missing native crop '+selector);const copy=node.cloneNode(true);copy.querySelectorAll('p,.actions,details,.chips').forEach(n=>n.remove());if(${JSON.stringify(name)}.startsWith('investments'))copy.querySelectorAll('.num-row').forEach((n,i)=>{if(i>2)n.remove()});panel.append(copy)}root.replaceChildren(panel);const style=document.createElement('style');style.textContent='#topbar,.tabbar{display:none!important}body{padding:0!important}.page{padding:0!important;margin:0!important;max-width:none!important}.capture-panel{width:${name.endsWith('-mobile')?420:760}px;padding:20px;box-sizing:border-box}.capture-panel>.tag{margin:0}.capture-panel>.card,.capture-panel>.stat{margin:0 0 16px}.capture-panel>.card:last-child{margin-bottom:0}';document.head.append(style)})()`);
        await js(`document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`);
        clip=await js(`(()=>{const r=document.querySelector(${JSON.stringify(name==='ai-badge'?'.capture-panel>.tag':'.capture-panel')}).getBoundingClientRect(),pad=${name==='ai-badge'?8:0};return {x:r.x+scrollX-pad,y:r.y+scrollY-pad,width:r.width+pad*2,height:r.height+pad*2,scale:1}})()`);
      } else {
        await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:780,deviceScaleFactor:3,mobile:true});
        await js(`document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`);
      }
      const image=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:Boolean(clip),...(clip?{clip}:{})});
      const bytes=Buffer.from(image.result.data,'base64'),file=`${selectors?'native':'alex'}-${name}.png`;
      await fs.writeFile(new URL(file,assets),bytes);
      views.push({file,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),nativeText:await js(`document.getElementById('app').innerText`)});
      console.log('CAPTURE',file,views.at(-1).width,views.at(-1).height);
      // Each source page starts fresh; crop-only style must not affect subsequent images.
      await js(`document.querySelectorAll('style').forEach(e=>{if(e.textContent.includes('.capture-panel'))e.remove()})`);
    }
    await saveMarketing('assistant-records',`F.chatView({messages:[{role:'user',text:'Can you help organise my money records?'},{role:'assistant',origin:'ai',text:'Share your statements or receipts and we can review the entries together'},{role:'user',text:'Uploaded files for financial review',file_names:['July statement.pdf']}]})`);
    assert.equal(await js(`document.querySelector('[data-file-card]')?.textContent`),'July statement.pdf','Actual native filename card, no screenshot-only UI');
    await saveMarketing('add-filled','F.T.addPage()');
    await js(`(async()=>{(await import('/js/lib/ui.js')).cancelModal('capture-complete')})()`);
    await saveMarketing('salary-review','F.T.recurringPage()');
    await js(`(async()=>{(await import('/js/lib/ui.js')).cancelModal('capture-complete')})()`);
    await saveMarketing('goals','F.G.goalsPage()',['.goal-card']);
    await saveMarketing('investments','F.H.investmentsPage()',['.disclaimer','.stat','.card:nth-of-type(2)','.card:nth-of-type(3)']);
    await saveMarketing('networth','F.NW.netWorthPage()',['.stat','.card']);
    await saveMarketing('ai-badge','F.T.addPage()',['.tag.ai']);
    await saveMarketing('goals-mobile','F.G.goalsPage()',['.goal-card']);
    await saveMarketing('investments-mobile','F.H.investmentsPage()',['.disclaimer','.stat','.card:nth-of-type(2)','.card:nth-of-type(3)']);
    await saveMarketing('networth-mobile','F.NW.netWorthPage()',['.stat','.card']);
    const facts=await js(`({facts:F.facts(),snapshots:F.NW.snapshots(),contributions:F.G.contributions(F.goal.id),investmentSeries:F.H.series()})`);
    assert.equal(facts.facts.goal.progress.amount,40000);assert.equal(facts.facts.networth.total.amount,1209300);
    assert.equal(facts.snapshots.length,4);assert.equal(facts.contributions.length,3);
    assert.ok(requests.every(r=>r.method==='GET'));assert.deepEqual(browser.problems(),[]);
    await fs.writeFile(new URL(assistantRecordsOnly ? 'assistant-records-capture.json' : 'marketing-capture.json',evidence),JSON.stringify({started,ended:new Date().toISOString(),method:'Native feature components, memory-only fictional history, native-calculated charts and figures; selected native cards cropped/rearranged, no provider/account/import/attack acceptance',views,...facts,requests},null,2)+'\n');
    console.log('DONE marketing native captures',new Date().toISOString());
  } else if (process.argv.includes('--inspect-debt')) {
    await js(`F.populate(); F.T.update(F.coffee.id,{money:F.money(450,'SGD')}); F.plan(); F.show(F.DB.debtDetailPage(F.loan.id),'debt-detail')`);
    await js(`document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`);
    const layout = await js(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('#app *')].map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width,text:e.textContent.slice(0,90),whiteSpace:getComputedStyle(e).whiteSpace})).filter(e=>e.right>421).slice(-25)})`);
    console.log('DEBT_LAYOUT',JSON.stringify(layout,null,2));
    await fs.writeFile(new URL('alex-debt-layout.json',evidence),JSON.stringify(layout,null,2)+'\n');
  } else {
  const views = [];
  async function capture(name, expression, focus = null) {
    if (scrollPreview && !scrollNames.has(name) || homeOnly && name !== 'home' || insuranceOnly && name !== 'insurance') return;
    await js(`F.show(${expression},${JSON.stringify(name)})`);
    // Equivalent visible plus glyph in the isolated renderer; no label meaning/control/data change.
    if (scrollPreview && name === 'goals') await js(`document.querySelectorAll('#app [data-action=new],#app [data-contrib]').forEach(button=>{button.textContent=button.textContent.replace(/＋/g,'+')})`);
    if (name === 'empty' || name === 'home') await js(`(() => {const later=document.querySelector('[data-install=later]');if(later){later.click();F.show(F.W.homePage(),${JSON.stringify(name)});}})()`);
    if (name === 'correction-review') await js(`F.T.confirmModal({...F.coffee,money:F.money(450,'SGD')},{title:'Review coffee correction',existing:F.coffee,suppressCategoryAI:true});true`);
    if (focus) await js(`(() => {const node=${focus};if(!node)throw new Error('Capture focus missing: ${name}');window.scrollTo(0,node.getBoundingClientRect().top+scrollY-78);})()`);
    // Display-only punctuation polish; native figures, stored values and source remain untouched.
    await js(`(() => {const walk=document.createTreeWalker(document.getElementById('app'),NodeFilter.SHOW_TEXT);while(walk.nextNode())walk.currentNode.textContent=walk.currentNode.textContent.replace(/\\.(?=\\s|$)/g,'');})()`);
    await js(`document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))`);
    assert.equal(await js(`!!document.querySelector('.demo-banner')`),false);
    assert.equal(await js(`document.documentElement.scrollWidth<=420`),true,`${name} source reflow`);
    const result = await cmd('Page.captureScreenshot', { format:'png' });
    const bytes = Buffer.from(result.result.data,'base64');
    assert.equal(bytes.readUInt32BE(16),420 * scale); assert.equal(bytes.readUInt32BE(20),780 * scale);
    await fs.writeFile(new URL(`${scrollPreview ? 'scroll' : 'alex'}-${name}.png`,assets),bytes);
    views.push({ name, title:await js(`document.getElementById('topbar-title').textContent`), bytes:bytes.length });
    console.log('CAPTURE',name,bytes.length);
  }
  await capture('empty','F.W.homePage()');
  await js(`F.populate()`);
  await capture('record-before','F.T.transactionDetailPage(F.coffee.id)');
  await capture('correction-review','F.T.transactionDetailPage(F.coffee.id)');
  assert.equal(await js(`F.T.get(F.coffee.id).money.amount`),4500,'Opening a correction form must not save it');
  await js(`(async()=>{(await import('/js/lib/ui.js')).cancelModal('capture-complete');})()`);
  await js(`F.T.update(F.coffee.id,{money:F.money(450,'SGD')})`);
  await capture('record-after','F.T.transactionDetailPage(F.coffee.id)');
  await js(`F.plan()`);
  const facts = await js(`F.facts()`);
  assert.deepEqual([facts.bills.limit.amount,facts.bills.spent.amount,facts.bills.left.amount,facts.bills.upcoming.amount,facts.bills.safe.amount],[40000,32000,8000,5000,3000]);
  assert.equal(facts.expected.money.amount,500000); assert.equal(facts.coffee.money.amount,450);
  assert.ok(facts.recurring.some(item=>item.merchant==='SoundBox'));
  for (const [name,expression,focus] of [
    ['home','F.W.homePage()'], ['accounts','F.A.accountsPage()'], ['account-detail','F.A.accountDetailPage(F.bank.id)'],
    ['records','F.T.transactionsPage("")'], ['add','F.T.addPage()'], ['categories','F.C.categoriesPage()'],
    ['recurring','F.T.recurringPage()'], ['budgets','F.B.budgetsPage()'],
    ['budget-safe','F.B.budgetsPage()',`[...document.querySelectorAll('.cat-row')].find(row=>row.querySelector('.cat-name')?.textContent==='Bills & utilities')`],
    ['goals','F.G.goalsPage()'], ['debts','F.DB.debtsPage()'], ['debt-detail','F.DB.debtDetailPage(F.loan.id)'],
    ['insurance','F.I.insurancePage()'], ['investments','F.H.investmentsPage()'], ['investment-detail','F.H.investmentDetailPage(F.holding.id)'],
    ['networth','F.NW.netWorthPage()'], ['fx','F.T.transactionDetailPage(F.foreign.id)'], ['alerts','F.AL.alertsPage()'],
    ['settings','F.P.settingsPage()',`[...document.querySelectorAll('#app > .card')].find(card=>card.querySelector('h2')?.textContent==='Your data')`],
    ['assistant',`F.chatView({messages:[{role:'user',text:'How much can I still spend on bills this month?'},{role:'assistant',origin:'ai',text:'Your Bills & utilities budget has SGD 80 left after spending — a confirmed SGD 50 phone bill is still due, leaving SGD 30 safe to spend',figures:[{kind:'category_budget',display:[{label:'Left to spend',value:F.money(8000,'SGD')},{label:'Bills still due',value:F.money(5000,'SGD')},{label:'Safe to spend',value:F.money(3000,'SGD')}]}]}]})`],
  ]) await capture(name,expression,focus);
  if (!scrollPreview && !homeOnly && !insuranceOnly) {
    await js(`F.prepareMatch()`);
    await waitFor(`!!document.querySelector('[data-action=save]')`);
    // Keep the actual native match page after its local CSV mapping, rather than drawing a result.
    await capture('reconcile','F.R.statementPage(F.bank.id)');
  }
  assert.deepEqual(browser.problems(),[]);
  assert.ok(requests.every(request=>request.method==='GET'));
  await fs.writeFile(new URL(insuranceOnly ? 'insurance-capture.json' : homeOnly ? 'home-capture.json' : scrollPreview ? 'scroll-capture.json' : 'alex-capture.json',evidence),JSON.stringify({ scale, started, ended:new Date().toISOString(), fixtureAsOf:'2026-10-16', method:'Native normal-account feature renderers, memory-only fictional fixture, AI status stub and sample dialogue, no app boot/account/provider/import/attack evidence', displayAdjustments:['Native scroll-x wrapper around direct card tables preserves every value/control','Display-only sentence punctuation cleanup'], facts, views, requests },null,2)+'\n');
  console.log('DONE',views.length,'native views; code validates sample arithmetic; no provider/account traffic',started,new Date().toISOString());
  }
} finally { browser?.close(); await new Promise(done=>server.close(done)); }

// Executed only inside a fresh disposable capture browser. Never packaged with the website or app.
async function prepareAlex() {
  const names=['accounts','categories','transactions','budgets','goals','debts','insurance','investments','networth','alerts','profile','widgets','reconcile'];
  const modules=await Promise.all(names.map(name=>import('/js/features/'+name+'.js')));
  const [A,C,T,B,G,DB,I,H,NW,AL,P,W,R]=modules;
  const {store}=await import('/js/lib/store.js'),{money}=await import('/js/lib/money.js'),{session}=await import('/js/lib/session.js');
  const {icon}=await import('/js/lib/icons.js'),{chatView}=await import('/js/features/assistant-view.js');
  const fx=await import('/js/lib/fx.js'),theme=await import('/js/lib/theme.js'),ai=await import('/js/lib/ai.js');
  const account=await import('/js/lib/account.js');
  store.open(null,null,'fictional-alex-capture'); session.mode='open';
  P.createProfile({name:'Alex',base_currency:'SGD',timezone:'UTC',self_description:'working',ai_provider:true});
  Object.assign(account.state,{server:true,enabled:true,signedIn:true,account:{email:'alex@example.test',sessions:1,passkeys:1,recovery:true}});
  await ai.refreshStatus(); theme.setTheme('dark');
  const F=window.F={A,C,T,B,G,DB,I,H,NW,AL,P,W,R,store,money,session,chatView};
  let dispose;
  F.show=(page,name)=>{
    dispose?.({reason:'redraw'}); document.getElementById('modal-root').replaceChildren();
    const routes={records:'transactions',assistant:'chat',empty:'home',fx:'transactions'};
    const top=routes[name]||name; history.replaceState(null,'','#/'+top);
    const root=document.getElementById('app');root.innerHTML=page.html;
    // Capture-only presentation: reuse the app's existing table scroll frame, preserving every cell/control.
    for (const table of root.querySelectorAll('.card > table')) {
      const frame=document.createElement('div');frame.className='scroll-x';table.before(frame);frame.append(table);
    }
    document.getElementById('topbar-title').textContent=page.title;
    document.getElementById('lock-btn').hidden=false;
    const isTab=['home','transactions','add','chat','settings'].includes(top);
    document.getElementById('back-btn').hidden=isTab; document.getElementById('home-btn').hidden=!isTab;
    const tabs=[['home','home','Home'],['transactions','records','Records'],['add','add','Add'],['chat','assistant','Assistant'],['settings','settings','Settings']];
    const active=['recurring','categories','alerts'].includes(top)?'settings':top;
    document.getElementById('tabbar').innerHTML=tabs.map(([key,ic,label])=>`<a href="#/${key}" data-tab="${key}" class="${key==='add'?'tab-add':''} ${key===active?'active':''}"${key===active?' aria-current="page"':''}><i class="tab-ic">${icon(ic,{size:key==='add'?26:22})}</i><span>${label}</span></a>`).join('');
    window.scrollTo(0,0); dispose=page.bind?.(root);
    const badge=document.getElementById('alerts-badge'),count=AL.unread().length;badge.hidden=!count;badge.textContent=count;
  };
  session.render=()=>F.show(R.statementPage(F.bank.id),'reconcile');
  const cat=name=>C.all().find(c=>c.name===name&&!c.parent_id);
  const save=(kind,account,amount,date,category,merchant,note)=>T.save({kind,account_id:account.id,money:money(amount,account.currency),date,category_id:cat(category).id,merchant,note,source:'form'});
  F.populate=()=>{
    if(F.marketing)window.captureDate='2026-07-01T12:00:00Z';
    F.bank=A.create({name:'Main bank',type:'bank',currency:'SGD',openingBalance:money(300000,'SGD'),openedOn:'2026-07-01'});
    F.cash=A.create({name:'Cash',type:'cash',currency:'SGD',openingBalance:money(20000,'SGD'),openedOn:'2026-07-01'});
    F.card=A.create({name:'Credit card',type:'credit',currency:'SGD',openingBalance:money(0,'SGD'),openedOn:'2026-07-01',creditLimit:money(300000,'SGD'),statementDay:20});
    F.usd=A.create({name:'USD wallet',type:'wallet',currency:'USD',openingBalance:money(30000,'USD'),openedOn:'2026-07-01'});
    fx.setUserRate('USD','SGD','1.35');
    for(const month of ['07','08','09']){
      if(F.marketing)window.captureDate=`2026-${month}-${month==='09'?'30':'31'}T12:00:00Z`;
      save('income',F.bank,500000,`2026-${month}-01`,'Salary',null,'Salary');
      save('expense',F.bank,180000,`2026-${month}-02`,'Housing','Rent');
      save('expense',F.bank,32000,`2026-${month}-12`,'Bills & utilities','Utilities');
      save('expense',F.bank,22000,`2026-${month}-08`,'Food','Market');
      save('expense',F.card,1500,`2026-${month}-20`,'Entertainment','SoundBox');
      if(F.marketing)NW.takeSnapshot('monthly');
    }
    window.captureDate='2026-10-16T12:00:00Z';
    fx.setUserRateOn('USD','SGD','2026-10-10','1.35');
    save('income',F.bank,500000,'2026-10-01','Salary',null,'Salary');
    save('expense',F.bank,180000,'2026-10-02','Housing','Rent');
    save('expense',F.bank,32000,'2026-10-12','Bills & utilities','Utilities');
    save('expense',F.bank,15000,'2026-10-08','Food','Market');
    save('expense',F.bank,9550,'2026-10-14','Food','Lunches');
    save('expense',F.cash,7000,'2026-10-11','Transport','Transit');
    save('expense',F.bank,3000,'2026-10-09','Shopping','Bookshop');
    F.foreign=save('expense',F.usd,2000,'2026-10-10','Travel','Museum tickets');
    F.coffee=save('expense',F.bank,4500,'2026-10-16','Food','Corner Coffee','Coffee entered by Alex');
  };
  F.plan=()=>{
    const rule=(name,kind,amount,category,merchant,start,anchor)=>T.createRule({name,template:{kind,account_id:F.bank.id,money:money(amount,'SGD'),category_id:cat(category).id,merchant},schedule:{freq:'monthly',interval:1,start,anchor}});
    rule('Salary','income',500000,'Salary',null,'2026-11-01',1);
    // Active salary rule also covers this budget month, without duplicating its existing ledger row.
    const salary=T.rules().find(r=>r.name==='Salary'); T.updateRule(salary.id,{schedule:{...salary.schedule,start:'2026-10-01'},last_posted_on:'2026-10-01'});
    rule('Phone bill','expense',5000,'Bills & utilities','Phone service','2026-10-21',21);
    rule('Rent','expense',180000,'Housing','Rent','2026-11-02',2);
    F.goal=G.create({name:'Holiday',target:money(240000,'SGD'),targetDate:'2027-04-16'});
    if(F.marketing)for(const [date,amount] of [['2026-08-16',10000],['2026-09-16',15000],['2026-10-16',15000]])G.contribute(F.goal.id,money(amount,'SGD'),date);
    else G.contribute(F.goal.id,money(40000,'SGD'),'2026-10-16');
    B.set('savings',{target:{amount:money(40000,'SGD')}});
    for(const [name,amount] of [['Bills & utilities',40000],['Food',40000],['Transport',20000],['Shopping',25000],['Entertainment',10000],['Housing',180000]])B.set('category',{categoryId:cat(name).id,limit:money(amount,'SGD')});
    F.loan=DB.create({name:'Education loan',type:'other',lender:'Study lender',currency:'SGD',balance:money(480000,'SGD'),original_balance:money(600000,'SGD'),rate_apr:'0',rate_type:'fixed',payment:money(20000,'SGD'),payment_day:5,pay_from_account_id:F.bank.id,category_id:cat('Education').id,started_on:'2026-04-05',maturity_date:null,lock_in_until:null,linked_account_id:null});
    DB.logExtraPayment(F.loan.id,money(20000,'SGD'),'2026-10-15',F.bank.id);
    I.create({type:'health',insurer:'Example Mutual',policy_number:'ALEX-HEALTH',insured:'self',premium:money(8000,'SGD'),frequency:'monthly',cover:money(20000000,'SGD'),start_date:'2025-11-05',renewal_date:'2026-11-05',end_date:null,notes:null,account_id:F.bank.id},false);
    F.holding=H.create({name:'Global balanced fund',type:'fund',currency:'SGD',mode:'value',accountLabel:'Investment account'});
    H.cashFlow(F.holding.id,'deposit','2026-08-16',money(200000,'SGD'));H.value(F.holding.id,'2026-08-16',money(200000,'SGD'));H.value(F.holding.id,'2026-09-16',money(210000,'SGD'));H.value(F.holding.id,'2026-10-16',money(220000,'SGD'));
    NW.createExtra('Laptop','other_asset',money(65000,'SGD'),'2026-10-16');NW.takeSnapshot('monthly');
    T.checkRecurring(); B.checkThresholds(); I.checkRenewals();
  };
  F.facts=()=>({bills:B.status().find(row=>row.name==='Bills & utilities'),expected:B.expectedIncome(),coffee:T.get(F.coffee.id),recurring:T.detectRecurring(),goal:G.status(F.goal),networth:NW.now(),allocation:B.allocation()});
  F.prepareMatch=async()=>{
    F.show(R.statementPage(F.bank.id),'reconcile');
    const text='Date,Description,Amount\n2026-10-14,Lunches,-95.50\n2026-10-15,Study lender,-200.00\n2026-10-16,Corner Coffee,-4.50';
    const file=new File([text],'Alex-current-month-example.csv',{type:'text/csv'}),transfer=new DataTransfer(); transfer.items.add(file);
    const form=document.querySelector('[data-form=statement]');form.elements.file.files=transfer.files;form.elements.closing.value=String(A.balance(F.bank.id).amount/100);
    // No AI output: the native manual mapper is deliberately used for this authored CSV view.
    P.profile().consent.ai_provider=false;
    form.requestSubmit();
    for(let i=0;i<30&&!document.querySelector('[data-modal-form]');i++)await new Promise(done=>setTimeout(done,20));
    const mapper=document.querySelector('[data-modal-form]');if(!mapper)throw new Error('Native column mapper did not open');
    mapper.elements.date_col.value='Date';mapper.elements.amount_col.value='Amount';mapper.elements.description_col.value='Description';mapper.requestSubmit();
    P.profile().consent.ai_provider=true;
  };
}

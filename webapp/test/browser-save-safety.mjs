// Review regressions in real Chrome and IndexedDB, on an isolated server with fake records only.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";

const server = await startServer({ AUTH: "off" });
let browser;
try {
  browser = await startChrome({ width: 360, height: 900 });
  const { cmd, js, waitFor } = browser;
  await cmd("Page.navigate", { url: server.url + "?demo=1#/home" });
  await waitFor(`!!document.querySelector('.home-panel') && !!localStorage.getItem('pfa.demo')`);
  await js(`(async () => {
    const {store} = await import('./js/lib/store.js'), vault = await import('./js/lib/vault.js'), {session} = await import('./js/lib/session.js'), ai = await import('./js/lib/ai.js');
    const originalFetch = window.fetch.bind(window);
    window.aiTest = {holdClassify:false,aborted:false};
    window.fetch = async (resource, options) => {
      const url = String(resource);
      if (url.includes('/api/ai/status')) return new Response(JSON.stringify({configured:true,sign_in_required:false}),{status:200,headers:{'Content-Type':'application/json'}});
      if (url.includes('/api/ai')) {
        if (window.aiTest.holdClassify && JSON.parse(options.body).task==='assistant_plan') return new Promise((resolve,reject)=>{
          window.aiTest.signal=options.signal;
          options.signal.addEventListener('abort',()=>{window.aiTest.aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
        });
        return new Response(JSON.stringify({code:'AI_FAILED',message:'Simulated provider unavailable',retryable:false}),{status:503,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(resource, options);
    };
    await ai.refreshStatus();
    const sample = store.snapshot();
    sample.tables.profile[0].consent = { ...sample.tables.profile[0].consent, ai_provider: true };
    await session.endDemo();
    const setup = await vault.create({passkey:{secret:crypto.getRandomValues(new Uint8Array(32)),credId:crypto.getRandomValues(new Uint8Array(16)),prfSalt:crypto.getRandomValues(new Uint8Array(32))}});
    await vault.confirmRecovery();
    window.safety = {store,vault,session,words:setup.words,aiTest:window.aiTest,fail:false,hold:false,writes:0,downloads:0,decrypts:0};
    safety.adapter = async (snapshot,meta) => {
      safety.writes++;
      if (safety.hold) await new Promise(resolve => {safety.release = resolve;});
      if (safety.fail) throw new Error('Simulated device storage failure');
      return vault.persist(snapshot,meta);
    };
    store.open(null,safety.adapter,vault.ownerId());
    await store.commit(store.captureAction('fixture',()=>store.importJson(sample)));
    session.mode='open'; location.hash='#/settings'; session.render();
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() { if(this.download?.startsWith('finance-backup-')) {safety.downloads++;return;} return click.call(this); };
    const decrypt = SubtleCrypto.prototype.decrypt;
    SubtleCrypto.prototype.decrypt = function(...args) {safety.decrypts++;return decrypt.apply(this,args);};
  })()`);
  await waitFor(`!!document.querySelector('[data-action=export]')`);

  // A selected Restore file may finish reading after navigation, but must not open a stale dialog.
  await js(`(()=>{window.__realFileReader=FileReader;window.__backupReadAborted=false;window.FileReader=class{readAsText(){window.__heldBackupReader=this}abort(){window.__backupReadAborted=true;this.onabort?.()}};const input=document.querySelector('[data-action=import]'),data=new DataTransfer();data.items.add(new File(['fake'],'held.json',{type:'application/json'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`!!window.__heldBackupReader`);
  assert.equal(await js(`document.querySelector('[data-operation-status]')?.textContent`), 'Reading backup file…', 'Restore exposes local file-reading status');
  await js(`location.hash='#/home'`); await waitFor(`!!document.querySelector('.home-panel') && window.__backupReadAborted`);
  await js(`window.FileReader=window.__realFileReader`);
  assert.equal(await js(`!!document.querySelector('[role=dialog]')`), false, 'Restore read cannot open a late confirmation after departure');
  console.log('PASS Restore reports file reading and suppresses a late confirmation after departure');
  await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-action=export]')`);

  // A non-dialog Settings save remains the same action through a failed write and route departure.
  const originalName = await js(`safety.store.one('profile').name`);
  await js(`(() => { safety.hold=true;safety.fail=false;const f=document.querySelector('[data-form=profile]');f.name.value='Durable save test';f.requestSubmit(); })()`);
  await waitFor(`!!safety.release && safety.store.one('profile').name==='Durable save test'`);
  await js(`location.hash='#/home'`);
  await waitFor(`!!document.querySelector('.home-panel')`);
  await js(`safety.fail=true;safety.hold=false;safety.release()`);
  await waitFor(`!!safety.store.persistenceState().error && !document.querySelector('#storage-warning').hidden`);
  const failedNameUpdatedAt = await js(`safety.store.one('profile').updated_at`);
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'departed Settings save is not reported as success');
  await js(`safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().dirty && document.querySelector('#storage-warning').hidden`);
  assert.equal(await js(`safety.store.one('profile').name`), 'Durable save test');
  assert.equal(await js(`safety.store.one('profile').updated_at`), failedNameUpdatedAt, 'Retry persists the same captured profile update without mutating again');
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'Retry after departure produces no stale success message');
  await js(`location.hash='#/settings'`);
  await waitFor(`!!document.querySelector('[data-action=export]')`);
  assert.ok(originalName);
  console.log('PASS direct Settings write waits for durability and global Retry reuses it without late UI');

  // U4: financial submission pauses while saving/failing, but the same-action global Retry remains usable.
  await js(`(()=>{safety.hold=true;safety.fail=false;const f=document.querySelector('[data-form=profile]');f.elements.name.value='U4 Settings retry';f.requestSubmit();})()`);
  await waitFor(`!!safety.release && document.querySelector('[data-form=profile]')?.getAttribute('aria-busy')==='true'`);
  assert.equal(await js(`document.querySelector('[data-form=profile] button').disabled`), true, 'Settings Save is disabled during Saving');
  assert.equal(await js(`document.querySelector('[data-form=profile] [data-form-status]').textContent`), 'Saving…', 'Settings shows visible Saving beside the action');
  const heldSettingsWrites = await js(`safety.writes`);
  await js(`document.querySelector('[data-form=profile]').requestSubmit()`);
  assert.equal(await js(`safety.writes`), heldSettingsWrites, 'busy Settings cannot start another save');
  await js(`safety.fail=true;safety.hold=false;safety.release()`);
  await waitFor(`!!safety.store.persistenceState().error && document.querySelector('[data-form=profile] button')?.disabled`);
  assert.equal(await js(`document.querySelector('[data-form=budget-settings] button').disabled && document.querySelector('[data-form=timing] button').disabled`), true, 'unresolved storage failure disables other financial Settings saves');
  const failedSettingsSnapshot = await js(`JSON.stringify(safety.store.snapshot())`);
  await js(`(()=>{const f=document.querySelector('[data-form=budget-settings]');f.elements.start_day.value='2';f.requestSubmit();})()`);
  assert.equal(await js(`JSON.stringify(safety.store.snapshot())`), failedSettingsSnapshot, 'programmatic submission cannot bypass the unresolved-write pause');
  await js(`safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().error && !document.querySelector('[data-form=profile] button')?.disabled && !document.querySelector('[data-form=budget-settings] button')?.disabled`);
  assert.equal(await js(`JSON.stringify(safety.store.snapshot())`), failedSettingsSnapshot, 'successful Retry persists the same Settings action without another mutation');
  console.log('PASS Settings Saving, failure pause and same-action Retry preserve inputs/identity and re-enable financial actions');

  // Assistant keeps the composed text until its original user-message receipt becomes durable.
  await js(`location.hash='#/chat'`);
  await waitFor(`!!document.querySelector('[data-chat-form]')`);
  const chatDraft = 'retry this exact chat message';
  await js(`(() => {safety.hold=true;safety.fail=false;const f=document.querySelector('[data-chat-form]');f.elements.text.value=${JSON.stringify(chatDraft)};f.requestSubmit();})()`);
  await waitFor(`!!safety.release && document.querySelector('[data-chat-form] textarea[name=text]').value===${JSON.stringify(chatDraft)}`);
  await js(`safety.fail=true;safety.hold=false;safety.release()`);
  await waitFor(`!!safety.store.persistenceState().error && document.querySelector('[data-chat-form] textarea[name=text]').value===${JSON.stringify(chatDraft)} && !!document.querySelector('[data-retry]')`);
  await js(`safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().dirty && safety.store.one('conversations')?.messages?.filter(m=>m.role==='user'&&m.text===${JSON.stringify(chatDraft)}).length===1`);
  // Persist-only Retry does not silently call the provider. Resume the failed phase explicitly.
  await js(`document.querySelector('[data-retry]').click()`);
  await waitFor(`document.querySelector('[data-chat-form] textarea[name=text]').value==='' && !document.querySelector('[data-chat-form] textarea').disabled`);
  assert.equal(await js(`safety.store.one('conversations').messages.filter(m=>m.role==='user'&&m.text===${JSON.stringify(chatDraft)}).length`), 1, 'retry resumes the same captured user-message write, not a duplicate');
  console.log('PASS Assistant preserves input through failed save and resumes its captured message after global Retry');

  // Leaving while the provider is working aborts the request and prevents late transcript/UI changes.
  const departureQuestion = 'leave while the answer is being prepared';
  await js(`(() => {safety.aiTest.holdClassify=true;safety.aiTest.aborted=false;safety.aiTest.signal=null;const f=document.querySelector('[data-chat-form]');f.elements.text.value=${JSON.stringify(departureQuestion)};f.requestSubmit();})()`);
  await waitFor(`!!safety.aiTest.signal && safety.store.one('conversations').messages.some(m=>m.role==='user'&&m.text===${JSON.stringify(departureQuestion)})`);
  const messageCountAtDeparture = await js(`safety.store.one('conversations').messages.length`);
  await js(`location.hash='#/home'`);
  await waitFor(`!!document.querySelector('.home-panel') && safety.aiTest.aborted`);
  assert.equal(await js(`safety.store.one('conversations').messages.length`), messageCountAtDeparture, 'cancelled classifier cannot append a late reply');
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'departed chat operation has no stale toast');
  console.log('PASS Assistant aborts unfinished classifier work on departure without late transcript changes');
  await js(`location.hash='#/settings'`);
  await waitFor(`!!document.querySelector('[data-action=export]')`);

  // The export is downloaded only once; bookkeeping retry must not ask for cleared words again.
  await js(`safety.fail=true;document.querySelector('[data-action=export]').click()`);
  await waitFor(`!!document.querySelector('[name=bwords]')`);
  await js(`(() => {const f=document.querySelector('[name=bwords]').form;f.elements.bwords.value=safety.words;f.requestSubmit();})()`);
  await waitFor(`document.querySelector('[data-modal-error]')?.textContent==='Simulated device storage failure'`);
  assert.equal(await js(`safety.downloads`), 1);
  assert.equal(await js(`document.querySelector('[name=bwords]').value`), "", "recovery words are cleared once encryption finishes");
  await js(`(async()=>{safety.fail=false;await safety.store.retryPending();})()`);
  await js(`document.querySelector('[name=bwords]').form.requestSubmit()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  assert.equal(await js(`safety.downloads`), 1, "a global successful retry is recognized without another download");
  assert.equal(await js(`!!safety.store.one('backup_state')?.last_backup_at`), true);
  console.log("PASS export failure/global retry closes correctly with one download and no second recovery request");

  // Export remains available when an unrelated write already failed. Retrying after the
  // download must retain that result, not request cleared words or create a second file.
  await js(`(async()=>{safety.fail=true;try{await safety.store.commit(safety.store.captureAction('pre-export-failure',()=>safety.store.upsertOne('home_layout',{panel_key:'budget'})));}catch{}document.querySelector('[data-action=export]').click();})()`);
  await waitFor(`!!document.querySelector('[name=bwords]')`);
  await js(`(()=>{const f=document.querySelector('[name=bwords]').form;f.elements.bwords.value=safety.words;f.requestSubmit();})()`);
  await waitFor(`!!document.querySelector('[data-modal-error]')?.textContent`);
  assert.equal(await js(`safety.downloads`), 2, "export can download while another write is blocked");
  assert.equal(await js(`document.querySelector('[data-modal-error]').textContent`), "Simulated device storage failure", "the retained export can retry storage, not replay its download");
  await js(`(async()=>{safety.fail=false;await safety.store.retryPending();})()`);
  await js(`document.querySelector('[name=bwords]').form.requestSubmit()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  assert.equal(await js(`safety.downloads`), 2, "finishing export bookkeeping never repeats its completed download");
  console.log("PASS export remains usable during an existing storage failure and retains its downloaded result across retry");

  // Restore the sealed fixture through the actual file input, then fail/retry its device save.
  await js(`(async()=>{
    const restored=safety.store.snapshot();restored.tables.profile[0].name='Restored test profile';
    const sealed=await safety.vault.sealBackup(restored,{words:safety.words});
    const files=new DataTransfer();files.items.add(new File([JSON.stringify(sealed)],'fake-backup.json',{type:'application/json'}));
    const input=document.querySelector('[data-action=import]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(`!!document.querySelector('[name=rwords]')`);
  const decryptsBefore = await js(`safety.decrypts`);
  await js(`(() => {safety.fail=true;const f=document.querySelector('[name=rwords]').form;f.elements.rwords.value=safety.words;f.requestSubmit();})()`);
  await waitFor(`document.querySelector('[data-modal-error]')?.textContent==='Simulated device storage failure'`);
  assert.equal(await js(`safety.decrypts`), decryptsBefore + 1);
  await js(`(async()=>{safety.fail=false;await safety.store.retryPending();})()`);
  await js(`document.querySelector('[name=rwords]').form.requestSubmit()`);
  await waitFor(`!document.querySelector('[role=dialog]') && location.hash==='#/home'`);
  assert.equal(await js(`safety.decrypts`), decryptsBefore + 1, "restore persistence retry does not decrypt the backup again");
  assert.equal(await js(`safety.store.one('profile').name`), "Restored test profile");
  console.log("PASS restore failure/global retry keeps its captured result and does not decrypt or replace twice");

  // Paused Briefing retains its original and unread marker, including during storage failure.
  await js(`(async()=>{
    const receipt=safety.store.captureAction('unread-fixture',()=>safety.store.insert('briefings',{period:{start:'2026-09-01',end:'2026-09-30'},summary:'Readable saved briefing',stats:{incomplete_reasons:[]},options:[],read_at:null}));
    await safety.store.commit(receipt);safety.briefingId=receipt.value.id;
    safety.fail=true;
    try {await safety.store.commit(safety.store.captureAction('blocked-fixture',()=>safety.store.upsertOne('home_layout',{panel_key:'budget'})));}catch{}
    safety.writesBeforeRead=safety.writes;location.hash='#/briefing/'+safety.briefingId;
  })()`);
  await waitFor(`!!document.querySelector('[data-feature-paused=briefings]')`);
  assert.equal(await js(`document.querySelector('#app').textContent.includes('Readable saved briefing')`), false);
  assert.equal(await js(`document.querySelector('#app').textContent.includes('Something broke')`), false);
  assert.equal(await js(`safety.store.get('briefings',safety.briefingId).read_at`), null);
  assert.equal(await js(`safety.writes`), await js(`safety.writesBeforeRead`), "viewing during a failure does not attempt another write");
  await js(`safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().dirty`);
  const marker = await js(`safety.store.get('briefings',safety.briefingId).read_at`);
  await js(`safety.session.render()`);
  assert.equal(marker, null, "retry does not mark a paused briefing as read");
  assert.equal(await js(`safety.store.get('briefings',safety.briefingId).read_at`), marker);
  assert.equal(await js(`safety.store.get('briefings',safety.briefingId).summary`), 'Readable saved briefing');
  console.log("PASS paused briefing retains original and unread marker through storage failure/retry");

  // Navigation is independent of an already-confirmed device write. The departed
  // transaction must finish without a late toast or disturbing a newer dialog.
  await js(`location.hash='#/add'`);
  await waitFor(`!!document.querySelector('[data-door=expense]')`);
  const beforeDeparture = await js(`safety.store.all('transactions').length`);
  await js(`document.querySelector('[data-door=expense]').click()`);
  await waitFor(`!!document.querySelector('[name=amount]')`);
  await js(`(() => {safety.release=null;safety.hold=true;document.querySelector('#toast-root').replaceChildren();const f=document.querySelector('[name=amount]').form;f.elements.amount.value='81.23';f.requestSubmit();})()`);
  await waitFor(`!!safety.release && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
  await js(`location.hash='#/settings';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(await js(`location.hash==='#/settings' && !!document.querySelector('[data-form=profile]')`), true, "navigation must not wait for device storage");
  assert.equal(await js(`!document.querySelector('[role=dialog]') && !document.querySelector('#app').inert`), true, "departure disposes the saving dialog and unblocks browsing");
  await js(`(async()=>{const {modal}=await import('./js/lib/ui.js');modal({title:'New view dialog',body:'<p>Must survive the old save.</p>'});safety.hold=false;safety.release();})()`);
  await waitFor(`!safety.store.persistenceState().dirty`);
  assert.equal(await js(`safety.store.all('transactions').length`), beforeDeparture + 1);
  assert.equal(await js(`document.querySelector('[role=dialog] h2')?.textContent`), "New view dialog", "old save cannot close a newer dialog");
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), "", "a departed save cannot announce success in the new view");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  console.log("PASS navigation does not wait for a confirmed save; the write completes once without late UI effects");

  // A rejected departed write keeps the global warning/financial block, not stale UI.
  await js(`location.hash='#/add'`);
  await waitFor(`!!document.querySelector('[data-door=expense]')`);
  const beforeRejectedDeparture = await js(`safety.store.all('transactions').length`);
  await js(`document.querySelector('[data-door=expense]').click()`);
  await js(`(()=>{safety.release=null;safety.hold=true;const f=document.querySelector('[name=amount]').form;f.elements.amount.value='82.34';f.requestSubmit();})()`);
  await waitFor(`!!safety.release && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
  await js(`history.back()`);
  await waitFor(`location.hash==='#/settings' && !!document.querySelector('[data-form=profile]')`);
  await js(`(async()=>{const {modal}=await import('./js/lib/ui.js');modal({title:'New view after Back',body:'<p>No old errors here.</p>'});safety.hold=false;safety.fail=true;safety.release();})()`);
  await waitFor(`!!safety.store.persistenceState().error && !document.querySelector('#storage-warning').hidden`);
  assert.equal(await js(`document.querySelector('[role=dialog] h2')?.textContent`), 'New view after Back');
  assert.equal(await js(`document.querySelector('[data-modal-error]').textContent`), '', 'old failure cannot write into the new dialog');
  assert.equal(await js(`(()=>{try{safety.store.insert('transactions',{});return false;}catch{return true;}})()`), true, 'departed failure still blocks financial changes');
  await js(`document.querySelector('[data-action=modal-cancel]').click();safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().dirty && document.querySelector('#storage-warning').hidden`);
  assert.equal(await js(`safety.store.all('transactions').length`), beforeRejectedDeparture + 1, 'retry persists the confirmed row, never inserts it again');
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '');
  console.log('PASS Back works during Saving; a departed failure stays globally visible and retries once without stale UI');

  // Queued success text belongs to its own dialog, not a shared in-flight buffer.
  await js(`(async()=>{const {modal,toast}=await import('./js/lib/ui.js');document.querySelector('#toast-root').replaceChildren();safety.hold=true;safety.release=null;modal({title:'Old queued save',body:'',onSubmit:()=>{safety.store.upsertOne('home_layout',{panel_key:'budget'});toast('Old success');}});document.querySelector('[data-modal-form]').requestSubmit();})()`);
  await waitFor(`!!safety.release`);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  await js(`(async()=>{const {modal,toast}=await import('./js/lib/ui.js');modal({title:'Current queued save',body:'',onSubmit:()=>{safety.store.upsertOne('home_layout',{panel_key:'wealth'});toast('Current success');}});document.querySelector('[data-modal-form]').requestSubmit();safety.hold=false;safety.release();})()`);
  await waitFor(`!safety.store.persistenceState().dirty && !document.querySelector('[role=dialog]')`);
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), 'Current success', 'old completion cannot consume or display a newer action’s queued success');
  console.log('PASS overlapping cancelled/current dialog saves keep their own success message');

  // Each automatic redirect waits for its own durable receipt, not a global route lock.
  const redirectCases = [
    { table: 'transactions', action: 'delete', target: '#/transactions' },
    { table: 'accounts', action: 'archive', target: '#/accounts' },
    { table: 'debts', action: 'archive', target: '#/debts' },
    { table: 'holdings', route: 'investments', action: 'close', target: '#/investments' },
  ];
  for (const item of redirectCases) {
    const id = await js(`safety.store.all(${JSON.stringify(item.table)}).find(row=>!row.archived_at && row.status!=='archived' && row.status!=='closed').id`);
    const detail = `#/${item.route || item.table}/${id}`;
    await js(`location.hash=${JSON.stringify(detail)}`);
    await waitFor(`!!document.querySelector('[data-action=${item.action}]')`);
    if (item.table === 'debts') {
      // Rendering-only what-if checks: same code results/wording, no stored changes.
      for (const rate of [6, null, 120]) {
        await js(`(async()=>{await safety.store.commit(safety.store.captureAction('what-if-fixture',()=>safety.store.update('debts',${JSON.stringify(id)},{rate_apr:${rate},rate_type:'fixed',linked_account_id:null,balance:{amount:1200000,currency:'SGD'},payment:{amount:50000,currency:'SGD'}})));})()`);
        const unchanged = await js(`JSON.stringify(safety.store.snapshot())`);
        await js(`(()=>{const f=document.querySelector('[data-form=whatif]');f.elements.extra.value='100';f.requestSubmit();})()`);
        const expected = await js(`(async()=>{const {whatIf}=await import('./js/features/debts.js'),{fmt,money}=await import('./js/lib/money.js'),D=await import('./js/lib/dates.js');const w=whatIf(safety.store.get('debts',${JSON.stringify(id)}),{extraMonthly:10000,lumpSum:0}),pr=w.with;return 'With '+fmt(money(10000,'SGD'))+' extra/month:'+(pr.reason?'— '+pr.reason:pr.neverClears?'Never clears at this payment. Monthly interest '+fmt(pr.monthlyInterest)+' exceeds the payment by '+fmt(pr.shortfall)+'.':'Estimated '+pr.monthsToClear+' months to clear · total interest '+fmt(pr.totalInterest))+(w.monthsSaved!=null?'Saves '+w.monthsSaved+' months and '+fmt(w.interestSaved)+' in interest, compared with the current plan.':'');})()`);
        assert.equal(await js(`document.querySelector('[data-whatif]').textContent`), expected);
        assert.equal(await js(`JSON.stringify(safety.store.snapshot())`), unchanged, 'what-if remains a pure calculation, not a write');
      }
    }
    await js(`safety.release=null;safety.hold=true;document.querySelector('[data-action=${item.action}]').click()`);
    await waitFor(`!!document.querySelector('[data-modal-form]')`);
    await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
    await waitFor(`!!safety.release && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
    assert.equal(await js(`location.hash`), detail, `${item.table}: automatic redirect must wait for this save`);
    assert.equal(await js(`!document.querySelector('[data-action=modal-cancel]').disabled`), true);
    if (item.table === 'transactions') {
      const appliedRow = await js(`JSON.stringify(safety.store.all('transactions',{includeDeleted:true}).find(row=>row.id===${JSON.stringify(id)}))`);
      await js(`safety.fail=true;safety.hold=false;safety.release()`);
      await waitFor(`document.querySelector('[data-modal-error]')?.textContent==='Simulated device storage failure'`);
      assert.equal(await js(`location.hash`), detail, 'failed delete cannot run its automatic redirect');
      await js(`safety.fail=false;document.querySelector('[data-modal-form]').requestSubmit()`);
      await waitFor(`location.hash===${JSON.stringify(item.target)} && !document.querySelector('[role=dialog]') && !safety.store.persistenceState().dirty`);
      assert.equal(await js(`JSON.stringify(safety.store.all('transactions',{includeDeleted:true}).find(row=>row.id===${JSON.stringify(id)}))`), appliedRow, 'same-action retry never reapplies deletion or changes its timestamp');
    } else {
      await js(`safety.hold=false;safety.release()`);
      await waitFor(`location.hash===${JSON.stringify(item.target)} && !document.querySelector('[role=dialog]') && !safety.store.persistenceState().dirty`);
    }
    console.log(`PASS ${item.table} confirmed ${item.action} redirects only after durable success`);
  }

  // Non-dialog Restore is also a confirmed action: hold, leave, reject and globally
  // retry its captured update without replaying it or announcing a late success.
  const restoreId = await js(`safety.store.all('transactions')[0]?.id`);
  assert.ok(restoreId, "fixture contains a transaction to restore");
  await js(`(async()=>{const {commitAction}=await import('./js/lib/ui.js');await commitAction(()=>safety.store.update('transactions',${JSON.stringify(restoreId)},{voided_at:new Date().toISOString(),void_reason:'fixture'}));location.hash=${JSON.stringify('#/transactions/'+restoreId)};})()`);
  await waitFor(`!!document.querySelector('[data-action=restore]')`);
  await js(`document.querySelector('#toast-root').replaceChildren();safety.release=null;safety.hold=true;document.querySelector('[data-action=restore]').click()`);
  await waitFor(`!!safety.release && safety.store.get('transactions',${JSON.stringify(restoreId)}).voided_at===null`);
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'Restore is not announced before device acknowledgement');
  await js(`location.hash='#/settings';safety.fail=true;safety.hold=false;safety.release()`);
  await waitFor(`!!safety.store.persistenceState().error && !document.querySelector('#storage-warning').hidden`);
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'departed failed Restore has no success toast');
  await js(`safety.fail=false;document.querySelector('#storage-warning button').click()`);
  await waitFor(`!safety.store.persistenceState().dirty && document.querySelector('#storage-warning').hidden`);
  assert.equal(await js(`safety.store.get('transactions',${JSON.stringify(restoreId)}).voided_at`), null);
  assert.equal(await js(`document.querySelector('#toast-root').textContent`), '', 'global Retry saves the captured restore without late UI');
  console.log('PASS direct Restore waits for durability; departed failure retries the same action without a duplicate or stale toast');

  // A modal keeps the background inert, but an in-dialog Lock is usable during a slow save.
  await js(`location.hash='#/add'`);
  await waitFor(`!!document.querySelector('[data-door=expense]')`);
  await js(`document.querySelector('[data-door=expense]').click()`);
  await waitFor(`!!document.querySelector('[name=amount]')`);
  await js(`(() => {safety.hold=true;const f=document.querySelector('[name=amount]').form;f.elements.amount.value='91.23';f.requestSubmit();})()`);
  await waitFor(`!!safety.release && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
  assert.equal(await js(`document.querySelector('#app').inert && document.querySelector('.topbar').inert`), true);
  assert.equal(await js(`!document.querySelector('[data-modal-lock]').disabled && !document.querySelector('[data-modal-lock]').closest('[inert]')`), true);
  await js(`document.querySelector('[data-modal-lock]').focus()`);
  assert.equal(await js(`document.activeElement.hasAttribute('data-modal-lock')`), true, "Lock is keyboard-accessible in the dialog");
  await js(`document.querySelector('[data-modal-lock]').click()`);
  await waitFor(`!document.querySelector('[role=dialog]')`);
  await js(`safety.hold=false;safety.release()`);
  await waitFor(`safety.session.mode==='locked' && !safety.vault.isUnlocked() && safety.store.isEmpty()`);
  assert.equal(await js(`document.body.textContent.includes('91.23')`), false);
  console.log("PASS Lock remains accessible during Saving, clears the dialog and readable memory, and allows the captured write to settle");

  // Repeat with a failed write: locking must still work and leave only a content-free warning.
  await js(`(async()=>{const data=await safety.vault.unlock({words:safety.words});safety.store.open(data,safety.adapter,safety.vault.ownerId());safety.session.mode='open';location.hash='#/add';safety.session.render();})()`);
  await waitFor(`!!document.querySelector('[data-door=expense]')`);
  await js(`document.querySelector('[data-door=expense]').click()`);
  await waitFor(`!!document.querySelector('[name=amount]')`);
  await js(`(() => {safety.fail=true;const f=document.querySelector('[name=amount]').form;f.elements.amount.value='93.21';f.requestSubmit();})()`);
  await waitFor(`document.querySelector('[data-modal-error]')?.textContent==='Simulated device storage failure'`);
  await js(`document.querySelector('[data-modal-lock]').click()`);
  await waitFor(`safety.session.mode==='locked' && safety.store.isEmpty()`);
  assert.equal(await js(`document.querySelector('#storage-warning').hidden`), false);
  assert.equal(await js(`document.body.textContent.includes('93.21') || document.body.textContent.includes('Restored test profile')`), false);
  console.log("PASS failed-save Lock clears private state and leaves a content-free unsaved warning without a stale retry");

  // Wipe goes through its actual Settings callback and reload, not a mocked promise wrapper.
  await js(`(async()=>{safety.fail=false;const data=await safety.vault.unlock({words:safety.words});safety.store.open(data,safety.adapter,safety.vault.ownerId());safety.session.mode='open';location.hash='#/settings';safety.session.render();})()`);
  await waitFor(`!!document.querySelector('[data-action=wipe]')`);
  await js(`document.querySelector('[data-action=wipe]').click()`);
  await waitFor(`document.querySelector('[role=dialog]')?.textContent.includes('Wipe local records')`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`!window.safety && !document.querySelector('[role=dialog]')`, 15000);
  assert.equal(await js(`(async()=>!(await (await import('./js/lib/vault.js')).status()).exists)()`), true);
  assert.equal(await js(`document.body.textContent.includes('Action mutation must be synchronous')`), false);
  assert.deepEqual(browser.problems(), [], "no uncaught browser errors or policy violations");
  console.log("PASS actual Wipe completes once, removes the selected vault and reloads without a false save error");
} finally {
  browser?.close(); server.stop();
}

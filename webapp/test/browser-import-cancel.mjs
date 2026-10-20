// Real app, fake files/accounts and controllable AI; no real provider calls or money data.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";
const failures = [];
const check = (condition, message) => { console.log(`${condition ? "PASS" : "FAIL"} ${message}`); if (!condition) failures.push(message); };
const srv = await startServer({ AUTH: "off" });
let B;
try {
  B = await startChrome({ width: 360, height: 900 });
  const { cmd, js: evaluate, waitFor: waitForOriginal } = B;
  // Keep the existing cancellation cases, translating their old door notation to the shared picker.
  // Privacy approval here is a simulated user click, never financial confirmation.
  const migrate = source => source.replaceAll('form[data-door=csv]', 'form[data-door=upload]').replaceAll('form[data-door=photo]', 'form[data-door=upload]')
      .replaceAll('map_csv_columns', 'assistant_csv_map').replaceAll('.csv.files', '.elements.files.files').replaceAll('.image.files', '.elements.files.files')
      .replaceAll("['text','photo','csv']", "['text','upload']")
      .replaceAll("new File(['fake'],'fake.png',{type:'image/png'})", 'window.__uploadPng')
      .replaceAll('f.requestSubmit()', "f.elements.files?.files.length&&f.elements.files.dispatchEvent(new Event('change'));f.requestSubmit()");
  const waitFor = (source, ms) => waitForOriginal(migrate(source), ms);
  const js = async source => {
    const result = await evaluate(migrate(source));
    if (await evaluate("document.querySelector('[role=dialog] h2')?.textContent==='Send files to AI?'")) await evaluate("document.querySelector('[data-modal-form]').requestSubmit()");
    return result;
  };
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__pendingImports = [];
    window.__pageHideListeners = new Set();
    const originalAdd = window.addEventListener, originalRemove = window.removeEventListener;
    window.addEventListener = function(type, listener, ...options) {
      if (type === 'pagehide') window.__pageHideListeners.add(listener);
      return originalAdd.call(this, type, listener, ...options);
    };
    window.removeEventListener = function(type, listener, ...options) {
      if (type === 'pagehide') window.__pageHideListeners.delete(listener);
      return originalRemove.call(this, type, listener, ...options);
    };
    const originalFetch = window.fetch;
    window.fetch = (url, options = {}) => {
      const pathname = new URL(url, location.href).pathname;
      if (pathname === '/api/ai/status') return Promise.resolve(new Response(JSON.stringify({configured:true,sign_in_required:false}), {headers:{'Content-Type':'application/json'}}));
      // Intentionally ignore abort: late successes/failures must still be harmless.
      if (pathname === '/api/ai') return new Promise((resolve) => {
        const request = JSON.parse(options.body);
        window.__pendingImports.push({task:request.task, input:request.input, signal:options.signal,
          resolve:output => resolve(new Response(JSON.stringify({output}), {headers:{'Content-Type':'application/json'}})),
          fail:() => resolve(new Response(JSON.stringify({code:'AI_SCHEMA',message:'Fake rejected reply'}), {status:422,headers:{'Content-Type':'application/json'}}))});
      });
      return originalFetch(url, options);
    };
  ` });
  await cmd("Page.navigate", { url: `${srv.url}?demo=1#/add` });
  await waitFor(`!!document.querySelector('form[data-door=upload]')`);
  await js(`(async()=>{const c=document.createElement('canvas');c.width=c.height=2;const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));window.__uploadPng=new File([blob],'fake.png',{type:'image/png'});})()`);
  const settle = () => js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const goAdd = async () => {
    await js(`document.querySelector('[data-action=modal-cancel]')?.click(); location.hash = '#/settings'`);
    await waitFor(`!!document.querySelector('[data-form=profile]')`);
    await js(`location.hash = '#/add'`); await waitFor(`!!document.querySelector('form[data-door=csv]')`);
  };
  const count = task => js(`window.__pendingImports.filter(r => r.task === ${JSON.stringify(task)}).length`);
  const totals = () => js(`import('./js/lib/store.js').then(({store})=>[store.all('transactions').length,store.all('import_batches').length,store.all('merchant_rules').length])`);
  const baseline = await totals();
  const pageHideListeners = await js(`window.__pageHideListeners.size`);
  const mapping = { date_col: "Date", amount_col: "Amount", debit_col: null, credit_col: null, description_col: "Description", currency_col: null, reference_col: null, date_format: "YYYY-MM-DD", negative_means: "expense" };
  const submitCsv = async (body = "Date,Amount,Description\n2026-10-01,-5.00,") => {
    const before = await count("map_csv_columns");
    await js(`(() => {const f=document.querySelector('form[data-door=csv]'), d=new DataTransfer();d.items.add(new File([${JSON.stringify(body)}],'cancel-probe.csv',{type:'text/csv'}));f.csv.files=d.files;f.requestSubmit();})()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='map_csv_columns').length === ${before + 1}`);
    return before;
  };
  const reply = (task, index, output = mapping) => js(`window.__pendingImports.filter(r=>r.task===${JSON.stringify(task)})[${index}].resolve(${JSON.stringify(output)})`);
  const abortCheck = (task, index, label) => js(`window.__pendingImports.filter(r=>r.task===${JSON.stringify(task)})[${index}].signal?.aborted === true`).then(ok=>check(ok,label));
  const noDialog = async label => { await settle(); check(await js(`!document.querySelector('[data-modal-form]')`), label); };

  // Original red regression, plus the next asynchronous boundary.
  let index = await submitCsv();
  check(await js(`document.querySelector('form[data-door=csv] [data-operation-status]')?.textContent.includes('Matching the column names')`), "CSV column matching exposes its live operation status");
  await js(`window.__leftAdd=document.querySelector('form[data-door=csv]');location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-form=profile]')`);
  await abortCheck("map_csv_columns", index, "navigation aborts the mapping request");
  await js(`(()=>{const d=new DataTransfer();d.items.add(new File(['Date,Amount,Description\\n2026-10-01,-5.00,'],'detached.csv'));window.__leftAdd.csv.files=d.files;window.__leftAdd.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
  await settle();
  check(await count("map_csv_columns") === index + 1, "detached Add preparation cannot launch another request");
  await reply("map_csv_columns", index);
  await noDialog("leaving Add prevents a late mapping review dialog");
  await goAdd();
  index = await submitCsv("Date,Amount,Description\n2026-10-01,-5.00,Unknown cancellation probe");
  const catIndex = await count("classify_category");
  await reply("map_csv_columns", index); await waitFor(`window.__pendingImports.filter(r=>r.task==='classify_category').length===${catIndex + 1}`);
  check(await js(`document.querySelector('form[data-door=csv] [data-operation-status]')?.textContent.includes('Checking category suggestions')`), "category preparation exposes its live operation status");
  await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-form=profile]')`);
  await abortCheck("classify_category", catIndex, "navigation aborts category preparation");
  await reply("classify_category", catIndex, {items:[{category_id:null,confidence:"low"}]});
  await noDialog("leaving during category preparation prevents a late review dialog");
  await goAdd();
  const hasCancel = await js(`['text','photo','csv'].every(door=>!!document.querySelector('form[data-door='+door+'] [data-import-cancel]'))`);
  check(hasCancel, "all three preparation doors have visible Cancel/reset controls");

  if (hasCancel) {
    // Old run cannot disturb an immediately retried run, even if its reply ignores abort.
    index = await submitCsv();
    await js(`document.querySelector('form[data-door=csv] [data-import-cancel]').click()`);
    await abortCheck("map_csv_columns", index, "visible Cancel aborts mapping");
    check(await js(`window.__pageHideListeners.size`) === pageHideListeners, "Cancel removes its browser departure handler");
    check(await js(`document.querySelector('form[data-door=csv]').csv.files.length===0 && !document.querySelector('form[data-door=csv] .primary').disabled`), "Cancel clears the file and restores Upload");
    const fresh = await submitCsv();
    check(await js(`window.__pageHideListeners.size`) === pageHideListeners + 1, "a retry owns exactly one browser departure handler");
    await reply("map_csv_columns", index, {}); await noDialog("cancelled malformed reply opens nothing and does not retry");
    check(await count("map_csv_columns") === fresh + 1, "no second request follows a cancelled invalid result");
    check(await js(`document.querySelector('form[data-door=csv] .primary').disabled`), "old completion does not reset a fresh run's busy state");
    await reply("map_csv_columns", fresh); await waitFor(`!!document.querySelector('[data-modal-form] [name=inc]')`);
    await js(`window.__discardedReview=document.querySelector('[data-modal-form]');document.querySelector('[data-action=modal-cancel]').click()`);
    check(await js(`document.querySelector('form[data-door=csv]').csv.files.length===0`), "review Cancel discards the file and unfinished rows");
    await js(`window.__discardedReview.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    check(JSON.stringify(await totals())===JSON.stringify(baseline), "a detached discarded review cannot save");

    // Cancel during category work suppresses both success and failure paths.
    index = await submitCsv("Date,Amount,Description\n2026-10-01,-5.00,Unknown category failure probe");
    const category = await count("classify_category"); await reply("map_csv_columns", index);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='classify_category').length===${category + 1}`);
    await js(`document.querySelector('form[data-door=csv] [data-import-cancel]').click(); document.getElementById('toast-root').replaceChildren()`);
    await js(`window.__pendingImports.filter(r=>r.task==='classify_category')[${category}].fail()`);
    await noDialog("cancelled category failure opens no fallback or review");
    check(await js(`!document.getElementById('toast-root').textContent`), "cancelled category failure has no stale error toast");
    check(await count("classify_category") === category + 1, "cancelled category failure makes no retry request");

    // Text: multi-draft cancellation, malformed reply and late failure.
    for (const failure of [false, true]) {
      const text = await count("extract_from_text");
      await js(`(()=>{const f=document.querySelector('form[data-door=text]');f.text.value='fake lunch 5';f.requestSubmit();f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
      await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_text').length===${text + 1}`);
      check(await count("extract_from_text") === text + 1, "duplicate preparation submit sends one text request");
      await js(`document.querySelector('form[data-door=text] [data-import-cancel]').click();document.getElementById('toast-root').replaceChildren()`);
      await abortCheck("extract_from_text", text, "text Cancel aborts request");
      if (failure) await js(`window.__pendingImports.filter(r=>r.task==='extract_from_text')[${text}].fail()`);
      else await reply("extract_from_text", text, {items:[{amount_text:"5.00",kind:"expense",merchant:null,date:"2026-10-01"}]});
      await noDialog(`cancelled text ${failure ? "failure" : "success"} opens no draft or fallback`);
      check(await js(`document.querySelector('form[data-door=text]').text.value==='' && !document.querySelector('form[data-door=text] .primary').disabled`), "text Cancel clears input and restores Read it");
      check(await count("extract_from_text") === text + 1, "cancelled text response makes no retry");
    }

    // A held local read may finish, but cannot launch any mapping request afterwards.
    const maps = await count("map_csv_columns");
    await js(`(()=>{window.__realText=File.prototype.text;File.prototype.text=function(){return new Promise(resolve=>window.__finishRead=()=>resolve('Date,Amount,Description\\n2026-10-01,-5.00,'));};const f=document.querySelector('form[data-door=csv]'),d=new DataTransfer();d.items.add(new File(['fake'],'held.csv'));f.csv.files=d.files;f.requestSubmit();})()`);
    await waitFor(`!!window.__finishRead`);
    await js(`document.querySelector('form[data-door=csv] [data-import-cancel]').click();window.__finishRead();File.prototype.text=window.__realText`);
    await noDialog("cancelled CSV local read opens nothing");
    check(await count("map_csv_columns") === maps, "cancelled local read never starts AI mapping");

    // Leaving the document (including a page placed in the back-forward cache).
    index = await submitCsv();
    await js(`window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))`);
    await abortCheck("map_csv_columns", index, "leaving the browser page aborts pending import");
    await reply("map_csv_columns", index); await noDialog("pagehide suppresses a late review dialog");
    check(await js(`document.querySelector('form[data-door=csv]').csv.files.length===0`), "pagehide clears unfinished input");
    check(await js(`window.__pageHideListeners.size`) === pageHideListeners, "back-forward cache departure removes the old import handler");

    // Manual mapping remains cancellable while it is applying category suggestions.
    const manualIndex = await submitCsv("BadDate,Date,Amount,Description\nnot-a-date,2026-10-01,-5.00,Unknown manual mapping probe");
    await reply("map_csv_columns", manualIndex, {...mapping,date_col:"BadDate"});
    await waitFor(`!!document.querySelector('[data-modal-form] [name=amount_col]')`);
    const manualCategory = await count("classify_category");
    await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.date_col.value='Date';f.amount_col.value='Amount';f.description_col.value='Description';f.requestSubmit();f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='classify_category').length===${manualCategory + 1}`);
    check(await count("classify_category")===manualCategory + 1, "double Apply sends one category request");
    await js(`document.querySelector('[data-modal-form]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await abortCheck("classify_category", manualCategory, "Escape cancels manual mapping category preparation");
    await reply("classify_category", manualCategory, {items:[{category_id:null,confidence:"low"}]});
    await noDialog("cancelled manual mapping cannot open a late review");

    // Active extraction errors still retry once and retain the manual fallback.
    const fallback = await count("extract_from_text");
    await js(`(()=>{const f=document.querySelector('form[data-door=text]');f.text.value='fake unreadable amount';f.requestSubmit();})()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_text').length===${fallback + 1}`);
    await js(`window.__pendingImports.filter(r=>r.task==='extract_from_text')[${fallback}].fail()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_text').length===${fallback + 2}`);
    await js(`window.__pendingImports.filter(r=>r.task==='extract_from_text')[${fallback + 1}].fail()`);
    await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('Manual (AI could not read this)')`);
    check(true, "active text errors preserve one retry and manual confirmation fallback");
    await js(`document.querySelector('[data-action=modal-cancel]').click()`);

    // Photo local-read and provider boundaries.
    const images = await count("extract_from_image");
    await js(`(()=>{window.__realReader=window.FileReader;window.FileReader=class {readAsDataURL(){window.__heldReader=this;} abort(){window.__readerAborted=true;this.onabort?.();}};const f=document.querySelector('form[data-door=photo]'),d=new DataTransfer();d.items.add(new File(['fake'],'fake.png',{type:'image/png'}));f.image.files=d.files;f.requestSubmit();})()`);
    await waitFor(`!!window.__heldReader`);
    await js(`document.querySelector('form[data-door=photo] [data-import-cancel]').click();window.__heldReader.result='data:image/png;base64,ZmFrZQ==';window.__heldReader.onload?.();window.FileReader=window.__realReader`);
    await noDialog("cancelled image read opens nothing");
    check(await js(`window.__readerAborted===true`), "Cancel aborts the image reader");
    check(await count("extract_from_image") === images, "cancelled image read never starts AI extraction");
    await js(`(()=>{const f=document.querySelector('form[data-door=photo]'),d=new DataTransfer();d.items.add(new File(['fake'],'fake.png',{type:'image/png'}));f.image.files=d.files;f.requestSubmit();})()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_image').length===${images + 1}`);
    await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-form=profile]')`);
    await abortCheck("extract_from_image", images, "photo navigation aborts extraction");
    await reply("extract_from_image", images, {merchant:null,date:"2026-10-01",currency:"SGD",total_text:"5.00",items:[]});
    await noDialog("late photo reply opens no choice dialog");
    await goAdd();
  }
  check(JSON.stringify(await totals()) === JSON.stringify(baseline), "cancelled preparations/reviews save no transactions, batches or merchant rules");

  // Active errors still fall back; manual mapping cancellation stops its own category request.
  await js(`import('./js/lib/store.js').then(({store})=>store.update('profile',store.one('profile').id,{consent:{ai_provider:false}}))`);
  await waitFor(`!!document.querySelector('form[data-door=csv]')`);
  await js(`(()=>{const f=document.querySelector('form[data-door=csv]'),d=new DataTransfer();d.items.add(new File(['Date,Amount,Description\\n2026-10-01,-5.00,Unknown manual probe'],'manual.csv'));f.csv.files=d.files;f.requestSubmit();})()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=amount_col]')`);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  check(JSON.stringify(await totals()) === JSON.stringify(baseline), "manual map Cancel saves nothing");
  if (hasCancel) check(await js(`document.querySelector('form[data-door=csv]').csv.files.length===0`), "manual map Cancel clears unfinished input");

  // Actual per-row failure seam: first ready row saves, another needs absent account FX;
  // unticked row must not be falsely recorded as confirmed, and retries never duplicate success.
  await js(`import('./js/lib/store.js').then(({store})=>{for(const r of store.all('fx_rates'))store.softDelete('fx_rates',r.id);})`);
  const beforeSave = await totals();
  await js(`(()=>{const f=document.querySelector('form[data-door=csv]'),d=new DataTransfer();d.items.add(new File(['Date,Amount,Description,Currency\\n2026-10-01,-5.00,,SGD\\n2026-10-01,-7.00,,HKD\\n2026-10-01,-9.00,,SGD'],'mixed.csv'));f.csv.files=d.files;f.requestSubmit();})()`);
  await waitFor(`!!document.querySelector('[data-modal-form] [name=amount_col]')`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.amount_col.value='Amount';f.description_col.value='Description';f.currency_col.value='Currency';f.requestSubmit();})()`);
  await waitFor(`document.querySelectorAll('[data-modal-form] [name=inc]').length===3`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.querySelector('[name=inc][value="2"]').checked=false;f.requestSubmit();})()`);
  await waitFor(`!!document.querySelector('[data-modal-form] tr .error')`);
  const afterSave = await totals();
  check(afterSave[0] === beforeSave[0] + 1, "confirmed mixed batch saves the valid row and shows the failed conversion row");
  check(await js(`import('./js/lib/store.js').then(({store})=>store.all('import_batches').at(-1).rows[2].status==='skipped')`), "unticked ready row is recorded as skipped, not confirmed");
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await settle();
  check((await totals())[0] === afterSave[0], "retry of a failed batch cannot duplicate an already confirmed row");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  check((await totals())[0] === afterSave[0], "Cancel after per-row failures preserves records already confirmed");

  // Text sequence must survive the synchronous Add re-render caused by confirmed writes.
  await js(`import('./js/lib/store.js').then(({store})=>store.update('profile',store.one('profile').id,{consent:{ai_provider:true}}))`);
  await goAdd();
  const text = await count("extract_from_text");
  await js(`(()=>{const f=document.querySelector('form[data-door=text]');f.text.value='two fake expenses';f.requestSubmit();})()`);
  await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_text').length===${text + 1}`);
  await reply("extract_from_text", text, {items:[{amount_text:"3.00",kind:"expense",merchant:null,date:"2026-10-01"},{amount_text:"4.00",kind:"expense",merchant:null,date:"2026-10-01"}]});
  await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('(1/2)')`);
  const beforeText = (await totals())[0];
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('(2/2)')`);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  check((await totals())[0] === beforeText + 1, "sequence Cancel keeps the first confirmed record and discards remaining drafts");

  // Photo choice Cancel saves nothing; a two-item sequence survives both confirmed writes.
  await goAdd();
  let photo = await count("extract_from_image");
  const submitPhoto = () => js(`(()=>{const f=document.querySelector('form[data-door=photo]'),d=new DataTransfer();d.items.add(new File(['fake'],'fake.png',{type:'image/png'}));f.image.files=d.files;f.requestSubmit();})()`);
  const receipt = {merchant:null,date:"2026-10-01",currency:"SGD",total_text:"7.00",items:[{description:"Fake item A",amount_text:"3.00"},{description:"Fake item B",amount_text:"4.00"}]};
  const beforePhoto = (await totals())[0];
  await submitPhoto(); await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_image').length===${photo + 1}`);
  await reply("extract_from_image", photo, receipt); await waitFor(`!!document.querySelector('[data-items]')`);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  check((await totals())[0]===beforePhoto && await js(`document.querySelector('form[data-door=photo]').image.files.length===0`), "photo choice Cancel resets input without saving");
  photo = await count("extract_from_image");
  await submitPhoto(); await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_image').length===${photo + 1}`);
  await reply("extract_from_image", photo, receipt); await waitFor(`!!document.querySelector('[data-items]')`);
  await js(`document.querySelector('[data-items]').click()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('(1/2)')`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('(2/2)')`);
  check(await js(`import('./js/lib/store.js').then(({store})=>!store.one('profile').subcategory_prompt_shown_at)`), "subcategory prompt stays deferred while another draft needs confirmation");
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('Turn on subcategories?')`);
  check((await totals())[0]===beforePhoto + 2, "photo item confirmation preserves both records across Add redraws");
  check(await js(`import('./js/lib/store.js').then(({store})=>!!store.one('profile').subcategory_prompt_shown_at)`), "optional subcategory prompt appears only after successful import completion");
  check(await js(`window.__pageHideListeners.size`) === pageHideListeners, "successful completion removes its browser departure handler");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);

  // Cancel/Escape and actual departure dispose remaining drafts even when storage
  // is held. A confirmed first row can finish, but it must never advance old UI.
  for (const departure of ['navigation', 'cancel', 'escape', 'pagehide']) {
    await goAdd();
    const savedBefore = (await totals())[0];
    await js(`(async()=>{
      const {store,DEMO_KEY}=await import('./js/lib/store.js');await store.retryPending();
      const snapshot=store.snapshot();window.__heldImportWrites=0;window.__releaseImportSave=null;
      store.open(snapshot,async captured=>{window.__heldImportWrites++;if(window.__heldImportWrites===1)await new Promise(resolve=>window.__releaseImportSave=resolve);localStorage.setItem(DEMO_KEY,JSON.stringify(captured));});
      document.querySelector('#toast-root').replaceChildren();
    })()`);
    const pendingText = await count('extract_from_text');
    await js(`(()=>{const f=document.querySelector('form[data-door=text]');window.__heldTextForm=f;f.text.value='two held fake expenses';f.requestSubmit();})()`);
    await waitFor(`window.__pendingImports.filter(r=>r.task==='extract_from_text').length===${pendingText + 1}`);
    await reply('extract_from_text', pendingText, {items:[{amount_text:'31.00',kind:'expense',merchant:null,date:'2026-10-01'},{amount_text:'32.00',kind:'expense',merchant:null,date:'2026-10-01'}]});
    await waitFor(`document.querySelector('[data-modal-form]')?.parentElement.textContent.includes('(1/2)')`);
    await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
    await waitFor(`!!window.__releaseImportSave && document.querySelector('[data-modal-form]')?.getAttribute('aria-busy')==='true'`);
    check(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.transactions.length`)===savedBefore, `${departure}: no saved acknowledgement while storage is held`);
    if (departure === 'navigation') {
      await js(`location.hash='#/settings'`);await settle();
      check(await js(`location.hash==='#/settings' && !!document.querySelector('[data-form=profile]')`), 'held import never blocks navigation');
    } else if (departure === 'cancel') await js(`document.querySelector('[data-action=modal-cancel]').click()`);
    else if (departure === 'escape') await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    else await js(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
    await noDialog(`${departure}: saving dialog is disposed immediately`);
    check(await js(`window.__heldTextForm.text.value==='' && window.__pageHideListeners.size===${pageHideListeners}`), `${departure}: unfinished input and departure handler are cleared`);
    await js(`(async()=>{const {modal}=await import('./js/lib/ui.js');modal({title:'Fresh dialog',body:'<p>New work, not the departed draft.</p>'});window.__releaseImportSave();})()`);
    await waitFor(`(async() => !(await import('./js/lib/store.js')).store.persistenceState().dirty)()`);
    await settle();
    check((await totals())[0]===savedBefore+1 && await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.transactions.length`)===savedBefore+1, `${departure}: the confirmed row is saved once, the second draft is not saved`);
    check(await js(`window.__heldImportWrites===1 && document.querySelector('[role=dialog] h2')?.textContent==='Fresh dialog' && document.querySelector('#toast-root').textContent===''`), `${departure}: old completion cannot advance drafts, close a newer dialog or show a late toast`);
    await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  }

  // Real document navigation, not just a synthetic event; store fake booleans only.
  await goAdd(); index = await submitCsv();
  await js(`window.addEventListener('pagehide', function captureDeparture() {
    const request=window.__pendingImports.filter(r=>r.task==='map_csv_columns')[${index}];
    sessionStorage.setItem('__hodosTestDeparture',JSON.stringify({aborted:request.signal.aborted,reset:document.querySelector('form[data-door=csv]').csv.files.length===0}));
    window.removeEventListener('pagehide',captureDeparture);
  }, {once:true})`);
  await cmd('Page.navigate', {url:`${srv.url}?demo=1&native-leave=1#/settings`});
  await waitFor(`!!document.querySelector('[data-form=profile]')`);
  const departure = await js(`JSON.parse(sessionStorage.getItem('__hodosTestDeparture'))`);
  check(departure?.aborted === true, "real document departure aborts the held request");
  check(departure?.reset === true, "real document departure clears the unfinished file before leaving");

  // Account changes must abort before waiting for locking/selection.
  await goAdd(); index = await submitCsv();
  await js(`import('./js/lib/session.js').then(({session})=>session.accountChanged())`);
  await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await abortCheck("map_csv_columns", index, "account change immediately aborts pending import");
  await reply("map_csv_columns", index); await noDialog("late reply after account change opens nothing");

  // Real lock lifecycle on an isolated fake encrypted vault (no physical provider).
  await cmd('Page.navigate', {url:`${srv.url}?demo=1#/add`});
  await waitFor(`!!document.querySelector('form[data-door=csv]')`);
  await js(`import('./js/lib/vault.js').then(v=>v.create({passkey:{credId:'fake-import-device',prfSalt:new Uint8Array(32),secret:new Uint8Array(32),rpId:'localhost'}}))`);
  index = await submitCsv();
  await js(`import('./js/lib/session.js').then(({session})=>session.lockNow())`);
  await waitFor(`!!document.querySelector('.gate-mark')`);
  await abortCheck("map_csv_columns", index, "locking immediately aborts pending import");
  await reply("map_csv_columns", index); await noDialog("late reply after lock opens nothing");
  check(await js(`import('./js/lib/store.js').then(({store})=>store.all('transactions').length===0)`), "locked store receives no late record writes");
  assert.deepEqual(B.problems(), []);
  assert.deepEqual(failures, [], "import cancellation regressions");
} finally { B?.close(); srv.stop(); }

// Disposable demo, fake CSV/provider replies: row names, mapping correction and strict parsing.
import assert from 'node:assert/strict';
import { startServer, startChrome } from './browser-kit.mjs';
const failures = [];
const check = (value, message) => { console.log(`${value ? 'PASS' : 'FAIL'} ${message}`); if (!value) failures.push(message); };
const server = await startServer({ AUTH: 'off' });
let browser;
try {
  browser = await startChrome({ width: 360, height: 900 });
  const { cmd, js, waitFor } = browser;
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.csvRequests=[];
    const originalFetch=window.fetch;
    window.fetch=(url,options={})=>{
      const path=new URL(url,location.href).pathname;
      if(path==='/api/ai/status') return Promise.resolve(new Response(JSON.stringify({configured:true,sign_in_required:false}),{headers:{'Content-Type':'application/json'}}));
      if(path==='/api/ai') {
        const request=JSON.parse(options.body);window.csvRequests.push(request);
        const output=request.task==='assistant_csv_map'
          ? {date_col:'Date',amount_col:'Amount',debit_col:null,credit_col:null,description_col:'Description',currency_col:'Currency',reference_col:null,date_format:'YYYY-MM-DD',negative_means:'expense'}
          : request.task==='assistant_extract' ? {actions:[{kind:'log_transaction',params:{kind:'expense',amount_text:'1',currency:'SGD',date:'2026-10-01',note:request.input.message}}],text:null,complete:true}
          : {items:request.input.items.map(()=>({category_id:null,confidence:'low'}))};
        return Promise.resolve(new Response(JSON.stringify({output}),{headers:{'Content-Type':'application/json'}}));
      }
      return originalFetch(url,options);
    }` });
  await cmd('Page.navigate', { url: `${server.url}?demo=1#/add` });
  await waitFor(`!!document.querySelector('form[data-door=upload]') && !!localStorage.getItem('pfa.demo')`);
  const snapshot = () => js(`(async()=>{const {store}=await import('./js/lib/store.js');await store.retryPending();return JSON.stringify(store.snapshot());})()`);
  const before = await snapshot();
  for (const [text, format, expected] of [
    ['2024-02-29','YYYY-MM-DD','2024-02-29'], ['29/02/2024','DD/MM/YYYY','2024-02-29'],
    ['20240229','YYYYMMDD','2024-02-29'], ['29 02 2024','DD MM YYYY','2024-02-29'],
    ['29/02/24','DD/MM/YYYY','2024-02-29'], ['29022024','DDMMYYYY','2024-02-29'],
    ['2024-02-30','YYYY-MM-DD',null], ['2025-02-29','YYYY-MM-DD',null],
    ['31/11/2024','DD/MM/YYYY',null], ['2024/02/29','YYYY-MM-DD',null],
    ['Feb 30, 2024','YYYY-MM-DD',null],
  ]) check(await js(`import('./js/features/transactions.js').then(T=>T.parseDateWith(${JSON.stringify(text)},${JSON.stringify(format)}))`) === expected, `CSV date ${text} obeys its declared format and calendar`);
  const mapped = await js(`import('./js/features/transactions.js').then(T=>T.applyMapping([
    ['2024-02-29','-5.00','currency probe','XYZ'],['2024-02-29','-5.00','currency probe',' usd '],
    ['2024-02-29','-5.00','currency probe',''],['2024-02-30','-5.00','date probe','SGD']
  ],['Date','Amount','Description','Currency'],{date_col:'Date',amount_col:'Amount',description_col:'Description',currency_col:'Currency',date_format:'YYYY-MM-DD',negative_means:'expense'},'SGD'))`);
  check(mapped[0].status === 'failed' && mapped[0].raw.Currency === 'XYZ', 'unsupported explicit CSV currency is rejected, never replaced by the account currency');
  check(mapped[1].status === 'ready' && mapped[1].parsed.money.currency === 'USD', 'supported currency trims whitespace without changing its identity');
  check(mapped[2].status === 'ready' && mapped[2].parsed.money.currency === 'SGD', 'absent optional CSV currency retains the account default');
  check(mapped[3].status === 'failed', 'impossible date fails during mapping, before suggestions');
  check(await snapshot() === before, 'parser checks cause no storage or learning changes');

  // Mount the existing manual mapping dialog, not a second import implementation.
  await js(`(async()=>{const T=await import('./js/features/transactions.js');T.manualMap(['Date','Amount','Description','Debit','Credit'],[['01/10/2026','-5.00','','5.00','']],null,mp=>{window.appliedMapping=mp;return false;});})()`);
  await waitFor(`document.activeElement?.name==='date_col'`);
  const requestsBeforeInvalidMapping = await js(`window.csvRequests.length`);
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.date_format.value='';f.requestSubmit();})()`);
  check(await js(`['date_format','amount_col','debit_col','credit_col'].every(name=>document.querySelector('[name='+name+']').getAttribute('aria-invalid')==='true')`), 'mapping Apply exposes format and amount-group errors together');
  check(await js(`document.activeElement?.name==='date_format'`), 'mapping failure focuses the first invalid field');
  check(await js(`!window.appliedMapping && window.csvRequests.length===${requestsBeforeInvalidMapping}`), 'invalid mapping starts no next step or AI work');
  check(await snapshot() === before, 'invalid mapping writes nothing');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.date_format.value='DD/MM/YYYY';f.elements.date_format.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  check(await js(`!document.querySelector('[name=date_format]').hasAttribute('aria-invalid') && document.querySelector('[name=amount_col]').getAttribute('aria-invalid')==='true'`), 'mapping correction clears only the resolved format issue');
  await js(`(()=>{const c=document.querySelector('[name=amount_col]');c.value='Amount';c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  check(await js(`['amount_col','debit_col','credit_col'].every(name=>!document.querySelector('[name='+name+']').hasAttribute('aria-invalid'))`), 'one amount column resolves all dependent amount-group issues');
  check(await snapshot() === before, 'mapping correction alone writes nothing');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  check(await js(`window.appliedMapping?.amount_col==='Amount' && window.appliedMapping?.date_format==='DD/MM/YYYY'`), 'corrected mapping advances only after explicit Apply');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.elements.amount_col.value='';f.requestSubmit();})()`);
  check(await js(`document.querySelector('[name=credit_col]').getAttribute('aria-invalid')==='true' && window.appliedMapping.amount_col==='Amount'`), 'removing the signed column exposes the missing alternatives without advancing');
  await js(`(()=>{const c=document.querySelector('[name=debit_col]');c.value='Debit';c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  check(await js(`document.querySelector('[name=credit_col]').getAttribute('aria-invalid')==='true'`), 'debit alone leaves the required credit alternative unresolved');
  await js(`(()=>{const c=document.querySelector('[name=credit_col]');c.value='Credit';c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  check(await js(`['amount_col','debit_col','credit_col'].every(name=>!document.querySelector('[name='+name+']').hasAttribute('aria-invalid')) && window.appliedMapping.amount_col==='Amount'`), 'both debit and credit resolve dependent issues without advancing');
  check(await snapshot() === before, 'amount alternative correction saves nothing');
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  check(await js(`window.appliedMapping.amount_col===null && window.appliedMapping.debit_col==='Debit' && window.appliedMapping.credit_col==='Credit'`), 'explicit Apply accepts the existing debit/credit alternative');
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);

  const csv = 'Date,Amount,Description,Currency\n2026-10-01,-5.00,U4 CSV coffee,SGD\n2026-02-30,-9.00,U4 impossible date,SGD\n2026-10-01,-9.00,U4 unsupported currency,XYZ\n2026-10-01,-6.00,U4 untouched row,SGD';
  await js(`(()=>{const f=document.querySelector('form[data-door=upload]'),d=new DataTransfer();d.items.add(new File([${JSON.stringify(csv)}],'u4-rows.csv',{type:'text/csv'}));f.elements.files.files=d.files;f.elements.files.dispatchEvent(new Event('change'));f.requestSubmit();})()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.textContent.includes('Selected files')`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`);
  await waitFor(`!!document.querySelector('[data-modal-form] tr[data-i="0"]')`);
  check(await js(`(()=>{const r=document.querySelector('tr[data-i="0"]');return ['[name=inc]','[data-cat]'].every(selector=>{const name=r.querySelector(selector).getAttribute('aria-label')||'';return name.includes('1')&&name.includes('2026-10-01')&&name.includes('U4 CSV coffee')&&/include|category/i.test(name);});})()`), 'CSV controls name the row, date, merchant and field');
  check(await js(`(()=>{const controls=[...document.querySelectorAll('[data-cat]')];return new Set(controls.map(c=>c.name)).size===controls.length;})()`), 'CSV category fields have distinct form names');
  check(await js(`document.querySelector('tr[data-i="1"] [name=inc]').disabled && document.querySelector('tr[data-i="2"] [name=inc]').disabled`), 'invalid date and currency rows cannot be included');
  check(await js(`window.csvRequests.filter(r=>r.task==='classify_category').every(r=>r.input.items.every(i=>!i.merchant.includes('unsupported')&&!i.merchant.includes('impossible')))`), 'invalid rows do not reach category AI');
  check(await snapshot() === before, 'review and category suggestions save nothing');
  await js(`(()=>{const f=document.querySelector('[data-modal-form]');f.querySelectorAll('[name=inc]').forEach(c=>c.checked=c.value==='0');f.requestSubmit();})()`);
  await waitFor(`!document.querySelector('[data-modal-form]') && location.hash==='#/transactions'`);
  const saved = JSON.parse(await snapshot()), old = JSON.parse(before);
  check(saved.tables.transactions.length === old.tables.transactions.length + 1, 'one selected valid row saves exactly once');
  const ledger = saved.tables.import_batches.find(b=>b.file_name==='u4-rows.csv');
  check(ledger?.rows.map(r=>r.status).join(',') === 'confirmed,failed,failed,skipped', 'ledger preserves confirmed, failed and unticked outcomes');
  await js(`location.hash='#/add'`);await waitFor(`!!document.querySelector('form[data-door=upload]')`);
  check(await js(`!!document.querySelector('form[data-door=upload] select[name=hint]')`),'image hint is a real select control, not escaped markup');
  await js(`(async()=>{const {PDFDocument}=await import('./vendor/pdf-lib.esm.js');const pdf=await PDFDocument.create();pdf.addPage([100,100]);const d=new DataTransfer();d.items.add(new File([await pdf.save()],'fictional.pdf',{type:'application/pdf'}));const f=document.querySelector('form[data-door=upload]');f.elements.context.value='PDF context after choosing a file';f.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));f.requestSubmit();})()`);await waitFor(`!!document.querySelector('[data-modal-form]')`);await js(`document.querySelector('[data-modal-form]').requestSubmit()`);await waitFor(`!!document.querySelector('[data-modal-form] [name=amount]')`);
  check(await js(`window.csvRequests.at(-1).documents?.[0].media_type==='application/pdf'&&window.csvRequests.at(-1).input.message==='PDF context after choosing a file'`),'Add PDF drop uses native shared PDF extraction with accompanying context');await js(`document.querySelector('[data-action=modal-cancel]').click()`);await waitFor(`!document.querySelector('[data-modal-form]')&&document.querySelector('[data-file-list]').children.length===0`);
  await js(`(async()=>{const {store}=await import('./js/lib/store.js');const p=store.one('profile');store.update('profile',p.id,{consent:{...p.consent,ai_provider:false}});location.hash='#/settings';})()`);await waitFor(`!!document.querySelector('[data-form=profile]')`);await js(`location.hash='#/add'`);await waitFor(`!!document.querySelector('form[data-door=upload]')`);
  const beforeManual=await js(`window.csvRequests.length`);
  await js(`(()=>{const f=document.querySelector('form[data-door=upload]'),d=new DataTransfer();d.items.add(new File(['Date,Amount,Description\\n2026-10-01,-1,Manual'],'manual.csv'));f.elements.files.files=d.files;f.elements.files.dispatchEvent(new Event('change'));f.requestSubmit();})()`);await waitFor(`!!document.querySelector('[name=date_col]')`);
  check(await js(`window.csvRequests.length===${beforeManual}`),'AI-off unified upload opens manual CSV mapping without a provider request');await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  assert.deepEqual(browser.problems(), []);
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('PASS CSV row labels, correctable mapping, calendar/currency rejection and explicit confirmation');
} finally { browser?.close(); server.stop(); }

// Manual-rate journeys in isolated Chrome, using disposable sample records only.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";
const srv = await startServer({ AUTH: "off" }); let B;
try {
  const retired = await fetch(srv.url + "api/fx?from=USD&to=SGD&date=2020-01-01");
  assert.equal(retired.status, 410); assert.equal((await retired.json()).code, "MANUAL_RATES");
  B = await startChrome({ width: 360, height: 1000 });
  const { js, cmd, waitFor, shot } = B;
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `window.rateRequests = []; const original = window.fetch; window.fetch = (...args) => { const url = String(args[0]?.url || args[0]); if (url.includes('/api/fx') || /frankfurter/.test(url)) { window.rateRequests.push(url); return Promise.reject(new Error('Unexpected online rate request')); } return original(...args); };` });
  await cmd("Page.navigate", { url: srv.url + "?demo=1#/settings" });
  await waitFor(`!!document.querySelector('[data-form=profile]') && !!localStorage.getItem('pfa.demo')`);
  const modules = () => js(`(async () => { window.mods = { store: (await import('./js/lib/store.js')).store, P: await import('./js/features/profile.js'), A: await import('./js/features/accounts.js'), T: await import('./js/features/transactions.js'), H: await import('./js/features/investments.js'), FX: await import('./js/lib/fx.js') }; })()`);
  await modules();
  await js(`(() => { const p = structuredClone(mods.P.profile()); p.base_currency = 'SGD'; p.overseas_currency = null; p.consent.ai_provider = false; mods.store.importJson({ schema_version: 1, tables: { profile: [p], budget_settings: [{ id: 'budget', start_day: 1, default_thresholds: [80,100] }] } }); window.bank = mods.A.create({ name: 'Bank', type: 'bank', currency: 'SGD', openedOn: '2015-01-01', openingBalance: {amount:100000,currency:'SGD'} }); })()`);
  const settings = async (hash = "#/settings") => { await js(`location.hash = ${JSON.stringify(hash)}`); await waitFor(`!!document.querySelector('[data-form=profile]')`); };
  const count = (table) => js(`mods.store.all(${JSON.stringify(table)}).length`);
  const reviewRate = async (from, to, rate, date = null) => {
    await js(`(() => { const f = document.querySelector('[data-form=fx]'); f.from.value=${JSON.stringify(from)}; f.to.value=${JSON.stringify(to)}; f.rate.value=${JSON.stringify(rate)}; f.scope.value=${JSON.stringify(date ? 'past' : 'current')}; f.scope.dispatchEvent(new Event('change')); ${date ? `f.date.value=${JSON.stringify(date)};` : ''} f.requestSubmit(); })()`);
    await waitFor(`document.querySelector('.modal h2')?.textContent === 'Save exchange rate?'`);
  };
  const confirmRate = async (...args) => { const n = await count("fx_rates"); await reviewRate(...args); await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await waitFor(`mods.store.all('fx_rates').length === ${n + 1} && !document.querySelector('.modal')`); };
  assert.equal(await js(`!!document.querySelector('#exchange-rates')`), false);
  assert.equal(await js(`document.querySelector('[data-overseas-controls]').hidden && document.querySelector('[data-form=overseas]').currency.disabled`), true);
  await js(`(() => { const f=document.querySelector('[data-form=overseas]'); f.elements.on.checked=true; f.elements.on.dispatchEvent(new Event('change')); })()`);
  assert.equal(await js(`document.querySelector('[data-overseas-controls]').hidden`), false);
  await js(`document.querySelector('[data-form=overseas]').requestSubmit()`);
  await waitFor(`!!document.querySelector('#exchange-rates')`);
  assert.match(await js(`document.querySelector('#exchange-rates').innerText`), /Exchange rate missing/);
  assert.equal(await js(`/PRD|interim|frankfurter|blank = fetch/i.test(document.body.innerText)`), false);
  for (const rate of ["", "0", "-1", "1e3"]) {
    await js(`(() => { const f=document.querySelector('[data-form=fx]'); f.rate.value=${JSON.stringify(rate)}; f.requestSubmit(); })()`);
    assert.equal(await count("fx_rates"), 0); assert.match(await js(`document.querySelector('[data-rate-error]').textContent`), /above zero/);
  }
  await js(`(() => { const f=document.querySelector('[data-form=fx]'); f.from.value='SGD'; f.to.value='SGD'; f.rate.value='1'; f.requestSubmit(); })()`);
  assert.match(await js(`document.querySelector('[data-rate-error]').textContent`), /different currencies/);
  await reviewRate("USD", "SGD", "1.30");
  assert.match(await js(`document.querySelector('.fx-confirm').textContent`), /1 USD = 1.30 SGD/);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`); assert.equal(await count("fx_rates"), 0);
  await confirmRate("USD", "SGD", "1.30");
  assert.equal(await js(`document.querySelector('.fx-history').open`), false);
  assert.match(await js(`document.querySelector('.fx-current').innerText`), /Entered/);
  console.log("PASS need-only controls, conditional Overseas currency, directed decimals, validation, review and cancelled writes");

  await js(`mods.T.confirmModal({ account_id: bank.id, money: {amount:1000,currency:'USD'}, date:mods.P.today() }, { onDone: row => window.savedId=row.id })`);
  assert.match(await js(`document.querySelector('[data-approx]').textContent`), /13.00/);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await waitFor(`!!window.savedId && !document.querySelector('.modal')`);
  const frozen = await js(`JSON.stringify(mods.T.get(savedId))`);
  await confirmRate("USD", "SGD", "1.50");
  assert.equal(await js(`JSON.stringify(mods.T.get(savedId))`), frozen);
  await js(`(() => { const f=document.querySelector('[data-form=overseas]'); f.elements.on.checked=false; f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[data-overseas-controls]')?.hidden === true`);
  assert.equal(await js(`document.querySelector('[data-overseas-controls]').hidden`), true);
  assert.equal(await js(`!!document.querySelector('#exchange-rates')`), true, "foreign entered price keeps rates relevant, even without a foreign account");
  assert.equal(await js(`JSON.stringify(mods.T.get(savedId))`), frozen);
  await js(`mods.T.confirmModal({ account_id: bank.id, money: {amount:1000,currency:'USD'}, date:'2020-01-04' })`);
  assert.match(await js(`document.querySelector('[data-rate-note]').textContent`), /Exchange rate missing/);
  await js(`document.querySelector('[data-update-rate]').click()`);
  await waitFor(`document.querySelector('[data-form=fx]')?.scope.value === 'past' && !document.querySelector('.modal')`);
  assert.equal(await js(`document.querySelector('[data-form=fx]').date.value`), "2020-01-04");
  await confirmRate("USD", "SGD", "1.20", "2020-01-04");
  assert.equal(await js(`mods.FX.liveRate('USD','SGD').rate`), "1.50");
  await js(`mods.T.confirmModal({ account_id: bank.id, money: {amount:1000,currency:'USD'}, date:'2020-01-04' })`);
  assert.match(await js(`document.querySelector('[data-approx]').textContent`), /12.00/);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await waitFor(`!document.querySelector('.modal')`);
  assert.equal(await js(`mods.T.all().find(t=>t.date==='2020-01-04').entered_fx.rate`), "1.20");
  console.log("PASS frozen travel records, mode-off visibility and date-specific missing-rate recovery");

  await js(`window.euro = mods.H.create({ name:'Euro fund', type:'fund', currency:'EUR', mode:'value' }); location.hash='#/investments/'+euro.id`);
  await waitFor(`!!document.querySelector('[data-action=deposit]')`); await js(`document.querySelector('[data-action=deposit]').click()`);
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.amount.value='100'; f.date.value='2020-01-04'; f.date.dispatchEvent(new Event('change')); f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.textContent.includes('Exchange rate missing')`);
  assert.equal(await count("cash_flows"), 0); assert.equal(await js(`document.querySelector('[data-modal-form] a[href*="rate-from=EUR"]').getAttribute('href')`), '#/settings?rate-from=EUR&rate-to=SGD&rate-date=2020-01-04');
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.rate.value='0'; f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('[data-modal-form]')?.textContent.includes('Enter a valid exchange rate.') && document.querySelector('[data-modal-form] [name=rate]')?.getAttribute('aria-invalid')==='true'`); assert.equal(await count("cash_flows"), 0);
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.rate.value='1.60'; f.requestSubmit(); })()`);
  await waitFor(`mods.store.all('cash_flows').length===1 && !document.querySelector('.modal')`);
  await js(`document.querySelector('[data-action=value]').click()`);
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.value.value='200'; f.rate.value='1.50'; f.requestSubmit(); })()`);
  await waitFor(`mods.store.all('valuations').length===1 && !document.querySelector('.modal')`);
  const investments = await js(`JSON.stringify([mods.store.all('cash_flows'),mods.store.all('valuations')])`);
  await js(`location.hash='#/investments'`); await waitFor(`document.body.innerText.includes('Exchange rate missing: EUR')`);
  await js(`document.querySelector('a[href*="rate-from=EUR"]').click()`); await waitFor(`document.querySelector('[data-form=fx]')?.from.value==='EUR'`);
  await confirmRate("EUR", "SGD", "1.45");
  assert.equal(await js(`JSON.stringify([mods.store.all('cash_flows'),mods.store.all('valuations')])`), investments);
  assert.equal(await js(`mods.H.summary().totalBase.amount`), 29000);
  console.log("PASS investment missing-rate links, refused invalid writes, typed historical rates and frozen ledger versus current totals");

  await js(`window.yen=mods.A.create({name:'Yen wallet',type:'wallet',currency:'JPY',openedOn:'2015-01-01'}); location.hash='#/add'`);
  await waitFor(`!!document.querySelector('form[data-door=upload]')`);
  await js(`(() => { const f=document.querySelector('form[data-door=upload]'), dt=new DataTransfer(); dt.items.add(new File(['date,amount,merchant\\n'+mods.P.today()+',-1200,Ramen\\n'].map(s=>s.replaceAll('\\\\n','\\n')), 'manual.csv', {type:'text/csv'})); f.elements.files.files=dt.files; f.elements.files.dispatchEvent(new Event('change')); f.account.value=yen.id; f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('.modal h2')?.textContent==='Map the columns'`);
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.date_col.value='date'; f.amount_col.value='amount'; f.description_col.value='merchant'; f.requestSubmit(); })()`);
  await waitFor(`document.querySelector('.modal h2')?.textContent==='Review manual.csv'`);
  assert.match(await js(`document.querySelector('.modal').innerText`), /Exchange rate missing: JPY/);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await waitFor(`!document.querySelector('.modal') && location.hash==='#/transactions'`);
  assert.equal(await js(`mods.T.all().find(t=>t.source==='csv').base_money`), null);
  await js(`mods.A.transferModal({fromId:bank.id,toId:yen.id,out:'5'})`);
  assert.match(await js(`document.querySelector('[data-propose]').textContent`), /Exchange rate missing/);
  await js(`(() => { const f=document.querySelector('[data-modal-form]'); f.in.value='350'; f.requestSubmit(); })()`); await waitFor(`!document.querySelector('.modal')`);
  assert.equal(await js(`mods.T.all().find(t=>t.kind==='transfer').counter_money.amount`), 350);
  assert.equal(await js(`mods.T.all().find(t=>t.kind==='transfer').fx.rate`), "70.000000");
  console.log("PASS foreign CSV warnings/absent totals and exact two-amount transfers without lookup");

  await settings();
  for (const width of [320, 360, 420, 1024]) for (const theme of ["light", "dark"]) {
    await cmd("Emulation.setDeviceMetricsOverride", {width,height:1000,deviceScaleFactor:1,mobile:width<600});
    await js(`(async () => (await import('./js/lib/theme.js')).setTheme(${JSON.stringify(theme)}))()`);
    assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`), false, `rate editor ${width}/${theme} overflow`);
    assert.equal(await js(`document.querySelector('.fx-history').open`), false);
    if (width===360) { await js(`document.querySelector('#exchange-rates').scrollIntoView()`); await shot('manual-rates-'+theme); }
  }
  await js(`document.querySelector('.fx-history summary').click()`); assert.equal(await js(`document.querySelectorAll('.fx-history-row').length`), 4);
  const history = await js(`JSON.stringify([mods.store.all('transactions'),mods.store.all('valuations'),mods.store.all('cash_flows')])`);
  await cmd("Page.reload", {ignoreCache:true}); await waitFor(`!!document.querySelector('[data-form=fx]')`); await modules();
  assert.equal(await js(`JSON.stringify([mods.store.all('transactions'),mods.store.all('valuations'),mods.store.all('cash_flows')])`), history);
  assert.equal(await js(`document.querySelector('.fx-history').open`), false);
  assert.equal(await js(`window.rateRequests.length`), 0);
  assert.deepEqual(B.problems(), []);
  console.log(`PASS phone/desktop light/dark, expandable history, reload and no online rate requests. Screenshots: ${B.shots}`);
} finally { B?.close(); srv.stop(); }

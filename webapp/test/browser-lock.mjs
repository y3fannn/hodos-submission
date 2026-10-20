// Real Chrome, accounts off: PRF enrollment, local lock, recovery, reload and encrypted storage.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";
const srv = await startServer({ AUTH: "off" }), B = await startChrome();
const { cmd, js, waitFor, shot } = B;
try {
  await cmd("WebAuthn.enable", { enableUI: false });
  await cmd("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await cmd("Page.navigate", { url: srv.url }); await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await js(`(() => { const f=document.querySelector('[data-form=profile-create]'); f.name.value='Duan'; f.requestSubmit(); })()`); await waitFor(`!!document.querySelector('[data-action=passkey]')`);
  assert.ok(await js(`!document.querySelector('input[type=password]')`));
  await js(`document.querySelector('[data-action=passkey]').click()`); await waitFor(`document.querySelectorAll('.words li').length===12`);
  let words = await js(`[...document.querySelectorAll('.words li')].map(l=>l.textContent)`);
  await js(`(()=>{window.__realNow=Date.now;Date.now=()=>window.__realNow()+6*60*1000;})()`);
  await waitFor(`!!document.querySelector('.gate-mark')`,25000); await js(`Date.now=window.__realNow`);
  assert.ok(await js(`Promise.all([import('./js/lib/vault.js'),import('./js/lib/store.js')]).then(([v,s])=>!v.isUnlocked()&&s.store.all('profile').length===0&&!document.querySelector('.words'))`));
  await js(`document.querySelector('[data-action=passkey]').click()`); await waitFor(`document.querySelectorAll('.words li').length===12`);
  const replacement = await js(`[...document.querySelectorAll('.words li')].map(l=>l.textContent)`);
  assert.notDeepEqual(replacement, words); words = replacement;
  console.log('PASS idle during recovery setup clears keys/words; next device approval issues fresh unconfirmed words');
  await js(`(() => { const f=document.querySelector('[data-form=confirm]'); f.wa.value='wrong'; f.wb.value='words'; f.requestSubmit(); })()`); await waitFor(`/do not match/.test(document.querySelector('[data-error]').textContent)`);
  await js(`(() => { const ws=${JSON.stringify(words)}, f=document.querySelector('[data-form=confirm]'); const n=[...f.querySelectorAll('label')].map(l=>Number(l.textContent.match(/Word (\\d+)/)?.[1])).filter(Boolean); f.wa.value=ws[n[0]-1]; f.wb.value=ws[n[1]-1]; f.requestSubmit(); })()`); await waitFor(`!document.getElementById('tabbar').hidden`);
  await js(`import('./js/lib/store.js').then(({store})=>store.insert('goals',{name:'PRIVATE_SHANGHAI',target:{amount:500000,currency:'SGD'}}))`); await js(`import('./js/lib/vault.js').then(v=>v.flush())`);
  const sealed = await js(`import('./js/lib/vault.js').then(v=>v.sealedRecord()).then(r=>JSON.stringify(r))`);
  assert.ok(!/PRIVATE_SHANGHAI|passphrase|Duan/.test(sealed));
  await js(`document.getElementById('lock-btn').click()`); await waitFor(`!!document.querySelector('.gate-mark')`);
  assert.ok(await js(`document.getElementById('alerts-btn').hidden && !document.body.innerText.includes('PRIVATE_SHANGHAI')`));
  await js(`document.querySelector('[data-action=passkey]').click()`); await waitFor(`!document.getElementById('tabbar').hidden`);
  await cmd('Page.reload'); await waitFor(`!!document.querySelector('.gate-mark')`);
  await js(`(() => { document.querySelector('.gate-recover').open=true; const f=document.querySelector('[data-form=words]'); f.words.value=${JSON.stringify(words.join(' '))}; f.requestSubmit(); })()`); await waitFor(`!document.getElementById('tabbar').hidden`);
  assert.ok(await js(`import('./js/lib/store.js').then(({store})=>store.all('goals')[0].name==='PRIVATE_SHANGHAI')`));
  await shot('local-recovered');
  // Simulate closing first setup after the key was stored but before the profile was saved.
  await js(`import('./js/lib/vault.js').then(v=>v.lock())`);
  await js(`new Promise(resolve=>{const r=indexedDB.open('pfa-vault');r.onsuccess=()=>{const t=r.result.transaction('vault','readwrite'),s=t.objectStore('vault'),q=s.get('account:local-device');q.onsuccess=()=>{const row=q.result;row.data=null;s.put(row,'account:local-device');};t.oncomplete=()=>{r.result.close();resolve(true);};};})`);
  await cmd('Page.reload'); await waitFor(`!!document.querySelector('.gate-mark')`);
  await js(`document.querySelector('[data-action=passkey]').click()`); await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await js(`(()=>{const f=document.querySelector('[data-form=profile-create]');f.name.value='Resumed setup';f.requestSubmit();})()`); await waitFor(`!document.getElementById('tabbar').hidden`);
  assert.ok(await js(`import('./js/lib/store.js').then(({store})=>store.one('profile').name==='Resumed setup')`));
  assert.deepEqual(B.problems().filter(l=>!/status of 4\d\d/.test(l)), []);
  console.log('Local device lock/recovery ALL PASS; screenshots:', B.shots);
} finally { B.close(); srv.stop(); }

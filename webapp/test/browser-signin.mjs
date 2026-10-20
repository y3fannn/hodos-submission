// Actual Chrome/IndexedDB + virtual PRF authenticator. No real phone/provider compatibility claim.
import { startServer, startChrome, sleep } from "./browser-kit.mjs";
const srv = await startServer({ AUTH_RESEND_SECONDS: "1", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GOOGLE_AUTH_URL: "https://google.test/auth" });
const B = await startChrome(), { cmd, js, waitFor, shot } = B;
let failures = 0;
const step = (name, ok = true) => { console.log(ok ? "•" : "✗ FAIL", name); if (!ok) failures++; };
const click = (s) => js(`document.querySelector(${JSON.stringify(s)}).click()`);
const status = () => js(`fetch('api/auth/status').then(r => r.json())`);
const hasApp = `!document.getElementById('tabbar').hidden`;
const addAuthenticator = async (hasPrf) => (await cmd("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf } })).result.authenticatorId;
const trackApprovals = () => js(`(() => { window.__approvals = 0; window.__nativeCredentialGet ||= navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = (o) => { window.__approvals++; return window.__nativeCredentialGet(o); }; })()`);
async function email(email, intent = "signin") {
  await js(`location.hash = ${JSON.stringify(intent === "signup" ? "#/signup" : "#/signin")}`);
  await waitFor(`!!document.querySelector('[data-form=email]')`);
  await js(`(() => { const f = document.querySelector('[data-form=email]'); f.email.value = ${JSON.stringify(email)}; f.requestSubmit(); })()`);
  await waitFor(`!!document.querySelector('[data-form=code]')`);
  const code = [...srv.out().matchAll(/code is (\d{6})/g)].at(-1)[1];
  await js(`(() => { const f = document.querySelector('[data-form=code]'); f.code.value = ${JSON.stringify(code)}; f.requestSubmit(); })()`);
}
async function enroll(name) {
  await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await js(`(() => { const f = document.querySelector('[data-form=profile-create]'); f.name.value = ${JSON.stringify(name)}; f.requestSubmit(); })()`);
  await waitFor(`!!document.querySelector('[data-action=passkey]')`);
  step("device setup has no passphrase fallback", await js(`!document.querySelector('input[type=password]')`));
  await click('[data-action=passkey]');
  await waitFor(`document.querySelectorAll('.words li').length === 12`, 20000);
  const words = await js(`[...document.querySelectorAll('.words li')].map(l => l.textContent)`);
  await js(`(() => { const ws = ${JSON.stringify(words)}, f = document.querySelector('[data-form=confirm]'); const n = [...f.querySelectorAll('label')].map(l => Number(l.textContent.match(/Word (\\d+)/)?.[1])).filter(Boolean); f.wa.value = ws[n[0]-1]; f.wb.value = ws[n[1]-1]; f.requestSubmit(); })()`);
  await waitFor(hasApp); return words;
}
async function signOut() {
  await js(`location.hash = '#/settings'`); await waitFor(`!!document.querySelector('[data-account=signout]')`);
  await click('[data-account=signout]'); await waitFor(`!!document.querySelector('[data-form=email]')`);
  step("sign-out immediately clears readable records and keys", await js(`Promise.all([import('./js/lib/store.js'), import('./js/lib/vault.js')]).then(([s,v]) => !v.isUnlocked() && s.store.all('accounts').length === 0 && s.store.all('profile').length === 0)`));
}
try {
  await cmd("WebAuthn.enable", { enableUI: false }); const authenticatorId = await addAuthenticator(true);
  // Seed the explicitly discarded shared test vault before any app code opens IndexedDB.
  await cmd("Page.navigate", { url: srv.url + "icon.svg" }); await waitFor(`location.pathname.endsWith('icon.svg')`);
  await js(`new Promise((resolve, reject) => { const r = indexedDB.open('pfa-vault', 1); r.onupgradeneeded = () => r.result.createObjectStore('vault'); r.onerror = () => reject(r.error); r.onsuccess = () => { const t = r.result.transaction('vault','readwrite'); t.objectStore('vault').put({v:1, fake:'DISPOSABLE_OLD_TEST'},'main'); t.oncomplete = () => { r.result.close(); localStorage.setItem('pfa.db', JSON.stringify({tables:{profile:[{name:'OLD_TEST_NAME'}]}})); resolve(true); }; }; })`);
  await cmd("Page.navigate", { url: srv.url + "#/home" }); await waitFor(`!!document.querySelector('[data-form=email]')`);
  step("passkey is the first returning-access choice; Google/email remain", await js(`document.querySelector('.auth-card [data-action]')?.dataset.action === 'passkey' && !!document.querySelector('[data-action=google] img')`));
  step("old shared vault and unencrypted test records are discarded, not migrated", await js(`new Promise(resolve => { const r = indexedDB.open('pfa-vault'); r.onsuccess = () => { const q=r.result.transaction('vault').objectStore('vault').get('main'); q.onsuccess=() => { const ok = r.result.version===2 && !q.result && !localStorage.getItem('pfa.db'); r.result.close(); resolve(ok); }; }; })`));
  await click('[data-action=demo]'); await waitFor(`!!document.querySelector('.demo-banner')`);
  await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-action=end-demo]')`); await click('[data-action=end-demo]');
  await waitFor(`document.querySelector('.auth-card h1')?.textContent==='Create an account'`);
  step("visitor demo still goes directly to explicit signup", !(await status()).signedIn);
  await email("a@example.com", "signup"); await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  step("email signup is identity-only before enrollment", !(await status()).deviceVerified);
  const wordsA = await enroll("Account A"), accountA = (await status()).account;
  step("one enrolled credential serves account access and encryption", accountA.passkeys === 1 && (await status()).deviceVerified);
  step("a fresh account never contains sample or retired test records", await js(`import('./js/lib/store.js').then(({store}) => store.all('accounts').length===0 && store.all('transactions').length===0 && store.one('profile').name==='Account A')`));
  await js(`import('./js/lib/store.js').then(({store}) => store.insert('accounts',{name:'A_PRIVATE_CASH',type:'cash',currency:'SGD',opening_balance:{amount:10000,currency:'SGD'},opened_on:'2026-10-06'}))`);
  await js(`import('./js/lib/vault.js').then(v => v.flush())`);
  const sealedA = await js(`import('./js/lib/vault.js').then(v => v.sealedRecord()).then(r => JSON.stringify(r))`);
  step("stored account-owned vault contains no readable records or passphrase wrapper", !/A_PRIVATE_CASH|Account A|passphrase/.test(sealedA) && JSON.parse(sealedA).owner === accountA.id);
  await shot("1-enrolled");

  await js(`location.hash='#/home'`); await waitFor(`!!document.querySelector('.home-panel')`);
  await js(`document.querySelector('.home-panel').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,pointerId:42,button:0,clientX:100,clientY:200}))`);
  await click('#lock-btn'); await sleep(750);
  step("locking cancels the Home hold with no late picker", await js(`!document.querySelector('[name=home_panel]') && !document.querySelector('.home-panel')`));
  await waitFor(`!!document.querySelector('.gate-mark')`); await click('[data-action=passkey]'); await waitFor(hasApp);
  await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-account=signout]')`);
  await click('#lock-btn'); await waitFor(`!!document.querySelector('.gate-mark')`); await trackApprovals(); await click('[data-action=passkey]'); await waitFor(hasApp);
  step("returning lock opens with one enrolled-device approval", await js(`window.__approvals === 1`));
  await js(`location.hash='#/recurring'`); await cmd('Page.reload'); await waitFor(`!!document.querySelector('.gate-mark')`); await click('[data-action=passkey]'); await waitFor(hasApp); await click('#back-btn');
  await waitFor(`location.hash==='#/settings'`); step("Back after a locked reload still goes to Settings");
  await signOut();
  const sealedAOnDisk = () => js(`new Promise(resolve => { const r=indexedDB.open('pfa-vault'); r.onsuccess=()=>{const q=r.result.transaction('vault').objectStore('vault').get('account:${accountA.id}');q.onsuccess=()=>{const data=JSON.stringify(q.result);r.result.close();resolve(data);};};})`);
  const beforeDemo = await sealedAOnDisk();
  await click('[data-action=demo]'); await waitFor(`!!document.querySelector('.demo-banner')`);
  await js(`location.hash='#/settings'`); await waitFor(`!!document.querySelector('[data-action=end-demo]')`);
  step("demo cannot export or restore real records into plain sample storage", await js(`document.querySelector('[data-action=export]').disabled && document.querySelector('[data-action=import]').disabled`));
  await click('[data-action=wipe]'); await waitFor(`!!document.querySelector('[data-modal-form]')`);
  await js(`document.querySelector('[data-modal-form]').requestSubmit()`); await waitFor(`!!document.querySelector('[data-form=email]')`);
  step("clearing sample data preserves the real account's sealed vault", (await sealedAOnDisk()) === beforeDemo);
  await trackApprovals();
  await js(`(() => { window.__get = navigator.credentials.get; navigator.credentials.get = async () => { throw new DOMException('Cancelled','NotAllowedError'); }; document.querySelector('[data-action=passkey] svg').dispatchEvent(new MouseEvent('click',{bubbles:true})); })()`);
  await waitFor(`/cancelled/i.test(document.querySelector('[data-error]').textContent)`);
  step("cancelled nested-icon access retains its icon, no session or key", !(await status()).signedIn && await js(`!!document.querySelector('[data-action=passkey] svg') && !document.querySelector('[data-action=passkey]').disabled`));
  await js(`navigator.credentials.get=window.__get`); await click('[data-action=passkey]'); await waitFor(hasApp);
  step("passkey sign-in opens existing records with exactly one approval, not a second lock", await js(`window.__approvals===1`) && (await status()).deviceVerified);
  step("returning records are still A's", await js(`import('./js/lib/store.js').then(({store}) => store.one('profile').name==='Account A' && store.all('accounts')[0].name==='A_PRIVATE_CASH')`));

  await signOut(); await email("a@example.com"); await waitFor(`!!document.querySelector('.gate-mark')`);
  step("email alone does not decrypt records or approve server access", !(await status()).deviceVerified && await js(`import('./js/lib/vault.js').then(v => !v.isUnlocked())`));
  await trackApprovals(); await click('[data-action=passkey]'); await waitFor(hasApp);
  step("email plus enrolled-device approval opens records without a Hodos passphrase", await js(`window.__approvals===1`) && (await status()).deviceVerified);
  await signOut(); await email("b@example.com", "signup"); await enroll("Account B"); const accountB = (await status()).account;
  step("a second account in the same browser starts empty, never opens A", accountB.id !== accountA.id && await js(`import('./js/lib/store.js').then(({store}) => store.all('accounts').length===0 && store.one('profile').name==='Account B')`));
  await js(`import('./js/lib/store.js').then(({store}) => store.insert('accounts',{name:'B_PRIVATE_CASH',type:'cash',currency:'SGD',opening_balance:{amount:20000,currency:'SGD'},opened_on:'2026-10-06'}))`);
  await signOut(); await email("a@example.com"); await waitFor(`!!document.querySelector('.gate-mark')`); await click('[data-action=passkey]'); await waitFor(hasApp);
  step("switching back shows A only and preserves B's separate encrypted vault", await js(`Promise.all([import('./js/lib/store.js'), import('./js/lib/vault.js')]).then(([s,v]) => s.store.all('accounts').map(a=>a.name).join()==='A_PRIVATE_CASH' && s.store.one('profile').user_id===${JSON.stringify(accountA.id)})`));

  await js(`window.dispatchEvent(new StorageEvent('storage',{key:'hodos.access-change',newValue:JSON.stringify({accountId:${JSON.stringify(accountB.id)},nonce:'other-tab-test'})}))`);
  await waitFor(`!!document.querySelector('.gate-mark')`);
  step("another tab's account-change signal closes this tab's key and readable records", await js(`Promise.all([import('./js/lib/vault.js'),import('./js/lib/store.js')]).then(([v,s])=>!v.isUnlocked()&&s.store.all('accounts').length===0)`));
  await click('[data-action=passkey]'); await waitFor(hasApp);

  // Current temporary recovery words still open an existing local copy; no cloud restore promise.
  await click('#lock-btn'); await waitFor(`!!document.querySelector('.gate-mark')`);
  await js(`(() => { document.querySelector('.gate-recover').open=true; const f=document.querySelector('[data-form=words]'); f.words.value=${JSON.stringify(wordsA.join(' '))}; f.requestSubmit(); })()`); await waitFor(hasApp);
  step("temporary recovery words open only the records already present here");
  await js(`(() => { window.__realNow=Date.now; Date.now=()=>window.__realNow()+6*60*1000; })()`); await waitFor(`!!document.querySelector('.gate-mark')`, 25000); await js(`Date.now=window.__realNow`);
  step("idle timeout still locks and empties readable memory", await js(`import('./js/lib/store.js').then(({store})=>store.all('profile').length===0)`));
  await click('[data-action=passkey]'); await waitFor(hasApp);
  await js(`(() => { let vis='hidden'; Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>vis}); document.dispatchEvent(new Event('visibilitychange')); window.__visible=()=>{vis='visible';document.dispatchEvent(new Event('visibilitychange'));}; })()`);
  step("background screen is veiled", await js(`document.body.classList.contains('veiled')`));
  await js(`(() => { Date.now=()=>window.__realNow()+6*60*1000; window.__visible(); Date.now=window.__realNow; })()`); await waitFor(`!!document.querySelector('.gate-mark')`);
  step("long background interval returns locked"); await click('[data-action=passkey]'); await waitFor(hasApp);

  // An actual non-PRF virtual credential must fail locally before server enrollment/vault creation.
  await signOut(); await email("c@example.com", "signup"); await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await js(`(() => { const f=document.querySelector('[data-form=profile-create]'); f.name.value='Unsupported C'; f.requestSubmit(); })()`); await waitFor(`!!document.querySelector('[data-action=passkey]')`);
  await cmd('WebAuthn.removeVirtualAuthenticator',{authenticatorId}); await addAuthenticator(false);
  await click('[data-action=passkey]'); await waitFor(`/cannot unlock encrypted records/.test(document.querySelector('[data-error]').textContent)`);
  step("ordinary passkey without PRF fails clearly, creates no vault or server credential", (await status()).account.passkeys===0 && !(await status()).deviceVerified && await js(`import('./js/lib/vault.js').then(v=>v.status()).then(s=>!s.exists)`));
  await shot("2-unsupported");
  const bad = B.problems().filter(l => !/status of 4\d\d/.test(l)); step(bad.length ? bad.join('\n') : 'no browser exceptions or blocked content', !bad.length);
} catch (e) { failures++; console.log('✗ FAIL (threw)', e.message); try { await shot('failed'); } catch {} }
console.log(`Screenshots: ${B.shots}`); B.close(); srv.stop();
console.log(failures ? `${failures} failed` : 'ALL PASS'); process.exit(failures ? 1 : 0);

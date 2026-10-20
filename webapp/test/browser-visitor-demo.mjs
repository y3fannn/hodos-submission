// Visitor-only demo policy. Fake mail/identity; no real accounts, secrets or money data.
import assert from "node:assert/strict";
import { startServer, startChrome, sleep } from "./browser-kit.mjs";
const srv = await startServer({ AUTH_RESEND_SECONDS: "1" });
const B = await startChrome();
let checks = 0;
const ok = (v,n) => { assert.ok(v,n); checks++; console.log("PASS",n); };
const click = (s) => B.js(`document.querySelector(${JSON.stringify(s)}).click()`);
const h1 = (s) => B.waitFor(`document.querySelector('.auth-card h1')?.textContent === ${JSON.stringify(s)}`);
try {
  await B.cmd("Page.navigate", {url:srv.url+"?demo=1#/home"});
  await B.waitFor(`!!document.querySelector('.demo-banner')`);
  await sleep(400);
  ok(await B.js(`!!localStorage.getItem('pfa.demo')`), "anonymous query entry opens isolated demo");
  await click('[data-end-demo]');
  await h1('Create an account');
  ok(await B.js(`location.hash === '#/signup' && !localStorage.getItem('pfa.demo') && !document.querySelector('[data-modal-form]')`), "banner Start your own goes directly to signup, discarding only samples");
  await click('[data-action=demo]');
  await B.waitFor(`!!document.querySelector('.demo-banner')`);
  await B.js(`location.hash = '#/settings'`);
  await B.waitFor(`!!document.querySelector('[data-action=end-demo]')`);
  ok(await B.js(`!document.querySelector('[data-action=seed]')`), "no Settings action can seed sample records into real data");
  await click('[data-action=end-demo]');
  await h1('Create an account');
  const exitState = await B.js(`({hash:location.hash, modal:!!document.querySelector('[data-modal-form]'), heading:document.querySelector('.auth-card h1')?.textContent})`);
  ok(exitState.hash === '#/signup' && !exitState.modal, "Settings Start your own goes directly to signup");

  // Sign up from the actual running demo, rather than stopping it before identity verification.
  await click('[data-action=demo]');
  await B.waitFor(`!!document.querySelector('.demo-banner')`);
  await B.js(`location.hash = '#/signup'`);
  await h1('Create an account');
  await B.js(`(() => { const f = document.querySelector('[data-form=email]'); f.email.value='visitor@example.com'; f.requestSubmit(); })()`);
  await h1('Check your email');
  const code = [...srv.out().matchAll(/code is (\d{6})/g)].at(-1)[1];
  await B.js(`(() => { const f=document.querySelector('[data-form=code]'); f.code.value=${JSON.stringify(code)}; f.requestSubmit(); })()`);
  await B.waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await sleep(500);
  ok(await B.js(`!localStorage.getItem('pfa.demo') && !document.querySelector('.demo-banner') && !document.querySelector('[data-action=demo]')`), "verified signup removes samples and every demo affordance");
  ok(await B.js(`import('./js/lib/store.js').then(({store}) => ['accounts','transactions','goals','debts'].every(t => store.all(t).length === 0))`), "new account starts without demo financial records");

  for (const route of ['#/demo','#/signin','#/signup']) {
    await B.js(`location.hash=${JSON.stringify(route)}`);
    await sleep(250);
    ok(await B.js(`!document.querySelector('.demo-banner') && !document.querySelector('[data-action=demo]') && !localStorage.getItem('pfa.demo')`), `authenticated ${route} cannot enter/offer demo`);
  }
  await B.js(`import('./js/lib/session.js').then(({session}) => session.startDemo())`);
  ok(await B.js(`!document.querySelector('.demo-banner') && !localStorage.getItem('pfa.demo')`), "controller also rejects authenticated demo entry");

  // A saved fake record from an earlier visit must be ignored/removed on an ordinary authenticated reload.
  await B.js(`localStorage.setItem('pfa.demo',JSON.stringify({schema_version:1,tables:{profile:[{id:'fake',name:'STALE_SAMPLE_MARKER',base_currency:'SGD',timezone:'UTC',consent:{ai_provider:false}}]}}))`);
  await B.js(`window.__visitorDemoBeforeReload = true`);
  await B.cmd('Page.reload',{ignoreCache:true});
  await B.waitFor(`!window.__visitorDemoBeforeReload && !!document.querySelector('[data-form=profile-create]')`);
  ok(await B.js(`!localStorage.getItem('pfa.demo') && !document.body.innerText.includes('STALE_SAMPLE_MARKER') && !document.querySelector('[data-action=demo]')`), "authenticated reload discards saved samples without requiring a Google marker");

  await B.js(`import('./js/lib/account.js').then(a => a.signOut()).then(() => location.hash='#/signin')`);
  await h1('Sign in');
  ok(await B.js(`!!document.querySelector('[data-action=demo]')`), "a registered but signed-out person can try demo again");
  await click('[data-action=demo]');
  await B.waitFor(`!!document.querySelector('.demo-banner')`);
  await B.js(`location.hash='#/signin'`);
  await h1('Sign in');
  await sleep(1100);
  await B.js(`(() => { const f=document.querySelector('[data-form=email]'); f.email.value='visitor@example.com'; f.requestSubmit(); })()`);
  await h1('Check your email');
  const returning = [...srv.out().matchAll(/code is (\d{6})/g)].at(-1)[1];
  await B.js(`(() => { const f=document.querySelector('[data-form=code]'); f.code.value=${JSON.stringify(returning)}; f.requestSubmit(); })()`);
  await B.waitFor(`!!document.querySelector('[data-form=profile-create]')`);
  await sleep(500);
  ok(await B.js(`!localStorage.getItem('pfa.demo') && !document.querySelector('.demo-banner') && !document.querySelector('[data-action=demo]')`), "returning Sign in also clears samples and delayed writes");
  ok(B.problems().filter(l=>!l.includes('status of 4')).length===0,"no unexpected browser errors");
  console.log(`${checks} visitor-demo checks passed`);
} finally { B.close(); srv.stop(); }

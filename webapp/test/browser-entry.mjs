// Late mail replies must not replace a new entry after Sign in → Create account → Sign in.
// Local stand-ins only: no real Google, mail, credentials or financial records.
import assert from "node:assert/strict";
import { startServer, startChrome, sleep } from "./browser-kit.mjs";
const srv = await startServer({ GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GOOGLE_AUTH_URL: "https://google.test/auth" });
const B = await startChrome({ width: 360, height: 900 });
let checks = 0;
const ok = (condition, name) => { assert.ok(condition, name); checks++; console.log("PASS", name); };
try {
  await B.cmd("Page.navigate", { url: srv.url + "#/signin" });
  await B.waitFor(`!!document.querySelector('[data-form=email]')`);
  for (const theme of ["light", "dark"]) {
    await B.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    for (const route of ["signin", "signup"]) {
      await B.js(`location.hash = '#/${route}'`);
      await B.waitFor(`document.querySelector('.auth-card h1')?.textContent === '${route === "signup" ? "Create an account" : "Sign in"}'`);
      await B.js(`document.fonts.ready`);
      ok(await B.js(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.auth-entry img')].every(i => i.complete && i.naturalWidth > 0)`), `${route}/${theme}: 360px layout and local logos`);
      ok(await B.js(`!!document.querySelector('[data-action=demo]') && document.querySelector('[data-action=google]').origin === location.origin`), `${route}/${theme}: demo and same-app Google entry`);
      await B.shot(`${route}-${theme}-360`);
    }
  }
  await B.js(`document.querySelector('a[href="#/signin"]').click()`);
  await B.waitFor(`document.querySelector('.auth-card h1')?.textContent === 'Sign in'`);
  await B.js(`window.__originalFetch = window.fetch.bind(window); window.fetch = (u,o) => String(u).includes('/api/auth/email/start') ? new Promise(resolve => { window.__release = resolve; }) : window.__originalFetch(u,o)`);
  for (const failure of [false, true]) {
    await B.js(`(() => { const f = document.querySelector('[data-form=email]'); f.email.value = 'old@example.com'; f.requestSubmit(); })()`);
    await B.waitFor(`typeof window.__release === 'function'`);
    await B.js(`document.querySelector('a[href="#/signup"]').click()`);
    await B.waitFor(`document.querySelector('.auth-card h1')?.textContent === 'Create an account'`);
    await B.js(`document.querySelector('[data-form=email]').email.value = 'new@example.com'; document.querySelector('a[href="#/signin"]').click()`);
    await B.waitFor(`document.querySelector('.auth-card h1')?.textContent === 'Sign in'`);
    await B.js(`window.__release(new Response(JSON.stringify(${failure ? "{code:'SLOW_DOWN',message:'Old request error'}" : "{ok:true}"}), {status:${failure ? 429 : 200},headers:{'Content-Type':'application/json'}})); delete window.__release`);
    await sleep(150);
    ok(await B.js(`!!document.querySelector('[data-form=email]') && !document.querySelector('[data-form=code]') && document.querySelector('[data-form=email]').email.value === 'new@example.com' && document.querySelector('[data-error]').textContent === ''`), `late ${failure ? "failure" : "success"} cannot replace the new entry after switching away/back`);
  }
  await B.js(`window.fetch = window.__originalFetch; delete window.__originalFetch`);
  ok(B.problems().length === 0, "no browser errors or blocked local assets");
  console.log(`${checks} entry browser checks passed; screenshots: ${B.shots}`);
} finally { B.close(); srv.stop(); }
// This script is an existing CI browser gate; retain composer regression coverage there too.
await import('./assistant-composer.mjs');

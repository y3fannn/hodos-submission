// Measured shared rhythm, target sizes and page overflow; local stand-ins, no real accounts.
import assert from "node:assert/strict";
import { startServer, startChrome } from "./browser-kit.mjs";
const srv = await startServer({ GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" });
let B;
try {
  B = await startChrome({ width: 320, height: 900 });
  const { cmd, js, waitFor, shot } = B;
  await cmd("Page.navigate", { url: srv.url + "#/signin" });
  await waitFor(`!!document.querySelector('[data-form=email]')`);
  for (const width of [320, 360, 420, 1024]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    for (const theme of ["light", "dark"]) {
      await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      for (const route of ["signin", "signup"]) {
        await js(`location.hash = '#/${route}'`);
        await waitFor(`document.querySelector('.auth-card h1')?.textContent === '${route === "signup" ? "Create an account" : "Sign in"}'`);
        await js(`document.fonts.ready`);
        const m = await js(`(() => {
          const f = document.querySelector('[data-form=email]'), label = f.querySelector('label'), input = f.querySelector('input'), button = f.querySelector('button'), card = document.querySelector('.auth-card');
          const methods = [...document.querySelectorAll('.auth-card > .auth-method')];
          return { overflow: document.documentElement.scrollWidth > innerWidth,
            labelGap: input.getBoundingClientRect().top - label.getBoundingClientRect().top - parseFloat(getComputedStyle(label).lineHeight),
            buttonGap: button.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
            methodGaps: methods.slice(1).map((e,i) => e.getBoundingClientRect().top - methods[i].getBoundingClientRect().bottom),
            inputHeight: input.getBoundingClientRect().height, buttonHeight: button.getBoundingClientRect().height,
            padding: getComputedStyle(card).paddingLeft,
            loaded: [...document.querySelectorAll('.auth-entry img')].every(i => i.complete && i.naturalWidth > 0) };
        })()`);
        assert.equal(m.overflow, false, `${route}/${width}/${theme}: page overflow`);
        assert.equal(m.loaded, true);
        assert.equal(m.labelGap, 8, `${route}/${width}/${theme}: label-to-field`);
        assert.equal(m.buttonGap, 16, `${route}/${width}/${theme}: field-to-button`);
        assert.ok(m.methodGaps.every(g => g === 16), "method buttons share the control gap");
        assert.ok(m.inputHeight >= 44 && m.buttonHeight >= 44);
        assert.equal(m.padding, width <= 360 ? "16px" : "24px");
        if ([320, 420, 1024].includes(width)) await shot(`spacing-${route}-${theme}-${width}`);
      }
    }
  }
  console.log("PASS Sign in/Create account: measured 8px label gaps, 16px control gaps, shared padding and 44px targets at 320/360/420/1024px under both preferences");
  await js(`document.querySelector('[data-action=demo]').click()`);
  await waitFor(`!!document.querySelector('.home-panel') && !!localStorage.getItem('pfa.demo')`);
  const routes = ["home", "settings", "add", "transactions", "budgets", "accounts", "networth", "investments", "goals", "debts", "insurance", "briefing", "deepdive", "recurring", "categories", "alerts", "chat"];
  for (const width of [320, 360, 420, 1024]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    for (const theme of ["light", "dark"]) {
      await js(`(async () => (await import('./js/lib/theme.js')).setTheme('${theme}'))()`);
      for (const route of routes) {
        await js(`location.hash = '#/${route}'`);
        await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.equal(await js(`document.getElementById('topbar-title').textContent === 'Error'`), false, route);
        const m = await js(`(() => {
          const cards = [...document.querySelectorAll('#app > .card')];
          const fields = [...document.querySelectorAll('form label > input:not([type=checkbox]):not([type=radio]), form label > select, form label > textarea')];
          return { overflow: document.documentElement.scrollWidth > innerWidth,
            cardGaps: cards.slice(1).map((e,i) => e.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom),
            numberBoxGaps: [...document.querySelectorAll("form label + .inline")].filter(e => e.getBoundingClientRect().height).map(e => e.getBoundingClientRect().top - e.previousElementSibling.getBoundingClientRect().bottom),
            fieldMargins: fields.filter(e => e.getBoundingClientRect().height).map(e => parseFloat(getComputedStyle(e).marginTop)),
            nav: [...document.querySelectorAll('[data-tab]')].map(e => ({ width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height })) };
        })()`);
        assert.equal(m.overflow, false, `${route}/${width}/${theme}: page overflow`);
        assert.ok(m.numberBoxGaps.every(g => g === 8), `${route}: number-box label gaps`);
        assert.ok(m.fieldMargins.every(g => g === 8), `${route}: shared label gaps`);
        assert.ok(m.cardGaps.every(g => g >= 16), `${route}: separate cards have at least the shared 16px gap (${m.cardGaps})`);
        assert.equal(m.nav.length, 5);
        assert.ok(m.nav.every(r => r.width >= 44 && r.height >= 44));
        if (width === 360 && ["settings", "add", "budgets"].includes(route)) await shot(`spacing-${route}-${theme}`);
      }
    }
  }
  // Measure representative vertical form pairs and neighbouring cards, not only CSS source values.
  await js(`location.hash = '#/settings'`);
  await waitFor(`!!document.querySelector('[data-form=profile]')`);
  const gaps = await js(`(() => {
    const f = document.querySelector('[data-form=profile]'), labels = [...f.querySelectorAll(':scope > label')], actions = f.querySelector('.actions');
    return { fields: labels.slice(1).map((l,i) => l.getBoundingClientRect().top - labels[i].getBoundingClientRect().bottom),
      actions: actions.getBoundingClientRect().top - labels.at(-1).getBoundingClientRect().bottom };
  })()`);
  assert.ok(gaps.fields.every(g => g >= 16), JSON.stringify(gaps));
  assert.equal(gaps.actions, 16);
  await js(`document.querySelector('[data-action=home-panel]').click()`);
  await waitFor(`!!document.querySelector('[name=home_panel]')`);
  assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false);
  assert.equal(await js(`getComputedStyle(document.querySelector('[name=home_panel]')).marginTop`), "8px");
  await shot("spacing-home-picker");
  assert.deepEqual(B.problems(), []);
  console.log("PASS 17 app routes at 320/360/420/1024px light/dark: no page overflow, shared label/card gaps, five reachable bottom targets; Settings form and picker measured");
  console.log(`Screenshots: ${B.shots}`);
} finally { B?.close(); srv.stop(); }

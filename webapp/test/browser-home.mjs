// Fixed Home in real Chrome: panels, phone layouts, consent, navigation and local persistence.
// Starts an isolated accounts-off server; uses only fake demo records, never a live account.
import assert from "node:assert/strict";
import { startServer, startChrome, sleep } from "./browser-kit.mjs";

const srv = await startServer({ AUTH: "off" });
let B;
try {
  B = await startChrome({ width: 360, height: 900 });
  const { cmd, js, waitFor, shot } = B;
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.homeAiCalls = 0;
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      const url = String(args[0]?.url || args[0]).split(/[?#]/)[0];
      if (url.endsWith('/api/ai')) window.homeAiCalls++; // not the app's startup /api/ai/status probe
      return originalFetch(...args);
    };
  ` });
  await cmd("Page.navigate", { url: srv.url + "?demo=1#/home" });
  await waitFor(`!!document.querySelector('.home-panel') && !!localStorage.getItem('pfa.demo')`);
  const home = async () => {
    await js(`location.hash = '#/home'`);
    await waitFor(`!!document.querySelector('.home-panel')`);
  };
  const settings = async () => {
    await js(`document.querySelector('[data-tab=settings]').click()`);
    await waitFor(`!!document.querySelector('[data-action=home-panel]')`);
  };
  const picker = async () => {
    await settings();
    await js(`document.querySelector('[data-action=home-panel]').click()`);
    await waitFor(`!!document.querySelector('[name=home_panel]')`);
    assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false, "picker has no page overflow");
  };
  const choose = async (key) => {
    await picker();
    await js(`(() => { const s = document.querySelector('[name=home_panel]'); s.value = ${JSON.stringify(key)}; s.form.requestSubmit(); })()`);
    await waitFor(`!document.querySelector('[name=home_panel]')`); // Normal successful close follows durable storage, not early test navigation.
    await home();
    await waitFor(`document.querySelector('.home-panel')?.dataset.wid === ${JSON.stringify('widget:' + key)}`);
  };
  const icons = await js(`[...document.querySelectorAll('.shortcut')].map(a => ({ key: a.dataset.wid, href: a.getAttribute('href') }))`);
  assert.equal(icons.length, 11);
  assert.equal(new Set(icons.map(i => i.key)).size, 11);
  assert.equal(await js(`document.querySelectorAll('.shortcut .sc-ic svg').length`), 11, "every function uses a drawn icon, never a missing font glyph");
  assert.deepEqual(icons.map(i => i.key), ['budgets', 'accounts', 'networth', 'investments', 'goals', 'debts', 'insurance', 'briefing', 'recurring', 'categories', 'alerts'].map(k => 'shortcut:' + k));
  assert.equal(icons.some(i => i.href === '#/deepdive'), false, "Home has no Deep dive entry point");
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-tab]')].map(a => a.dataset.tab)`), ['home', 'transactions', 'chat', 'add', 'settings']);
  assert.equal(await js(`!!document.querySelector('[name=home_panel]') || document.body.innerText.includes('Top panel')`), false);
  await picker();
  const keys = await js(`[...document.querySelector('[name=home_panel]').options].map(o => o.value)`);
  assert.equal(keys.length, 6);
  assert.equal(keys.some(k => ['assistant', 'briefing', 'spend_breakdown'].includes(k)), false);
  await js(`document.querySelector("[data-action=modal-cancel]").click()`);
  await home();
  // The chooser helper must follow the real successful path, not navigate during Saving.
  await js(`(async () => {
    const {store,DEMO_KEY}=await import('./js/lib/store.js');await store.retryPending();
    const snapshot=store.snapshot();let held=false;
    store.open(snapshot,async captured=>{
      if(!held){held=true;await new Promise(resolve=>window.releaseHomeChoice=resolve);}
      localStorage.setItem(DEMO_KEY,JSON.stringify(captured));
    },'home-choice-save-test');
  })()`);
  let choiceFinished = false;
  const heldChoice = choose('net_worth').then(() => { choiceFinished = true; });
  try {
    await waitFor(`!!window.releaseHomeChoice`);
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await js(`location.hash`), '#/settings', 'chooser test must not leave Settings before its confirmed save finishes');
    assert.equal(await js(`!!document.querySelector('[name=home_panel]')`), true, 'Saving remains in the original chooser until storage confirms');
    assert.equal(choiceFinished, false, 'chooser helper does not resolve before durability');
  } finally {
    await js(`window.releaseHomeChoice?.()`);
    await heldChoice;
  }
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.home_layout[0].panel_key`), 'net_worth');
  console.log('PASS chooser test waits for durable completion before Home/chart assertions');
  // Include an actual stored Briefing, rather than only its empty state.
  await js(`(async () => {
    const { store } = await import('./js/lib/store.js'), B = await import('./js/features/budgets.js');
    const receipt = store.captureAction('saved-briefing-fixture', () => store.insert('briefings', {
      period: {kind:'month', ...B.prevMonth(B.month())}, stats:{currency:'SGD', incomplete_reasons:[]},
      summary:'Saved briefing must remain intact while paused.', options:[], levers:[], overlaps:[], read_at:null,
    }));
    await store.commit(receipt);
  })()`);
  for (const width of [320, 360, 420, 1024]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    for (const theme of ["light", "dark"]) {
      await js(`(async () => (await import('./js/lib/theme.js')).setTheme(${JSON.stringify(theme)}))()`);
      for (const key of keys) {
        await choose(key);
        const metrics = await js(`(() => {
          const p = document.querySelector('.home-panel'), g = document.querySelector('.home-grid'), r = p.getBoundingClientRect();
          const icons = [...g.querySelectorAll('.shortcut')];
          return { columns: getComputedStyle(g).gridTemplateColumns.split(' ').length, height: r.height,
            overflow: document.documentElement.scrollWidth > innerWidth,
            clipped: p.scrollHeight > p.clientHeight + 1,
            barValuesClipped: [...p.querySelectorAll('.rbar-v')].filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().bottom > r.bottom - parseFloat(getComputedStyle(p).paddingBottom) + 1).map(e => e.textContent),
            labelsClipped: icons.filter(a => { const t = a.querySelector('.sc-t'); return t.scrollWidth > t.clientWidth + 1; }).map(a => a.dataset.wid),
            below: icons.every(a => a.getBoundingClientRect().top >= r.bottom),
            order: icons.map(a => a.dataset.wid), focus: document.activeElement?.name };
        })()`);
        assert.equal(metrics.columns, 4);
        assert.equal(metrics.overflow, false, `${key}/${width}/${theme}: horizontal overflow`);
        assert.deepEqual(metrics.labelsClipped, [], `${key}/${width}/${theme}: clipped labels`);
        assert.equal(metrics.below, true, `${key}: icons follow panel`);
        assert.equal(metrics.height, 218);
        assert.equal(metrics.clipped, false, `${key}/${width}/${theme}: normal panel content should fit`);
        assert.deepEqual(metrics.barValuesClipped, [], `${key}/${width}/${theme}: every ranked amount remains visible`);
        assert.deepEqual(metrics.order, icons.map(i => i.key));
        assert.equal(await js(`!!document.querySelector('[name=home_panel]')`), false, "Home never shows a persistent selector");
        if (width === 360) await shot(`home-${key}-${theme}`);
        else if (["budget", "assistant"].includes(key)) await shot(`home-${key}-${theme}-${width}`);
      }
    }
  }
  console.log("PASS all six available panels at 320/360/420/1024px, light/dark; fixed icons, readable content, Settings selection");

  await choose("net_worth");
  await js(`(() => { const hit = document.querySelector('.home-panel svg [data-i]'); hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 250 })); hit.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  assert.equal(await js(`location.hash`), "#/home");
  assert.equal(await js(`document.querySelector('.home-panel .viz-tip').hidden`), true);
  await js(`document.querySelector('.home-panel svg [data-i]').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,isPrimary:true,pointerId:9,button:0,clientX:160,clientY:250}))`);
  await sleep(650);
  assert.equal(await js(`!!document.querySelector('[name=home_panel]')`), false, 'a graph hold cannot start the panel picker');
  await js(`window.dispatchEvent(new PointerEvent('pointerup',{pointerId:9}))`);
  console.log("PASS chart inspection stays off and graph holds cannot open the picker or navigate");
  // Native links work independently of pointer-only handlers: activate a focused title by keyboard.
  await js(`document.querySelector('.home-panel .w-title').focus()`);
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(`location.hash === '#/networth' && !document.querySelector('.home-panel')`);
  await home();
  for (const i of icons) {
    await js(`document.querySelector('[data-wid=${JSON.stringify(i.key)}]').click()`);
    await waitFor(`location.hash === ${JSON.stringify(i.href)} && !document.querySelector('.home-panel')`);
    assert.notEqual(await js(`document.getElementById('topbar-title').textContent`), "Error", `icon ${i.key}: ${await js('document.getElementById("app").innerText')}`);
    await home();
  }
  console.log("PASS panel keyboard link and every function icon open their screens");

  await choose("goals");
  await waitFor(`JSON.parse(localStorage.getItem('pfa.demo')).tables.home_layout[0]?.panel_key === 'goals'`);
  await cmd("Page.reload");
  await waitFor(`document.querySelector('.home-panel')?.dataset.wid === 'widget:goals'`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.shortcut')].map(a => a.dataset.wid)`), icons.map(i => i.key));
  console.log("PASS selected panel and fixed icon order survive browser reload");

  // Preserve an existing paused choice without permitting a new one.
  await js(`(async () => { const { store } = await import('./js/lib/store.js'); const { profile } = await import('./js/features/profile.js'); const p = profile(); await store.commit(store.captureAction('paused-choice-fixture', () => {store.upsertOne('home_layout',{panel_key:'assistant'});store.update('profile', p.id, { consent: { ...p.consent, ai_provider: false } });})); })()`);
  await waitFor(`document.querySelector('.home-panel')?.dataset.wid === 'widget:budget'`);
  assert.equal(await js(`!!document.querySelector('[data-wid="shortcut:assistant"], [data-tab=chat]')`), false);
  assert.equal(await js(`!!document.querySelector('[data-tab=budgets]')`), true);
  await picker();
  assert.equal(await js(`!!document.querySelector('[name=home_panel] option[value=assistant]')`), false);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  assert.equal(await js(`document.querySelector('#ai-consent').checked`), false);
  assert.equal(await js(`document.body.innerText.includes('Every screen')`), false);
  await js(`location.hash = '#/chat'`);
  await waitFor(`!!document.querySelector('[data-assistant-blocked]')`);
  assert.equal(await js(`!!document.querySelector('[data-chat-form]')`),false,'permission off blocks the Assistant page');
  assert.equal(await js(`document.querySelector('[data-assistant-blocked] a').getAttribute('href')`),'#/settings?enable-ai=1');
  assert.equal(await js(`(async()=>{const {store}=await import('./js/lib/store.js'),AS=await import('./js/features/assistant.js');const before=store.exportJson();const results=[await AS.send('Do not send while disabled'),AS.performAction({kind:'snapshot_now',params:{}})];return results.every(x=>x===false)&&store.exportJson()===before;})()`),true,'permission off blocks Assistant functions without saving or sending');
  await js(`document.querySelector('[data-assistant-blocked] a').click()`);
  await waitFor(`document.activeElement?.id === 'ai-consent'`);
  assert.equal(await js(`document.body.innerText.includes('tick Allow AI help below, then Save')`), true);
  await shot("enable-ai-setting");
  await js(`document.querySelector('#ai-consent').checked = true; document.querySelector('[data-form=profile]').requestSubmit()`);
  await js(`import('./js/lib/store.js').then(({store})=>store.retryPending())`);
  await home();
  assert.equal(await js(`document.querySelector('.home-panel').dataset.wid`), "widget:budget");
  assert.equal(await js(`!!document.querySelector('[data-tab=chat]')`), true);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.home_layout[0].panel_key`), 'assistant');
  assert.equal(await js(`!!document.querySelector('[data-ask]')`), false);
  console.log("PASS saved AI consent enables Assistant tab, not its removed Home widget");

  await js(`location.hash='#/chat?q=What%20is%20my%20net%20worth%3F'`);
  await waitFor(`document.querySelector('#topbar-title')?.textContent==='Assistant' && location.hash==='#/chat'`);
  assert.equal(await js(`import('./js/lib/ai.js').then(ai=>!!document.querySelector('[data-chat-form]')===ai.enabled())`),true,'composer follows actual server availability, not permission alone');
  assert.equal(await js(`!!document.querySelector('[data-feature-paused=assistant]')`), false);
  await home();
  assert.equal(await js(`document.querySelectorAll('[data-action=edit], [data-remove], [data-size], .editing').length`), 0);
  assert.equal(await js(`window.homeAiCalls`), 0);
  console.log("PASS old Assistant question links open chat, clear the query and never automatically call AI");

  // Real mouse clicks and holds: do not steal title/blank taps, scrolling or the next click.
  await choose("budget");
  await js(`window.scrollTo(0, 0)`); await sleep(100);
  const point = await js(`(() => { const r = document.querySelector('.home-panel').getBoundingClientRect(); return {x:r.right - 20,y:r.bottom - 20}; })()`);
  const down = () => cmd("Input.dispatchMouseEvent", {type:"mousePressed",button:"left",clickCount:1,...point});
  const up = () => cmd("Input.dispatchMouseEvent", {type:"mouseReleased",button:"left",clickCount:1,...point});
  // Deterministically acknowledge a prior write mid-hold; redraw must not cancel the gesture.
  await js(`(async()=>{const {store,DEMO_KEY}=await import('./js/lib/store.js');await store.retryPending();let held=false;store.open(store.snapshot(),async captured=>{if(!held){held=true;await new Promise(resolve=>window.releaseHomeHoldWrite=resolve);}localStorage.setItem(DEMO_KEY,JSON.stringify(captured));});window.homeHoldSave=store.commit(store.captureAction('home-hold-fixture',()=>store.upsertOne('home_layout',{panel_key:'budget'})));window.homeHoldSave.catch(()=>{});})()`);
  await waitFor(`!!window.releaseHomeHoldWrite`);
  await down(); await sleep(100);
  await js(`window.releaseHomeHoldWrite();window.homeHoldSave`);
  await sleep(550);
  await waitFor(`!!document.querySelector('[name=home_panel]')`);
  await up();
  assert.equal(await js(`location.hash`), "#/home", "hold release does not follow panel link");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  await down(); await up();
  await waitFor(`location.hash === '#/budgets'`);
  await home();
  const noPicker = async (label) => {
    await sleep(700);
    assert.equal(await js(`!!document.querySelector('[name=home_panel]')`), false, label);
  };
  await down();
  await cmd("Input.dispatchMouseEvent", {type:"mouseMoved",buttons:1,x:point.x,y:point.y + 20});
  await noPicker("movement cancels the hold"); await up(); await home();
  await js(`document.querySelector('.home-panel').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,isPrimary:true,pointerId:7,button:0,clientX:100,clientY:200})); window.dispatchEvent(new PointerEvent('pointercancel', {pointerId:7}))`);
  await noPicker("pointer cancellation leaves no delayed picker");
  await down(); await js(`window.dispatchEvent(new Event('scroll'))`);
  await noPicker("scroll cancels pending hold"); await up(); await home();
  await down(); await settings(); await noPicker("navigation cancels pending hold"); await up(); await home();
  await down(); await js(`window.dispatchEvent(new Event('blur'))`);
  await noPicker("background cancels pending hold"); await up(); await home();
  // A real touch scroll supplies pointercancel automatically rather than relying on a mock event.
  await cmd("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[point]});
  await cmd("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x:point.x,y:point.y-60}]});
  await cmd("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
  await noPicker("touch scrolling does not open the picker");
  await js(`window.scrollTo(0, 0)`); await sleep(100);
  await cmd("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[point]});
  await sleep(650); await waitFor(`!!document.querySelector('[name=home_panel]')`);
  await cmd("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
  assert.equal(await js(`location.hash`), "#/home", "touch hold release does not navigate");
  await js(`document.querySelector('[data-action=modal-cancel]').click()`);
  await js(`window.scrollTo(0, 0)`); await sleep(100);
  await settings();
  await js(`document.querySelector('[data-action=home-panel]').focus()`);
  const key = async (key, code, n, shiftKey = false) => {
    await cmd("Input.dispatchKeyEvent", {type:"keyDown",key,code,windowsVirtualKeyCode:n,...(key === "Enter" ? {text:"\r"} : {}),modifiers:shiftKey ? 8 : 0});
    await cmd("Input.dispatchKeyEvent", {type:"keyUp",key,code,windowsVirtualKeyCode:n});
  };
  await key("Enter", "Enter", 13); await waitFor(`document.activeElement?.name === 'home_panel'`);
  await key("Tab", "Tab", 9, true);
  assert.equal(await js(`document.activeElement?.type`), "submit", "Shift-Tab remains in picker");
  await key("Tab", "Tab", 9);
  assert.equal(await js(`document.activeElement?.name`), "home_panel", "Tab wraps to selector");
  await key("ArrowDown", "ArrowDown", 40);
  const keyboardChoice = await js(`document.activeElement.value`);
  await key("Tab", "Tab", 9); await key("Tab", "Tab", 9); await key("Enter", "Enter", 13);
  await waitFor(`!document.querySelector('[name=home_panel]')`);
  assert.equal(await js(`document.activeElement?.dataset.action`), "home-panel", "Save restores focus to the redrawn Settings control");
  await home();
  assert.equal(await js(`document.querySelector('.home-panel').dataset.wid`), "widget:" + keyboardChoice);
  await picker(); await sleep(50); await key("Escape", "Escape", 27);
  assert.equal(await js(`document.activeElement?.dataset.action`), "home-panel", "Escape restores Settings button focus");
  await home();
  console.log("PASS completed hold, next tap, movement/cancel/scroll/navigation/background, real touch scroll and keyboard Settings choice");

  // Keep a thin/empty panel selectable, and check choices follow the store rather than module state.
  await js(`(async () => {
    const { store } = await import('./js/lib/store.js'), W = await import('./js/features/widgets.js'), P = await import('./js/features/profile.js');
    window.originalHomeStore = store.snapshot();
    store.open(null, async captured => localStorage.setItem('pfa.demo', JSON.stringify(captured)), 'home-test-empty');
    P.createProfile({ base_currency: 'SGD', timezone: 'UTC', self_description: 'working', ai_provider: true }); W.selectPanel('goals');
  })()`);
  await picker();
  assert.equal(await js(`document.querySelector('[name=home_panel]').options.length`), 6);
  await js(`document.querySelector('[data-action=modal-cancel]').click()`); await home();
  assert.equal(await js(`document.querySelector('.home-panel .w-absent').textContent.includes('no goals set')`), true);
  for (const key of keys) await choose(key);
  assert.equal(await js(`JSON.parse(localStorage.getItem('pfa.demo')).tables.home_layout[0]?.panel_key`), keys.at(-1), 'empty-data chooser also reaches disposable demo storage before completion');
  await js(`(async () => {
    const { store } = await import('./js/lib/store.js'), W = await import('./js/features/widgets.js'), P = await import('./js/features/profile.js');
    store.open(null, null, 'home-owner-a'); P.createProfile({ base_currency: 'SGD', timezone: 'UTC', self_description: 'working' }); W.selectPanel('goals'); window.homeOwnerA = store.snapshot();
    store.open(null, null, 'home-owner-b'); P.createProfile({ base_currency: 'SGD', timezone: 'UTC', self_description: 'working' }); W.selectPanel('net_worth'); window.homeOwnerB = store.snapshot();
    store.open(window.homeOwnerA, null, 'home-owner-a');
  })()`);
  assert.equal(await js(`document.querySelector('.home-panel').dataset.wid`), "widget:goals");
  assert.equal(await js(`window.homeOwnerB.tables.home_layout[0].panel_key`), "net_worth");
  await js(`(async () => { const { store } = await import('./js/lib/store.js'); store.open(window.homeOwnerB, null, 'home-owner-b'); })()`);
  assert.equal(await js(`document.querySelector('.home-panel').dataset.wid`), "widget:net_worth");
  console.log("PASS empty panels remain 4x2 and selectable; account-owned stores retain separate choices (not physical login proof)");
  assert.deepEqual(B.problems(), []);
  console.log(`Screenshots: ${B.shots}`);
} finally {
  B?.close(); srv.stop();
}

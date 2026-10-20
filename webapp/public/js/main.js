// App shell: router, app-open hooks, after-write hooks, re-render on change.
import { store, LEGACY_KEY, DEMO_KEY, requestPersistence } from "./lib/store.js";
import * as vault from "./lib/vault.js";
import * as account from "./lib/account.js";
import { session } from "./lib/session.js";
import { disposeAllOperations } from "./lib/operations.js";
import { setupPage, recoveryPage, lockPage } from "./features/lock.js";
import { signinPage } from "./features/signin.js";
import { seedDemoSteps } from "./features/seed.js";
import { runDemoSteps, beginDemoTransition } from "./lib/demo-loading.js";
import { toast, cancelModal } from "./lib/ui.js";
import { captureInstallPrompt } from "./features/install.js";
import * as ai from "./lib/ai.js";
import * as bus from "./lib/bus.js";
import * as theme from "./lib/theme.js";
import { esc } from "./lib/ui.js";
import { icon } from "./lib/icons.js";
import { profile, onboardingPage, settingsPage, createProfile, DEMO_PROFILE } from "./features/profile.js";
import { alertsPage, unread } from "./features/alerts.js";
import { categoriesPage, checkUnlock } from "./features/categories.js";
import { accountsPage, accountDetailPage, active as activeAccounts } from "./features/accounts.js";
import { statementPage } from "./features/reconcile.js";
import { transactionsPage, transactionDetailPage, addPage, recurringPage, postDue, checkRecurring, clearRecordsView } from "./features/transactions.js";
import { budgetsPage, checkThresholds, migrate as migrateBudgets } from "./features/budgets.js";
import { netWorthPage, netWorthPartPage, monthlyDue } from "./features/networth.js";
import { briefingPage, deepDivePage, briefingDue } from "./features/insights.js";
import { homePage } from "./features/widgets.js";
import { goalsPage, checkAll as checkGoals } from "./features/goals.js";
import { debtsPage, debtDetailPage, checkAlerts as checkDebts } from "./features/debts.js";
import { insurancePage, checkRenewals } from "./features/insurance.js";
import { investmentsPage, investmentDetailPage } from "./features/investments.js";
import { chatPage, clearPendingSend } from "./features/assistant.js";
import { featurePaused } from "./lib/feature-policy.js";

const ROUTES = [
  ["home", () => homePage()], ["transactions", (p) => transactionsPage(p.query)], ["transactions/:id", (p) => transactionDetailPage(p.id)],
  ["add", () => addPage()], ["budgets", () => budgetsPage()], ["accounts", () => accountsPage()], ["accounts/:id", (p) => accountDetailPage(p.id)], ["accounts/:id/match", (p) => statementPage(p.id)],
  ["categories", () => categoriesPage()], ["recurring", () => recurringPage()], ["networth", () => netWorthPage()], ["networth/:part", (p) => netWorthPartPage(p.part)], ["goals", () => goalsPage()],
  ["debts", () => debtsPage()], ["debts/:id", (p) => debtDetailPage(p.id)], ["insurance", () => insurancePage()], ["investments", () => investmentsPage()], ["investments/:id", (p) => investmentDetailPage(p.id)],
  ["briefing", () => briefingPage()], ["briefing/:id", (p) => briefingPage(p.id)], ["deepdive", () => deepDivePage()], ["chat", (p) => chatPage(p.query)], ["alerts", () => alertsPage()], ["settings", () => settingsPage()],
  ["signin", (p) => signinPage({ query: p.query, intent: "signin", onSignedIn: (r) => afterAccountEntry(r) })],
  ["signup", (p) => signinPage({ query: p.query, intent: "signup", onSignedIn: (r) => afterAccountEntry(r) })],
];
// Where Back goes when there is no earlier screen in this visit to return to, say after opening a
// link or a reload: the screen this one sits under. Everything else sits under Home.
const PARENT = {
  "transactions/:id": "#/transactions", "accounts/:id": "#/accounts", "accounts/:id/match": "#/accounts", "networth/:part": "#/networth", "debts/:id": "#/debts",
  "investments/:id": "#/investments", "briefing/:id": "#/briefing", deepdive: "#/briefing",
  recurring: "#/settings", categories: "#/settings", signin: "#/settings", signup: "#/settings",
};
// Five slots is the most a phone bar carries. The Assistant holds one whenever consent allows it,
// and Budgets takes that slot when it does not, so the bar is never four items wide.
// Every other feature is reached from the home screen, which the user arranges, or from Settings.
function tabs() {
  const assistant = !featurePaused("assistant") && ai.consented();
  const list = [
    { hash: "#/home", icon: icon("home"), label: "Home", key: "home" },
    { hash: "#/transactions", icon: icon("records"), label: "Records", key: "transactions" },
    { hash: "#/add", icon: icon("add", { size: assistant ? 22 : 26 }), label: "Add", key: "add", cls: assistant ? "" : "tab-primary" },
    assistant ? { hash: "#/chat", icon: icon("assistant", { size: 26 }), label: "Assistant", key: "chat", cls: "tab-primary" } : { hash: "#/budgets", icon: icon("budgets"), label: "Budgets", key: "budgets" },
    { hash: "#/settings", icon: icon("settings"), label: "Settings", key: "settings" },
  ];
  if (assistant) [list[2], list[3]] = [list[3], list[2]];
  return list;
}
// The screens Settings keeps under its own roof light that tab up; a feature opened from the
// home screen lights nothing, because it is not a tab and pretending otherwise would be a lie.
const UNDER_SETTINGS = new Set(["settings", "recurring", "categories", "alerts"]);
function renderTabs(top) {
  const list = tabs();
  const active = list.some((t) => t.key === top) ? top : UNDER_SETTINGS.has(top) ? "settings" : "";
  // pi-lens-ignore: no-inner-html-js
  document.getElementById("tabbar").innerHTML = list
    .map((t) => `<a href="${t.hash}" data-tab="${t.key}" class="${t.cls || ""} ${t.key === active ? "active" : ""}"${t.key === active ? ' aria-current="page"' : ''}><i class="tab-ic">${t.icon}</i><span>${t.label}</span></a>`)
    .join("");
}

function match(hash) {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const segs = path.split("/").filter(Boolean);
  for (const [pattern, fn] of ROUTES) {
    const ps = pattern.split("/"); if (ps.length !== segs.length) continue;
    const params = { query }; let ok = true;
    ps.forEach((p, i) => { if (p.startsWith(":")) params[p.slice(1)] = segs[i]; else if (p !== segs[i]) ok = false; });
    if (ok) return { fn, params, top: segs[0], pattern };
  }
  return { fn: () => homePage(), params: {}, top: "home", pattern: "home" };
}

// ---------- Back ----------
// Every screen that is not one of the tabs gets a Back button. It returns to the screen before, the way
// the phone's own back does; with nothing before it in this visit, it goes up to the screen above.
// The trail is only this visit's screens, in memory, and starts again after the lock.
const trail = [];
function track(hash) {
  if (trail.at(-2) === hash) trail.pop();
  else if (trail.at(-1) !== hash) trail.push(hash);
  if (trail.length > 50) trail.shift();
}
function goBack(pattern) {
  if (trail.length > 1) history.back();
  else location.hash = PARENT[pattern] || "#/home";
}

// ---------- the gate: first run, the lock, the recovery key ----------
// gate.step while setting up: profile → lock → recovery. The profile values wait in memory until the
// vault exists, so nothing is ever written unencrypted.
let gate = { step: "profile", values: null, words: null, replacing: false };
const LAST_OWNER = "hodos.last-account", ACCESS_SIGNAL = "hodos.access-change";
let lockSaveWarningOwner = null;
function signalAccess(accountId) {
  try { localStorage.setItem(ACCESS_SIGNAL, JSON.stringify({ accountId, nonce: crypto.randomUUID() })); } catch {}
}
// First run: explicit signup or existing-account sign-in → about you → lock → recovery key.
// With no sign-in server, the account step is skipped and everything stays on the device.
function gatePage() {
  const entry = match(location.hash || "#/signin");
  if (account.needed()) {
    return signinPage({ firstRun: true, query: entry.params.query, intent: entry.pattern === "signup" ? "signup" : "signin", onSignedIn: afterAccountEntry });
  }
  if (session.mode === "locked") return lockPage({ status: gate.status, onUnlocked: afterUnlock });
  if (gate.step === "recovery") return recoveryPage({ words: gate.words, replacing: gate.replacing, onConfirmed: afterRecovery });
  if (gate.step === "lock") return setupPage({ onCreated: afterCreate, onBack: () => { gate = { ...gate, step: "profile" }; render(); } });
  return onboardingPage({ values: gate.values, signedIn: account.state.signedIn, onStart: async (values) => {
    // Resume an interrupted first setup after its existing key has already been unlocked.
    if (vault.isUnlocked()) {
      try { createProfile(values); await store.retryPending(); await vault.flush(); enterApp(); }
      catch { await lockNow(); toast("Setup could not be saved. Check this browser's storage and try again."); }
      return;
    }
    gate = { ...gate, step: "lock", values }; render();
  } });
}
// A confirmed recovery key is linked to the account, so it can sign in on a new device too.
async function afterRecovery() {
  const revision = vault.accessRevision();
  await account.linkRecovery(gate.words);
  if (revision !== vault.accessRevision() || !vault.isUnlocked()) return;
  await vault.confirmRecovery();
  if (revision === vault.accessRevision() && vault.isUnlocked()) enterApp();
}
async function afterCreate(words) {
  disposePrivateWork("access changed");
  store.open(null, vault.persist, vault.ownerId());
  if (gate.values) createProfile(gate.values);
  await store.retryPending(); await vault.flush();
  requestPersistence();
  gate = { ...gate, step: "recovery", words, values: null };
  session.mode = "setup";
  render();
}
async function afterUnlock(data, factor) {
  if (account.state.signedIn && vault.ownerId() !== account.state.account?.id) throw new Error("These records belong to another account.");
  disposePrivateWork("access changed");
  store.open(data, vault.persist, vault.ownerId());
  const st = await vault.status();
  // A recovery key never confirmed (the app was closed mid-set-up) is replaced, and shown, now.
  if (!st.recoveryConfirmed) { gate = { step: "recovery", words: await vault.replaceRecovery(factor), replacing: true }; if (factor?.passkeySecret) factor.passkeySecret.fill(0); session.mode = "setup"; render(); return; }
  if (factor?.passkeySecret) factor.passkeySecret.fill(0);
  enterApp();
  account.refresh().then(() => render());
}
function enterApp() {
  session.mode = "open"; gate = { step: "profile" }; trail.length = 0; lastActive = Date.now();
  onOpen(); if (!location.hash || ["#/demo", "#/signin", "#/signup"].includes(location.hash.split("?")[0])) location.hash = !activeAccounts().length&&!profile()?.assistant_setup_skipped?.account ? '#/accounts' : '#/home'; render();
}
async function lockNow() {
  if (session.mode !== "open" && !vault.isUnlocked()) return;
  disposePrivateWork("lock");
  const closingOwner = vault.ownerId();
  cancelModal("access changed");
  disposePage?.(); disposePage = null;
  let saveFailed = false;
  try { await store.retryPending(); } catch { saveFailed = true; }
  try { await vault.lock(); } catch { saveFailed = true; }
  saveFailed ||= Boolean(store.persistenceState().error);
  store.close();
  lockSaveWarningOwner = saveFailed ? closingOwner : null;
  gate = { step: "profile", status: await vault.status() }; session.mode = "locked";
  document.getElementById("modal-root").innerHTML = ""; document.getElementById("toast-root").innerHTML = "";
  render();
  if (saveFailed) toast("Records locked, but the latest changes could not be saved. Check this browser's storage.");
}
function showRecovery(words) { gate = { step: "recovery", words, replacing: true }; session.mode = "setup"; render(); }

// ---------- demo: sample data, not locked, and said so ----------
// Demo writes wait a moment, like the vault's, so seeding thousands of rows writes once, not thousands of times.
let demoTimer = null, demoPending = null, demoWaiters = [], demoJob = null;
const writeDemo = () => {
  clearTimeout(demoTimer);
  if (demoJob || !demoPending) return Promise.resolve();
  const snapshot = demoPending, waiters = demoWaiters; demoWaiters = [];
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(snapshot));
    demoPending = null;
    for (const waiter of waiters) waiter.resolve();
    return Promise.resolve();
  } catch (error) {
    for (const waiter of waiters) waiter.reject(error);
    console.error("DEMO_WRITE", error);
    return Promise.reject(error);
  }
};
function persistDemo(db) {
  demoPending = structuredClone(db);
  const result = new Promise((resolve, reject) => demoWaiters.push({ resolve, reject }));
  clearTimeout(demoTimer);
  if (!demoJob) demoTimer = setTimeout(() => { writeDemo().catch(() => {}); }, 300);
  return result;
}
function openDemo(data) {
  store.open(data, demoJob ? null : persistDemo);
  session.mode = "demo";
}
function startDemo({ navigate = true } = {}) {
  if (account.state.signedIn) { clearDemo(); location.hash = "#/home"; render(); return Promise.resolve(); }
  if (demoJob) return demoJob.promise;
  if (session.mode === "demo") { location.hash = "#/home"; return Promise.resolve(); }
  const job = { hash: location.hash, cancelled: false, finish: beginDemoTransition(), promise: null };
  demoJob = job;
  job.promise = prepareDemo(job, navigate);
  return job.promise;
}
async function prepareDemo(job, navigate) {
  let opened = false;
  const cancelled = () => job.cancelled || account.state.signedIn || location.hash !== job.hash;
  disposePrivateWork("access changed");
  try {
    // Keep any real vault sealed before opening the separate sample store.
    if (session.mode === "open" || session.mode === "locked") {
      await vault.lock(); store.close(); gate.status = await vault.status(); session.mode = "locked";
    }
    if (cancelled()) throw new DOMException("Demo setup cancelled", "AbortError");
    openDemo(null); opened = true; createProfile(DEMO_PROFILE());
    await runDemoSteps(seedDemoSteps(), { cancelled });
    if (cancelled()) throw new DOMException("Demo setup cancelled", "AbortError");
    onOpen({ demoReady: true });
    // Preparation is in memory only. Store one completed sample set, never a partial seed revision.
    const completed = store.snapshot();
    localStorage.setItem(DEMO_KEY, JSON.stringify(completed));
    store.open(completed, persistDemo);
    if (navigate) location.hash = "#/home";
  } catch (e) {
    if (opened) { clearDemo(); store.close(); }
    // A failure before vault.lock finished leaves the original real store/key alone.
    if (session.mode !== "open") {
      const st = await vault.status();
      session.mode = st.exists ? "locked" : "setup";
      gate = { step: "profile", ...(st.exists ? { status: st } : {}) };
    }
    if (e.name !== "AbortError") { console.error("DEMO_SETUP", e); toast("Could not open demo. Please try again."); }
  } finally {
    demoJob = null; job.finish();
    render();
  }
}
function clearDemo() {
  if (demoJob) demoJob.cancelled = true;
  // A delayed sample write must not recreate discarded demo data after account entry.
  clearTimeout(demoTimer); demoPending = null;
  const cancelled = new Error("Demo storage was discarded.");
  for (const waiter of demoWaiters.splice(0)) waiter.reject(cancelled);
  try { localStorage.removeItem(DEMO_KEY); } catch {}
  // Leaving a query-launched demo must stay out after reload, not silently seed samples again.
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("demo")) { url.searchParams.delete("demo"); history.replaceState(null, "", url); }
  } catch { /* Some embedded browsers block history changes; don't interrupt data cleanup. */ }
}
async function endDemo({ signup = false } = {}) {
  if (demoJob) { demoJob.cancelled = true; await demoJob.promise; }
  disposePrivateWork("access changed");
  cancelModal("access changed");
  clearDemo();
  document.getElementById("toast-root").replaceChildren();
  if (session.mode === "demo") { document.getElementById("modal-root").replaceChildren(); store.close(); }
  session.mode = "setup";
  const st = await vault.status();
  session.mode = st.exists ? "locked" : "setup"; gate = st.exists ? { step: "profile", status: st } : { step: "profile" };
  location.hash = signup ? "#/signup" : "#/home"; render();
}
async function selectAccount() {
  let id = account.state.account?.id || "local-device";
  // Offline access uses only a public account ID; its key still requires device approval.
  if (!account.state.server || !account.state.enabled) {
    try { id = localStorage.getItem(LAST_OWNER) || id; } catch {}
  }
  const st = await vault.selectOwner(id);
  if (account.state.signedIn) { try { localStorage.setItem(LAST_OWNER, id); } catch {} }
  return st;
}
async function accountChanged() {
  const closingOwner = vault.ownerId();
  disposePrivateWork("access changed");
  cancelModal("access changed");
  disposePage?.(); disposePage = null;
  let saveFailed = false;
  try { await store.retryPending(); } catch { saveFailed = true; }
  try { await vault.lock(); } catch { saveFailed = true; }
  saveFailed ||= Boolean(store.persistenceState().error);
  store.close(); lockSaveWarningOwner = saveFailed ? closingOwner : null; clearDemo(); trail.length = 0;
  document.getElementById("modal-root").replaceChildren(); document.getElementById("toast-root").replaceChildren();
  const st = await selectAccount();
  gate = { step: "profile", status: st }; session.mode = st.exists ? "locked" : "setup";
  location.hash = "#/signin"; render();
  if (saveFailed) toast("Signed out and locked, but the latest changes could not be saved. Check this browser's storage.");
}
async function afterAccountEntry(result = {}) {
  if (demoJob) { demoJob.cancelled = true; await demoJob.promise; }
  disposePrivateWork("access changed");
  if (!result.unlocked) await vault.lock();
  clearDemo(); store.close();
  const st = result.account?.id ? await vault.selectOwner(result.account.id) : await selectAccount();
  if (result.account?.id) { try { localStorage.setItem(LAST_OWNER, result.account.id); } catch {} signalAccess(result.account.id); }
  gate = { step: "profile", status: st }; session.mode = st.exists ? "locked" : "setup";
  if (result.unlocked) { await afterUnlock(result.unlocked.data, result.unlocked.factor); return; }
  location.hash = "#/home"; render();
}
async function wipe() {
  if (demoJob) { demoJob.cancelled = true; await demoJob.promise; }
  disposePrivateWork("wipe");
  clearTimeout(demoTimer); demoPending = null;
  cancelModal("access changed");
  disposePage?.(); disposePage = null;
  store.close();
  if (session.mode !== "demo") await vault.destroy();
  try { localStorage.removeItem(DEMO_KEY); localStorage.removeItem(LEGACY_KEY); } catch {}
  store.close(); location.hash = "#/home"; location.reload();
}
const readJson = (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };

let current = null, disposePage, renderedView = null, redrawDeferred = false;
function renderStorageWarning() {
  const root = document.getElementById("storage-warning");
  if (!root) return;
  root.replaceChildren();
  const failed = Boolean(store.persistenceState().error);
  const lockedFailure = lockSaveWarningOwner === vault.ownerId();
  if (!failed && !lockedFailure) { root.hidden = true; return; }
  root.hidden = false;
  const message = document.createElement("p");
  message.textContent = failed ? "Not saved. Money changes are paused until saving succeeds." : "Records were locked, but the latest changes could not be saved. Do not assume they were saved.";
  root.append(message);
  if (failed) {
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "primary"; retry.textContent = "Retry saving";
    retry.addEventListener("click", async () => {
      retry.disabled = true; retry.textContent = "Saving…";
      try { await store.retryPending(); } catch {}
      renderStorageWarning();
    });
    root.append(retry);
  }
}
let routeEntryId = 0;
function pageDraft(app) {
  const controls = [...app.querySelectorAll('input,select,textarea,button,a,summary,[tabindex]')];
  const key = (node) => node.dataset.recordControl ? `record:${node.dataset.recordControl}` : node.name ? `field:${node.closest('[data-form]')?.dataset.form || ''}:${node.name}` : node.id ? `id:${node.id}` : `control:${controls.indexOf(node)}`;
  const active = document.activeElement;
  return { key, focus: app.contains(active) ? key(active) : null, start: active?.selectionStart, end: active?.selectionEnd,
    scrollX: window.scrollX, scrollY: window.scrollY,
    fields: controls.filter(node => node.name && ['INPUT','SELECT','TEXTAREA'].includes(node.tagName) && !['password','file','hidden'].includes(node.type) && !/code|otp|secret|recovery|pass/i.test(node.name) && node.autocomplete !== 'one-time-code').map(node => ({ key: key(node), value: node.value, checked: node.checked })) };
}
function restorePageDraft(app, draft, focus = false) {
  if (!draft) return;
  const controls = [...app.querySelectorAll('input,select,textarea,button,a,summary,[tabindex]')];
  const key = (node) => node.dataset.recordControl ? `record:${node.dataset.recordControl}` : node.name ? `field:${node.closest('[data-form]')?.dataset.form || ''}:${node.name}` : node.id ? `id:${node.id}` : `control:${controls.indexOf(node)}`;
  if (!focus) for (const field of draft.fields) { const node = controls.find(node => key(node) === field.key); if (node) { node.value = field.value; if (typeof field.checked === 'boolean') node.checked = field.checked; } }
  else { const node = controls.find(node => key(node) === draft.focus); node?.focus({ preventScroll: true }); if (node && typeof draft.start === 'number') { try { node.setSelectionRange(draft.start, draft.end); } catch {} } }
}
function setupProgress() {
  if (session.mode === 'locked' || (account.needed() && match(location.hash || '#/signin').pattern !== 'signup')) return '';
  const identity = account.state.server && account.state.enabled;
  const steps = [...(identity ? [['identity', 'Your account']] : []), ['profile', 'About you'], ['lock', 'Device access'], ['recovery', 'Save recovery words']];
  const currentStep = account.needed() ? 'identity' : gate.step || 'profile', currentIndex = steps.findIndex(([key]) => key === currentStep);
  const completed = { identity: account.state.signedIn, profile: Boolean(profile() || gate.values), lock: vault.isUnlocked(), recovery: false };
  const remaining = steps.filter(([key]) => key !== currentStep && !completed[key]).map(([,label]) => label);
  return `<nav class="setup-progress" aria-label="Setup progress"><ol>${steps.map(([key,label]) => `<li${key === currentStep ? ' aria-current="step"' : ''}>${completed[key] && key !== currentStep ? '<span class="sr-only">Completed: </span>' : ''}${esc(label)}</li>`).join('')}</ol><p class="hint">Step ${currentIndex + 1} of ${steps.length}: ${esc(steps[currentIndex]?.[1] || 'Setup')}${remaining.length ? `. Still needed: ${esc(remaining.join(', '))}` : ''}</p></nav>`;
}
function afterPageBind(page, app, reason, draft = null, top = '') {
  const first = app.firstElementChild, hash = location.hash, generation = store.generation(), mode = session.mode;
  const title = document.getElementById('topbar-title'); title.textContent = page.title; document.title = `${page.title} · Hodos`;
  const ownHeading = app.querySelector('h1'), heading = ownHeading || title;
  if (ownHeading) { ownHeading.id ||= 'page-heading'; title.removeAttribute('role'); title.removeAttribute('aria-level'); }
  else { title.setAttribute('role','heading'); title.setAttribute('aria-level','1'); }
  heading.setAttribute('tabindex','-1'); app.setAttribute('aria-labelledby', heading.id);
  queueMicrotask(() => {
    if (app.firstElementChild !== first || location.hash !== hash || store.generation() !== generation || session.mode !== mode) return;
    const restored = page.afterBind?.(app, { reason, routeEntryId }) === true;
    if (document.querySelector('[data-modal-form]')) return;
    if (reason === 'redraw') { restorePageDraft(app, draft, true); if (draft && top !== 'chat') window.scrollTo(draft.scrollX, draft.scrollY); }
    else if (!restored) { heading.focus({ preventScroll: true }); window.scrollTo(0,0); }
  });
}
function render({ reason = "redraw" } = {}) {
  renderStorageWarning();
  // Never expose partial samples or rebuild the old entry thousands of times.
  if (demoJob) { if (account.state.signedIn || location.hash !== demoJob.hash) demoJob.cancelled = true; return; }
  const app = document.getElementById("app");
  const view = { hash: location.hash, generation: store.generation(), mode: session.mode };
  if (reason === "redraw" && (renderedView?.generation !== view.generation || renderedView?.mode !== view.mode)) reason = "access";
  else if (reason === "redraw" && renderedView?.hash !== view.hash) reason = "navigate";
  // Keep active preparation inputs/controller attached on data redraws, never on departure/access.
  if (reason === "redraw" && app.querySelector('form[aria-busy="true"], [data-hold-pending]')) { redrawDeferred = true; return; }
  const draft = reason === 'redraw' && ['open','demo'].includes(session.mode) ? pageDraft(app) : null;
  redrawDeferred = false; renderedView = view;
  if (reason !== 'redraw') { app.dataset.routeEntry = String(++routeEntryId); disposeAllOperations(reason); }
  disposePage?.({ reason }); disposePage = null;
  const lockBtn = document.getElementById("lock-btn"); if (lockBtn) lockBtn.hidden = session.mode !== "open";
  const backBtn = document.getElementById("back-btn"), homeBtn = document.getElementById("home-btn");
  if (session.mode === "demo" && account.state.signedIn) { endDemo(); return; }
  if (location.hash === "#/demo" && session.mode === "setup" && gate.step === "profile") { startDemo(); return; }
  // "More" became Settings when the home screen took over the job of reaching features.
  if (location.hash === "#/more") { location.hash = "#/settings"; return; }
  const gated = session.mode === "setup" || session.mode === "locked" || !profile();
  // Behind the lock nothing about the data shows, not even how many alerts are waiting.
  document.getElementById("alerts-btn").hidden = gated;
  // First run and the lock get their own surface, darker than night mode: the tokens are re-pointed
  // by one class on the body, so every control on those screens inherits it unchanged.
  document.body.classList.toggle("vault", gated);
  document.body.classList.toggle("auth-gated", gated && account.needed());
  if (gated) {
    // pi-lens-ignore: no-inner-html-js
    const page = gatePage(); app.innerHTML = setupProgress() + page.html; disposePage = page.bind(app, { reason });
    afterPageBind(page, app, reason);
    backBtn.hidden = true; homeBtn.hidden = false;
    document.getElementById("tabbar").hidden = true; document.getElementById("tabbar").innerHTML = "";
    document.getElementById("topbar-title").textContent = page.title; return;
  }
  document.getElementById("tabbar").hidden = false;
  const { fn, params, top, pattern } = match(location.hash || "#/home");
  current = { fn, params, pattern };
  track(location.hash || "#/home");
  // A tab is a top level: nothing above it to go back to. Everything else can go back.
  const isTab = tabs().some((t) => t.key === pattern);
  backBtn.hidden = isTab; homeBtn.hidden = !isTab;
  let page;
  try { page = fn(params); } catch (e) { console.error(e); page = { title: "Error", html: '<div class="card"><h2>This screen could not be opened</h2><p>Try another screen or reload. Your saved records have not been removed.</p></div>', bind() {} }; }
  // pi-lens-ignore: no-inner-html-js
  app.innerHTML = (session.mode === "demo" ? `<div class="demo-banner"><span>Demo: sample data, not locked.</span><button class="small" data-end-demo>Start your own</button></div>` : "") + page.html; restorePageDraft(app, draft); disposePage = page.bind(app, { reason });
  // Internal replaceState cleanup (Records clamping/chat query consumption) is not a departure.
  if (location.hash !== view.hash && location.hash.split('?')[0] === view.hash.split('?')[0]) {
    renderedView = { ...view, hash: location.hash };
    if (trail.at(-1) === view.hash) trail[trail.length - 1] = location.hash;
  }
  afterPageBind(page, app, reason, draft, top);
  app.querySelector("[data-end-demo]")?.addEventListener("click", () => session.endDemo({ signup: true }));
  document.getElementById("topbar-title").textContent = page.title;
  renderTabs(top);
  const n = unread().length; const badge = document.getElementById("alerts-badge"); badge.hidden = !n; badge.textContent = n;
}

function afterWrite() { if (demoJob) return; try { checkThresholds(); checkUnlock(); checkGoals(); } catch (e) { console.error(e); } }
function onOpen({ demoReady = false } = {}) {
  if (demoJob && !demoReady) return;
  if (!profile() || (session.mode !== "open" && session.mode !== "demo")) return;
  try { migrateBudgets(); postDue(); monthlyDue(); checkThresholds(); checkGoals(); checkDebts(); checkRenewals(); checkRecurring(); } catch (e) { console.error("open hooks", e); }
  if (!featurePaused("briefings")) briefingDue({ inMemoryOnly: demoReady }).catch((e) => console.error(e));
}
function disposePrivateWork(reason) {
  clearPendingSend(); clearRecordsView(); trail.length = 0; disposeAllOperations(reason);
}

// ---------- auto-lock: 5 minutes without use, or 5 minutes in the background ----------
const IDLE_MS = 5 * 60 * 1000;
let lastActive = Date.now(), hiddenAt = null;
function watchIdle() {
  // Let the release/click finish before replacing gesture-owned DOM.
  for (const ev of ["pointerup", "pointercancel", "blur"]) window.addEventListener(ev, () => {
    if (redrawDeferred) setTimeout(() => { if (redrawDeferred) render(); }, 0);
  });
  for (const ev of ["pointerdown", "keydown", "touchstart", "wheel"]) window.addEventListener(ev, () => (lastActive = Date.now()), { passive: true });
  setInterval(() => { if (vault.isUnlocked() && Date.now() - lastActive > IDLE_MS) lockNow(); }, 15000);
  // The screen is veiled whenever the app is out of sight, so the app switcher shows no numbers.
  // A write waits a moment before it is sealed, so it is sealed at once when the page goes away.
  const flushOnDeparture = () => {
    const saving = store.retryPending();
    vault.flush().catch(() => {}); writeDemo().catch(() => {});
    saving.then(() => vault.flush()).catch(() => {});
  };
  window.addEventListener("pagehide", () => {
    disposePrivateWork("pagehide");
    cancelModal("pagehide");
    // Cached pages keep their bound DOM; retain its idempotent departure hook until rebind.
    disposePage?.({ reason: "departure" });
    flushOnDeparture();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); document.body.classList.add("veiled"); flushOnDeparture(); return; }
    document.body.classList.remove("veiled");
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = null; lastActive = Date.now();
    if (vault.isUnlocked() && away > IDLE_MS) { lockNow(); return; }
    onOpen(); render();
  });
}

async function boot() {
  theme.apply();
  captureInstallPrompt();
  Object.assign(session, { lockNow, startDemo, endDemo, wipe, showRecovery, render, accountChanged, signalAccess });
  await Promise.all([ai.refreshStatus(), account.refresh()]);
  const st = await selectAccount();
  // All old shared test data is explicitly disposable. Never import it into an account.
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
  if (account.state.signedIn) { clearDemo(); signalAccess(account.state.account.id); }
  const demo = account.state.signedIn ? null : readJson(DEMO_KEY);
  // ?demo=1 or #/demo on a device with nothing set up opens the sample data, unlocked and labelled.
  const wantDemo = new URLSearchParams(location.search).get("demo") || location.hash === "#/demo";
  if (st.exists) { gate.status = st; session.mode = "locked"; }
  else if (demo) openDemo(demo);
  else if (wantDemo && !account.state.signedIn) await startDemo({ navigate: false });
  else { session.mode = "setup"; gate = { step: "profile" }; }
  bus.on("write", afterWrite);
  store.subscribe((event) => {
    if (event?.type !== "action-applied") render();
  });
  store.onCommitted(() => render());
  window.addEventListener("storage", async (e) => {
    if (e.key !== ACCESS_SIGNAL || !vault.isUnlocked()) return;
    let notice; try { notice = JSON.parse(e.newValue); } catch { return; }
    if (!notice || notice.accountId === vault.ownerId()) return;
    await lockNow(); await account.refresh(); render();
  });
  window.addEventListener("hashchange", () => {
    cancelModal("navigation"); render({ reason: "navigate" });
  });
  document.querySelector('[data-skip-main]')?.addEventListener('click', (event) => { event.preventDefault(); document.getElementById('app').focus(); });
  document.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => (location.hash = b.dataset.nav)));
  document.getElementById("lock-btn")?.addEventListener("click", () => lockNow());
  document.getElementById("back-btn").addEventListener("click", () => goBack(current?.pattern));
  const nav = document.getElementById('tabbar');
  const measureNavigation = () => document.body.style.setProperty('--nav-clearance', `${nav.getBoundingClientRect().height}px`);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureNavigation).observe(nav);
  window.addEventListener('resize', measureNavigation); measureNavigation();
  watchIdle();
  onOpen();
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();

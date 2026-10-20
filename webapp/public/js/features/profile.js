// Profile + consent + settings. Foundations §1.
import { store, requestPersistence } from "../lib/store.js";
import { CURRENCIES } from "../lib/money.js";
import { todayIn, deviceTz } from "../lib/dates.js";
import { html, field, inp, sel, toast, modal, raw, esc, numberBoxes, readNumberBoxes, rateLink, commitFormAction, commitAction, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import * as fx from "../lib/fx.js";
import * as theme from "../lib/theme.js";
import { seedCategories } from "./categories.js";
import * as vault from "../lib/vault.js";
import { session } from "../lib/session.js";
import { lockCard, bindLockCard } from "./lock.js";
import { accountCard, bindAccountCard } from "./signin.js";
import * as account from "../lib/account.js";
import * as BK from "./backup.js";
import * as NW from "./networth.js";
import * as INS from "./insurance.js";
import * as DB from "./debts.js";
import { icon } from "../lib/icons.js";
import { panelKey, CATALOGUE, openPanelPicker } from "./widgets.js";
import { createOperation } from "../lib/operations.js";
import { ratesCard, bindRates } from "./exchange-rates.js";

export const profile = () => store.one("profile");
export const base = () => profile()?.base_currency || "SGD";
export const tz = () => profile()?.timezone || deviceTz();
export const today = () => todayIn(tz());
// Overseas mode: while a currency is set, new records default to it instead of the account's.
export const overseasCurrency = () => profile()?.overseas_currency || null;
export const entryCurrency = (account) => overseasCurrency() || account?.currency || base();
export function setOverseas(currency) {
  if (currency) fx.validatePair(currency, base());
  return store.update("profile", profile().id, { overseas_currency: currency || null });
}

export const CONSENT_VERSION = "2026-09-18";

export function createProfile({ base_currency, timezone, self_description, self_text, name, dob, ai_provider }) {
  const fields = profileIssues({ base_currency, timezone, self_description, name, dob });
  if (Object.keys(fields).length) throw new ValidationError({ fields });
  const row = store.insert("profile", {
    base_currency, timezone, self_description, self_text: self_text || null,
    name: name || null, dob: dob || null,
    consent: { version: CONSENT_VERSION, accepted_at: new Date().toISOString(), ai_provider: ai_provider === undefined ? true : Boolean(ai_provider) }, // on unless the user opts out
    subcategories_enabled: false, subcategory_prompt_shown_at: null,
  });
  seedCategories();
  store.upsertOne("budget_settings", { start_day: 1, default_thresholds: [80, 100] });
  store.upsertOne("insight_settings", { briefing_cadence: "month", bills_days: 14 });
  requestPersistence();
  return row;
}

const DESCRIPTIONS = ["student", "working", "retiree", "other"];
function profileIssues(values, { requireName = false } = {}) {
  const fields = {};
  if (values.name != null && typeof values.name !== 'string') fields.name = 'Enter a name or leave it blank.';
  else if (requireName && !String(values.name || '').trim()) fields.name = 'Enter your name.';
  if (!CURRENCIES.includes(values.base_currency)) fields.base_currency = 'Choose a supported currency.';
  if (!DESCRIPTIONS.includes(values.self_description)) fields.self_description = 'Choose one of the descriptions.';
  if (typeof values.timezone !== 'string' || !values.timezone.trim()) fields.timezone = 'Enter your timezone.';
  else { try { new Intl.DateTimeFormat('en', { timeZone: values.timezone }); } catch { fields.timezone = 'Enter a valid timezone, such as Asia/Singapore or UTC.'; } }
  if (values.dob != null && values.dob !== '') {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(values.dob) ? new Date(`${values.dob}T00:00:00.000Z`) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== values.dob) fields.dob = 'Choose a valid calendar date or leave it blank.';
  }
  return fields;
}

// First run: about you. The profile is not saved here: it is handed on, and saved once the lock exists,
// so it is never written anywhere unencrypted. `values` refills the form when the user comes back to it.
// Signed in, the welcome was on the sign-in screen, so it is not said twice.
export const DEMO_PROFILE = () => ({ name: "Alex", base_currency: "SGD", timezone: deviceTz(), self_description: "working", ai_provider: true });
export function onboardingPage({ onStart, values = null, signedIn = false }) {
  const v = values || {};
  return {
    title: signedIn ? "About you" : "Welcome",
    html: html`<div class="onboard">
      ${signedIn ? "" : raw(`<div class="onboard-mark"><img src="icon.svg?v=hvault1" width="64" height="64" alt="" aria-hidden="true" /></div>
      <h1>Track every dollar<br>with almost no effort</h1>
      <p class="onboard-lede">Then see your options, with the maths behind each, and decide this month.</p>
      <div class="onboard-facts">
        <span>Everything stays on this device, encrypted</span>
        <span>Nothing is sent anywhere unless you ask</span>
      </div>`)}
      <div class="card">
      <h2>About you</h2>
      ${signedIn ? raw(`<p class="muted">Signed in as ${esc(account.state.account?.email || "")}. Next, a few things about you, then the lock.</p>`) : ""}
      <form data-form="profile-create">
        ${raw(field("Your name", inp("name", { required: true, value: v.name || "", placeholder: "What should the app call you?" })))}
        ${raw(field("I am a…", sel("self_description", DESCRIPTIONS, v.self_description), "Shapes the examples the app gives you. Nothing else."))}
        ${raw(field("Date of birth (optional)", inp("dob", { type: "date", value: v.dob || "" })))}
        ${raw(field("Base currency", sel("base_currency", CURRENCIES, v.base_currency || "SGD"), "Every total is shown in this currency."))}
        ${raw(field("Timezone", inp("timezone", { value: v.timezone || deviceTz(), required: true }), "Governs dates, recurring posts, budget months."))}
        <label><input type="checkbox" name="ai_provider" ${v.ai_provider === false ? "" : "checked"} /> Allow AI help. Text, photos and summaries you choose to send go to a third-party AI provider through this app's server. The server stores none of it.</label>
        <div class="actions right">${signedIn ? "" : raw('<button type="button" data-action="demo">Have a look around first</button>')}<button class="primary" type="submit">Next</button></div>
      </form>
      </div>
    </div>`,
    bind(root) {
      root.querySelector("[data-action=demo]")?.addEventListener("click", () => session.startDemo());
      const form = root.querySelector('[data-form=profile-create]');
      const validation = bindValidation(form, { validate: (values) => ({ fields: profileIssues(Object.fromEntries(values), { requireName: true }) }) });
      form.onsubmit = (e) => {
        e.preventDefault();
        const { valid, values: f } = validation.validateSubmit(); if (!valid) return;
        onStart({ base_currency: f.get("base_currency"), timezone: f.get("timezone"), self_description: f.get("self_description"), name: String(f.get("name")).trim(), dob: f.get("dob"), ai_provider: f.get("ai_provider") === "on" });
      };
      return () => { validation.dispose(); form.onsubmit = null; };
    },
  };
}

// Settings retains its tools beside the fixed Home icons.
const TOOLS = [
  ["#/recurring", icon("recurring"), "Recurring", "Rules that post themselves"],
  ["#/categories", icon("categories"), "Categories", "Labels and merchant memory"],
  ["#/alerts", icon("alerts"), "Alerts", "Everything that needs a look"],
];
export function settingsPage({ enableAi = new URLSearchParams(location.hash.split("?")[1]).get("enable-ai") === "1" } = {}) {
  const p = profile();
  const bs = store.one("budget_settings");
  const is = store.one("insight_settings");
  const counts = store.counts();
  const query = new URLSearchParams(location.hash.split("?")[1] || "");
  const travelCurrencies = CURRENCIES.filter((c) => c !== p.base_currency);
  return {
    title: "Settings",
    afterBind(root) {
      if (!enableAi || p.consent.ai_provider) return false;
      const consent = root.querySelector('#ai-consent');
      consent.scrollIntoView({block:'center'});
      consent.focus({preventScroll:true});
      return true;
    },
    html: html`
      <div class="card"><div class="profile-head"><span class="avatar">${(p.name || "?").trim().charAt(0).toUpperCase()}</span><div><div class="profile-name">${p.name || "No name yet"}</div><div class="sub">${account.state.signedIn ? account.state.account.email : session.mode === "demo" ? "Sample data" : "On this device, locked with your key"}</div></div></div>
        <form data-form="profile">
          ${raw(field("Your name", inp("name", { value: p.name || "" })))}
          ${raw(field("I am a…", sel("self_description", DESCRIPTIONS, p.self_description)))}
          ${raw(field("Date of birth (optional)", inp("dob", { type: "date", value: p.dob || "" })))}
          ${raw(field("Base currency", sel("base_currency", CURRENCIES, p.base_currency), "Changing it does not rewrite history. Old snapshots keep their currency."))}
          ${raw(field("Timezone", inp("timezone", { value: p.timezone, required: true })))}
          ${enableAi && !p.consent.ai_provider ? raw('<p class="hint">To use the Assistant, tick Allow AI help below, then Save. Only text, photos and summaries you choose to send go to a third-party AI provider.</p>') : ""}
          <label><input id="ai-consent" type="checkbox" name="ai_provider" ${p.consent.ai_provider ? "checked" : ""}/> Allow AI help (sent to a third-party AI provider via this server)</label>
          ${p.consent.ai_provider && !ai.enabled() ? raw(`<div class="hint">${esc(ai.whyDisabled())}</div>`) : ""}
          <label><input type="checkbox" name="subcategories_enabled" ${p.subcategories_enabled ? "checked" : ""}/> Subcategories on (deeper analysis; optional per transaction)</label>
          <div class="actions right"><button class="primary">Save</button></div>
        </form></div>
      ${raw(accountCard())}
      ${session.mode === "open" ? raw(lockCard()) : ""}
      <div class="card menu"><h2>Tools</h2>
        ${raw(TOOLS.map(([h, ic, t, d]) => `<a href="${h}"><span class="ic">${ic}</span><span><div>${t}</div><div class="desc">${d}</div></span></a>`).join(""))}
      </div>
      <div class="card"><h2>Home panel</h2>
        <p class="muted">Showing ${CATALOGUE[panelKey()].title}. Change it here, or press and hold the panel on Home.</p>
        <div class="actions"><button data-action="home-panel">Choose panel contents</button></div>
      </div>
      <div class="card"><h2>Appearance</h2>
        <div class="chips" data-theme-picker>${raw(theme.MODES.map((m) => `<button class="chip ${theme.theme() === m ? "on" : ""}" data-theme="${m}">${m === "system" ? "Match device" : m === "light" ? "Light" : "Dark"}</button>`).join(""))}</div>
        <p class="hint">This one setting stays on this device. A backup restored somewhere else leaves that device's choice alone.</p>
      </div>
      <div class="card"><h2>Budget month</h2>
        <form data-form="budget-settings">
          ${raw(field("Starts on day (pay day)", inp("start_day", { type: "number", value: bs?.start_day ?? 1, min: 1, max: 31, required: true }), "31 → last day of short months."))}
          ${raw(numberBoxes("th", bs?.default_thresholds || [80, 100], { max: 200, placeholder: "%", label: "Budget alert", legend: "Default budget alert points (% of limit)" }))}<div class="hint">Up to three. Each budget can change its own.</div>
          ${raw(field("Briefing cadence", sel("cadence", ["month", "week"], is?.briefing_cadence || "month")))}
          <div class="actions right"><button class="primary">Save</button></div>
        </form></div>
      <div class="card"><h2>Dates and reminders</h2>
        <form data-form="timing">
          ${raw(field("Monthly net worth snapshot on day", inp("snapshot_day", { type: "number", value: NW.settings().snapshot_day, min: 1, max: 31, required: true }), "Taken the first time you open the app on or after that day. 31 means the last day of short months."))}
          ${raw(field("Bills widget looks ahead (days)", inp("bills_days", { type: "number", value: is?.bills_days ?? 14, min: 1, max: 90, required: true })))}
          ${raw(numberBoxes("ins", INS.settings().lead_days, { placeholder: "days", label: "Renewal reminder", legend: "Insurance renewal reminders, days before" }))}
          ${raw(numberBoxes("debt", DB.settings().lead_days, { placeholder: "days", label: "Loan reminder", legend: "Loan lock-in and maturity reminders, days before" }))}
          <div class="hint">Up to three reminders each. Clear every box for none. A policy or a loan can set its own.</div>
          <div class="actions right"><button class="primary">Save</button></div>
        </form></div>
      <div class="card"><h2>Overseas mode</h2>
        <p class="muted">Turn this on while you are abroad. New records default to the local currency instead of your account's, and each one shows what it costs in ${base()} before you save it. The rate is still frozen onto the record when you confirm, so nothing already saved ever changes.</p>
        <form data-form="overseas">
          <label><input type="checkbox" name="on" ${p.overseas_currency ? "checked" : ""}/> Overseas mode is on</label>
          <div data-overseas-controls ${p.overseas_currency ? "" : "hidden"}>
            ${raw(field("Where are you? (currency)", sel("currency", travelCurrencies, p.overseas_currency || (travelCurrencies.includes("USD") ? "USD" : travelCurrencies[0]))))}
            <p class="hint">Save the mode, then enter a manual exchange rate below if needed. Each record shows the account amount before you confirm.</p>
          </div>
          <div class="actions right"><button class="primary">Save</button></div>
        </form>
        ${p.overseas_currency ? raw(`<p class="hint">On now: new records default to <b>${p.overseas_currency}</b>. ${fx.liveRate(p.overseas_currency, p.base_currency) ? `1 ${p.overseas_currency} = ${fx.liveRate(p.overseas_currency, p.base_currency).rate} ${p.base_currency}.` : `Exchange rate missing: ${p.overseas_currency} → ${p.base_currency}. ${rateLink(p.overseas_currency, p.base_currency)}`}</p>`) : ""}
      </div>
      ${raw(ratesCard({ base: p.base_currency, overseas: p.overseas_currency, today: today(), query }))}
      ${session.mode === "demo" && !account.state.signedIn ? raw(`<div class="card"><h2>Demo</h2><p class="muted">These are samples, not your records. Create an account to start with your own data.</p><div class="actions"><button class="primary" data-action="end-demo">Start your own</button></div></div>`) : ""}
      <div class="card"><h2>Your data</h2>
        <p class="muted">${counts.transactions} transactions · ${counts.accounts} accounts · ${counts.categories} categories. ${session.mode === "demo" ? "Sample data in this browser, not locked." : "Stored only on this device, encrypted."} Last backup: ${BK.state().last_backup_at ? BK.state().last_backup_at.slice(0, 10) : "never"}.</p>
        ${session.mode === "open" ? raw(`<form data-form="backup-remind">${field("Remind me to back up", sel("remind", [["week", "every week"], ["month", "every month"], ["off", "never"]], BK.state().remind, (x) => x[1], (x) => x[0]))}</form>`) : ""}
        <div data-operation-root><div class="actions">
          <button data-action="export" ${session.mode !== "open" ? "disabled" : ""}>Export backup</button>
          <label class="btn">Restore backup <input type="file" accept="application/json" data-action="import" ${session.mode !== "open" ? "disabled" : ""} hidden /></label>
          <button class="danger" data-action="wipe">${session.mode === "demo" ? "Clear sample data" : "Wipe local records"}</button>
        </div><div data-operation-status class="operation-status" role="status" aria-live="polite"></div></div>
      </div>`,
    bind(root) {
      const settingsForms = [...root.querySelectorAll('[data-form=profile],[data-form=budget-settings],[data-form=timing],[data-form=overseas]')];
      for (const form of settingsForms) {
        const status = document.createElement('div'), error = document.createElement('div');
        status.className = 'operation-status'; status.dataset.formStatus = ''; status.setAttribute('role', 'status');
        error.className = 'error'; error.dataset.formError = ''; form.append(status, error);
        const submit = form.querySelector('button[type=submit],button:not([type])');
        if (store.persistenceState().error) { submit.disabled = true; submit.setAttribute('aria-describedby', 'storage-warning'); }
        bindValidation(form, { validate(values) {
          const fields = {};
          if (form.dataset.form === 'profile') Object.assign(fields, profileIssues(Object.fromEntries(values)));
          let bounds = {}, groups = [];
          if (form.dataset.form === 'budget-settings') { bounds = { start_day: [1, 31] }; groups = [['th', { max: 200 }]]; }
          else if (form.dataset.form === 'timing') { bounds = { snapshot_day: [1, 31], bills_days: [1, 90] }; groups = [['ins', {}], ['debt', {}]]; }
          for (const [name, [min, max]] of Object.entries(bounds)) {
            const text = String(values.get(name) || '').trim(), n = Number(text);
            if (!text || !Number.isInteger(n) || n < min || n > max) fields[name] = `Enter a whole number from ${min} to ${max}.`;
          }
          for (const [prefix, options] of groups) {
            try { readNumberBoxes(values, prefix, options); } catch (issue) { if (issue instanceof ValidationError) Object.assign(fields, issue.fields); else throw issue; }
          }
          if (form.dataset.form === 'budget-settings' && !['month', 'week'].includes(values.get('cadence'))) fields.cadence = 'Choose month or week.';
          if (form.dataset.form === 'overseas' && values.get('on') === 'on') { try { fx.validatePair(values.get('currency'), base()); } catch (issue) { fields.currency = issue.message; } }
          return { fields };
        } });
      }
      const saveForm = async (event, mutate) => {
        event.preventDefault(); const form = event.currentTarget;
        if (form.dataset.saving === 'true' || store.persistenceState().error) return;
        const { valid, values } = form.validation.validateSubmit(); if (!valid) return;
        const submit = form.querySelector('button[type=submit],button:not([type])'), status = form.querySelector('[data-form-status]'), errorNode = form.querySelector('[data-form-error]');
        errorNode.textContent = ''; status.textContent = 'Saving…'; submit.disabled = true;
        form.dataset.saving = 'true'; form.setAttribute('aria-busy', 'true');
        let applied = false;
        try { await commitAction(() => { const result = mutate(values); applied = true; return result; }); }
        catch (error) {
          if (form.isConnected) {
            if (error instanceof ValidationError) form.validation.show(error);
            else errorNode.textContent = error.message || String(error);
          }
        }
        finally {
          delete form.dataset.saving; form.setAttribute('aria-busy', 'false'); status.textContent = '';
          submit.disabled = Boolean(store.persistenceState().error);
          if (applied && form.isConnected) session.render();
        }
      };
      let closePanelPicker, restoreOperation = null;
      root.querySelector("[data-action=home-panel]").onclick = (e) => { closePanelPicker = openPanelPicker({ returnFocus: e.currentTarget }); };
      root.querySelectorAll("[data-theme-picker] [data-theme]").forEach((b) => (b.onclick = () => {
        theme.setTheme(b.dataset.theme);
        root.querySelectorAll("[data-theme-picker] [data-theme]").forEach((x) => x.classList.toggle("on", x === b));
      }));
      root.querySelector("[data-form=profile]").onsubmit = (e) => saveForm(e, (f) => {
        store.update("profile", p.id, { base_currency: f.get("base_currency"), timezone: f.get("timezone"), self_description: f.get("self_description"), name: String(f.get("name") || "").trim() || null, dob: f.get("dob") || null, subcategories_enabled: f.get("subcategories_enabled") === "on", consent: { ...p.consent, ai_provider: f.get("ai_provider") === "on" } });
        toast("Saved");
      });
      root.querySelector("[data-form=budget-settings]").onsubmit = (e) => saveForm(e, (f) => {
        const th = readNumberBoxes(f, "th", { max: 200 }).reverse();
        store.upsertOne("budget_settings", { start_day: Number(f.get("start_day")), default_thresholds: th });
        store.upsertOne("insight_settings", { briefing_cadence: f.get("cadence") });
        toast("Saved");
      });
      root.querySelector("[data-form=timing]").onsubmit = (e) => saveForm(e, (f) => {
        const ins = readNumberBoxes(f, "ins"), debt = readNumberBoxes(f, "debt");
        NW.setSnapshotDay(f.get("snapshot_day"));
        store.upsertOne("insight_settings", { bills_days: Number(f.get("bills_days")) });
        INS.setDefaultLeadDays(ins); DB.setDefaultLeadDays(debt);
        INS.checkRenewals(); DB.checkAlerts();
        toast("Saved");
      });
      const overseasForm = root.querySelector("[data-form=overseas]");
      const travelControls = () => {
        const on = overseasForm.elements.on.checked;
        overseasForm.querySelector("[data-overseas-controls]").hidden = !on;
        overseasForm.currency.disabled = !on;
      };
      overseasForm.elements.on.onchange = travelControls; travelControls();
      overseasForm.onsubmit = (e) => saveForm(e, (f) => {
        const cur = f.get("on") === "on" ? f.get("currency") : null;
        setOverseas(cur);
        toast(cur ? `Overseas mode on. New records default to ${cur}.` : "Overseas mode off. New records go back to the account's currency.");
      });
      bindRates(root, { query, today: today() });
      bindAccountCard(root, { modal });
      if (session.mode === "open") bindLockCard(root, { lockNow: () => session.lockNow(), showRecovery: (words) => session.showRecovery(words) });
      root.querySelector("[data-action=end-demo]")?.addEventListener("click", () => session.endDemo({ signup: true }));
      root.querySelector("[data-action=export]").onclick = () => BK.openExport();
      root.querySelector("[data-form=backup-remind]")?.addEventListener("change", async (e) => { try { await commitAction(() => { BK.setRemind(e.target.value); toast("Saved"); }); } catch {} });
      const restoreInput = root.querySelector("[data-action=import]");
      restoreInput.onchange = async (e) => {
        if (session.mode !== "open") return toast("Set up and unlock your own encrypted records before restoring a backup.");
        const file = e.target.files[0]; if (!file) return;
        const pageHash = location.hash, operation = createOperation({ root: root.querySelector("[data-operation-root]"), key: "settings.restore-backup", ownerGeneration: store.generation() });
        restoreOperation = operation;
        if (!operation.start("Reading backup file…", "reading")) return;
        try {
          const text = await ai.fileToText(file, { signal: operation.signal });
          if (!operation.active() || !root.isConnected || location.hash !== pageHash || session.mode !== "open") return;
          let parsed;
          try { parsed = JSON.parse(text); } catch { throw new Error("That file is not valid backup data."); }
          if (!vault.isSealedBackup(parsed)) throw new Error("Use an encrypted recovery-key backup; older test backups are not supported.");
          operation.pause("Backup file ready. Review before replacing records.");
          const operationId = crypto.randomUUID(); let receipt = null;
          modal({ title: "Restore backup?", danger: true, submitLabel: "Replace all", onCancel: () => operation.dispose("cancel"),
            body: `<p>This replaces this account's local records with <b>${esc(file.name)}</b>.</p>${field("The backup's 12 recovery words", '<textarea name="rwords" rows="3" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>')}`,
            onSubmit: async (f, form) => {
              if (!operation.start(receipt ? "Retrying restore save…" : "Checking recovery words…", receipt ? "saving" : "preparing")) return false;
              try {
                if (receipt) await commitFormAction(form, operationId, null, receipt);
                else {
                  const revision = vault.accessRevision(), owner = vault.ownerId();
                  const data = await vault.openBackup(parsed, { words: f.get("rwords") });
                  if (!operation.active() || !form.isConnected || !root.isConnected || location.hash !== pageHash) return false;
                  if (revision !== vault.accessRevision() || owner !== vault.ownerId() || session.mode !== "open") throw new Error("Access changed while restoring. No records were replaced.");
                  form.elements.rwords.value = "";
                  receipt = store.captureAction(operationId, () => store.importJson(data));
                  operation.progress("Saving restored records…", "saving");
                  await commitFormAction(form, operationId, null, receipt);
                }
                if (!form.isConnected || !operation.active() || session.mode !== "open") return false;
                if (receipt?.state !== "durable") throw new Error("Device storage did not confirm the restore.");
                operation.succeed("Restore saved."); toast("Restored"); location.hash = "#/home";
              } catch (error) {
                if (operation.active()) operation.fail(error.message || "The restore could not be completed.", receipt ? "Use Retry to save the restored records." : "Check the recovery words and try again.");
                throw error;
              }
            } });
        } catch (error) {
          if (operation.active()) operation.fail(error.message || "This backup could not be read.", "Choose a valid encrypted backup file.");
        } finally { if (restoreInput.isConnected) restoreInput.value = ""; }
      };
      root.querySelector("[data-action=wipe]").onclick = () => {
        modal({ title: session.mode === "demo" ? "Clear sample data?" : "Wipe local records?", body: session.mode === "demo" ? "<p>Deletes only these samples. Real encrypted records are not touched.</p>" : "<p>Deletes this account's local records and device access. Other accounts' encrypted vaults remain. Export first if you want a copy. This cannot be undone.</p>", submitLabel: "Wipe", danger: true, onSubmit: async () => { await session.wipe(); } });
      };
      return ({ reason = "navigate" } = {}) => { for (const form of settingsForms) form.validation?.dispose(); closePanelPicker?.({ redraw: reason === "redraw" }); if (reason !== "redraw") restoreOperation?.dispose(reason); };
    },
  };
}

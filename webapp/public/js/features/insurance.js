// Insurance: policies, renewal alerts, optional premium rule, photo pre-fill. No gap analysis.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, parseMoney, add, CURRENCIES, toDecimalString, isMoney } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, moneyInput, esc, cap, numberBoxes, rateLinks, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as T from "./transactions.js";
import * as AL from "./alerts.js";
import { icon } from "../lib/icons.js";
import { createOperation } from "../lib/operations.js";

export const TYPES = ["life", "health", "critical_illness", "disability", "home", "vehicle", "travel", "other"];
export const FREQ = ["monthly", "quarterly", "yearly", "one_off"];
export const list = (status) => store.all("policies").filter((p) => (status ? p.status === status : p.status !== "archived"));
const premiumCat = () => store.all("categories").find((c) => c.seed_key === "expense:Bills & utilities:Insurance premiums") || store.all("categories").find((c) => c.seed_key === "expense:Bills & utilities");

const safeMoney = (value) => isMoney(value) && Number.isSafeInteger(value.amount) && CURRENCIES.includes(value.currency);
const validDate = (value) => {
  if (value == null || value === "") return true;
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number), date = new Date(0);
  date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
function policyIssues(input, { creating = false, currentFrequency = null, currentRenewal = null } = {}) {
  const fields = {};
  if ((creating || "type" in input) && !TYPES.includes(input.type)) fields.type = "Choose a policy type.";
  if ((creating || "insurer" in input) && (typeof input.insurer !== "string" || !input.insurer.trim())) fields.insurer = "Enter an insurer.";
  if ((creating || "premium" in input) && (!safeMoney(input.premium) || !input.premium)) fields.premium = "Enter a valid premium.";
  if ("cover" in input && input.cover != null && !safeMoney(input.cover)) fields.cover = "Enter valid cover, or leave it blank if unknown.";
  const frequency = "frequency" in input ? input.frequency : currentFrequency;
  const renewal = "renewal_date" in input ? input.renewal_date : currentRenewal;
  if ((creating || "frequency" in input) && !FREQ.includes(frequency)) fields.frequency = "Choose a policy frequency.";
  if ((creating || "renewal_date" in input || "frequency" in input) && frequency !== "one_off" && !renewal) fields.renewal_date = "Renewal date required unless one-off.";
  for (const name of ["start_date", "renewal_date", "end_date"]) if ((creating || name in input) && !validDate(input[name])) fields[name] = "Choose a real calendar date.";
  if ("lead_days" in input && input.lead_days != null && (!Array.isArray(input.lead_days) || input.lead_days.length > 3 || input.lead_days.some((n) => !Number.isInteger(n) || n < 1 || n > 365))) fields.lead_days = "Enter up to three whole reminder days from 1 to 365.";
  if ((creating || "policy_number" in input) && input.policy_number != null && typeof input.policy_number !== "string") fields.policy_number = "Enter text or leave this blank.";
  return fields;
}
function candidateRule(input) {
  const category = premiumCat();
  const date = typeof input.renewal_date === "string" && input.renewal_date && validDate(input.renewal_date) ? input.renewal_date : null;
  return { owner: "transaction", name: `${input.insurer} premium`, template: { kind: "expense", account_id: input.account_id, money: input.premium, category_id: category?.id || null, merchant: input.insurer, note: `${input.type} insurance premium` }, schedule: { freq: input.frequency === "quarterly" ? "monthly" : input.frequency, interval: input.frequency === "quarterly" ? 3 : 1, start: date || input.renewal_date || today(), anchor: date ? D.parse(date).d : null } };
}
function preflight(input, { current = null, ruleCandidate = null } = {}) {
  const effective = current ? { ...current, ...input } : input;
  const fields = policyIssues(effective, { creating: true });
  const reminders = effective.lead_days ?? settings().lead_days;
  if (!Array.isArray(reminders) || reminders.length > 3 || reminders.some((day) => !Number.isInteger(day) || day < 1 || day > 365)) fields.lead_days = "Enter up to three whole reminder days from 1 to 365.";
  let form = "";
  if (ruleCandidate) {
    if (!safeMoney(input.premium) || input.premium.amount <= 0) fields.premium = "A recurring premium must be above zero.";
    if (!A.get(ruleCandidate.template?.account_id)) fields.account = "Choose an account.";
    try { T.validateRule(ruleCandidate); } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const map = { amount: "premium", currency: "currency", account_id: "account", kind: "form", category_id: "form", freq: "frequency", interval: "frequency", start: "renewal_date", anchor: "renewal_date" };
      for (const [name, message] of Object.entries(error.fields || {})) {
        const target = map[name];
        if (target === "form") form ||= message;
        else fields[target || "form"] ||= message;
      }
    }
  }
  if (Object.keys(fields).length || form) throw new ValidationError({ fields, form });
}
export function create(input, autoPost) {
  const rule = autoPost && input.frequency !== "one_off" ? candidateRule(input) : null;
  preflight(input, { ruleCandidate: rule });
  const createdRule = rule ? T.createRule(rule) : null;
  const row = store.insert("policies", { ...input, recurring_rule_id: createdRule?.id || null, status: "active" });
  if (createdRule) T.postDue();
  return row;
}
export function update(id, patch) {
  const current = store.get("policies", id);
  if (!current) throw new ValidationError({ form: "Policy not found." });
  const rule = current.recurring_rule_id && patch.premium ? store.get("recurring_rules", current.recurring_rule_id) : null;
  const rulePatch = rule ? { template: { ...rule.template, money: patch.premium } } : null;
  preflight(patch, { current, ruleCandidate: rulePatch ? { ...rule, ...rulePatch } : null });
  const result = store.update("policies", id, patch);
  if (rulePatch) T.updateRule(rule.id, rulePatch);
  return result;
}
const advance = (d, f) => (f === "monthly" ? D.addMonths(d, 1) : f === "quarterly" ? D.addMonths(d, 3) : D.addMonths(d, 12));
export function renew(id, newPremium) {
  const p = store.get("policies", id);
  if (!p) throw new ValidationError({ form: "Policy not found." });
  if (p.frequency === "one_off") throw new ValidationError({ form: "One-off policies cannot be renewed." });
  preflight({}, { current: p });
  const premiumPatch = newPremium ? { premium: newPremium } : {};
  const rule = p.recurring_rule_id ? store.get("recurring_rules", p.recurring_rule_id) : null;
  const rulePatch = rule && newPremium ? { template: { ...rule.template, money: newPremium } } : null;
  if (newPremium) preflight(premiumPatch, { current: p, ruleCandidate: rulePatch ? { ...rule, ...rulePatch } : null });
  const patch = { ...premiumPatch, renewal_date: advance(p.renewal_date, p.frequency) };
  preflight(patch, { current: p, ruleCandidate: rulePatch ? { ...rule, ...rulePatch } : null });
  const result = store.update("policies", id, patch);
  if (rulePatch) T.updateRule(rule.id, rulePatch);
  return result;
}
export function lapse(id) {
  const p = store.get("policies", id);
  if (!p) throw new ValidationError({ form: "Policy not found." });
  preflight({ status: "lapsed" }, { current: p });
  const result = store.update("policies", id, { status: "lapsed" });
  if (p.recurring_rule_id) T.updateRule(p.recurring_rule_id, { archived_at: nowIso() });
  return result;
}
function renewFormIssues(values, policy) {
  const text = String(values.get("premium") || "").trim();
  const premium = text ? parseMoney(text, policy.premium.currency) : null, fields = {};
  if (text && !safeMoney(premium)) fields.premium = "Enter a valid premium.";
  const changed = premium && (premium.amount !== policy.premium.amount || premium.currency !== policy.premium.currency);
  if (changed && policy.recurring_rule_id && premium.amount <= 0) fields.premium = "A recurring premium must be above zero.";
  const rule = changed && policy.recurring_rule_id ? store.get("recurring_rules", policy.recurring_rule_id) : null;
  const ruleCandidate = rule ? { ...rule, template: { ...rule.template, money: premium } } : null;
  let form = "";
  try {
    preflight({}, { current: policy });
    if (premium && !fields.premium) preflight(changed ? { premium } : {}, { current: policy, ruleCandidate });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    Object.assign(fields, error.fields || {}); form = error.form || "";
  }
  return { fields, form, premium: fields.premium ? undefined : changed ? premium : undefined };
}
// How many days before a renewal to alert, and how many times. Set once in Settings; a policy can
// carry its own. No boxes filled means no renewal alerts at all.
export const DEFAULT_LEAD_DAYS = [60, 14];
export const settings = () => store.one("insurance_settings") || { lead_days: DEFAULT_LEAD_DAYS };
export const setDefaultLeadDays = (days) => store.upsertOne("insurance_settings", { lead_days: days });
export const leadDays = (p) => p.lead_days ?? settings().lead_days;
export function checkRenewals() {
  const t = today();
  for (const p of list("active")) {
    if (!p.renewal_date) continue;
    const days = D.daysBetween(t, p.renewal_date);
    const leads = leadDays(p), last = Math.min(...leads);
    for (const lead of leads) if (days <= lead && days >= 0) AL.fire({ type: "insurance_renewal", severity: lead === last ? "warn" : "info", source: { feature: "insurance", entity_id: p.id }, dedupe_key: `ins:${p.id}:${p.renewal_date}:${lead}`, title: `${p.insurer} ${p.type} renews in ${days} day${days === 1 ? "" : "s"}`, body: `Premium ${fmt(p.premium)} ${p.frequency}. Mark renewed when done.` });
    if (days < 0) AL.fire({ type: "insurance_renewal", severity: "warn", source: { feature: "insurance", entity_id: p.id }, dedupe_key: `ins:${p.id}:${p.renewal_date}:passed`, title: `${p.insurer} ${p.type}: renewal date passed`, body: "Still active until you mark it renewed or lapsed." });
  }
}
export function totals() {
  const act = list("active"), reasons = [];
  let cover = money(0, base()), perYear = money(0, base());
  for (const p of act) {
    if (!p.cover) { reasons.push(`${p.insurer}: cover not entered`); cover = null; } else { const c = fx.toBase(p.cover, base()); if (!c.money) { reasons.push(c.reason); cover = null; } else if (cover) cover = add(cover, c.money); }
    const mult = { monthly: 12, quarterly: 4, yearly: 1, one_off: 0 }[p.frequency];
    const pm = fx.toBase(p.premium, base()); if (!pm.money) { reasons.push(pm.reason); perYear = null; } else if (perYear) perYear = add(perYear, money(pm.money.amount * mult, base()));
  }
  return { cover, perYear, reasons, count: act.length };
}

export async function fromImage(file, { signal, onProgress } = {}) {
  const img = await ai.fileToImage(file, { signal }); signal?.throwIfAborted();
  onProgress?.("Matching policy details…", "generating");
  const r = await ai.call("extract_policy", { tier: "cheap", images: [img], signal, system: "Read the insurance policy document. Return texts verbatim. Unknown = null. Dates ISO. type must be one of the given list or null.", input: { currency_hint: base(), types: TYPES },
    schema: { type: "object", properties: { type: { type: ["string", "null"] }, insurer: { type: ["string", "null"] }, policy_number: { type: ["string", "null"] }, cover_text: { type: ["string", "null"] }, premium_text: { type: ["string", "null"] }, frequency: { type: ["string", "null"] }, start_date: { type: ["string", "null"] }, renewal_date: { type: ["string", "null"] }, insured: { type: ["string", "null"] } } },
    validate: (o) => (o.type && !TYPES.includes(o.type) ? "type not in list" : o.frequency && !FREQ.includes(o.frequency) ? "frequency invalid" : null) });
  return r;
}

export function insurancePage() {
  const ps = list(), tot = totals();
  const card = (p) => `<div class="card"><div class="row"><div class="grow"><div class="title">${esc(p.insurer)} · ${cap(p.type)}<span class="tag">${cap(p.status)}</span></div>
    <div class="sub">premium ${fmt(p.premium)} ${cap(p.frequency)} · cover ${p.cover ? fmt(p.cover) : "—"} · renews ${D.fmtDate(p.renewal_date)}${p.renewal_date ? ` · ${leadDays(p).length ? "reminders " + leadDays(p).join(" and ") + " days before" : "no reminders"}` : ""}${p.policy_number ? " · #" + esc(p.policy_number) : ""}${p.insured ? " · " + esc(p.insured) : ""}${p.recurring_rule_id ? " · auto-posts" : ""}</div></div></div>
    <div class="actions">${p.status === "active" ? `${p.frequency !== "one_off" ? `<button class="small" data-renew="${p.id}">Mark renewed</button>` : ""}<button class="small" data-lapse="${p.id}">Not renewing</button>` : ""}<button class="small" data-edit="${p.id}">Edit</button><button class="small danger" data-archive="${p.id}">Archive</button></div></div>`;
  return {
    title: "Insurance",
    html: html`<div class="grid2"><div class="stat"><div class="label">Premiums per year</div><div class="value">${tot.perYear ? fmt(tot.perYear) : "—"}</div></div><div class="stat"><div class="label">Total cover</div><div class="value">${tot.cover ? fmt(tot.cover) : "—"}</div><div class="sub">${tot.reasons[0] || ""}</div></div></div>${raw(rateLinks(tot.reasons))}
      <div data-operation-root><div class="actions"><button class="primary" data-action="new">+ Policy</button>${ai.enabled() ? raw(`<label class="btn">${icon("camera", { size: 17 })} Policy photo <input type="file" accept="image/*" data-action="photo" hidden /></label>`) : ""}</div><div data-operation-status class="operation-status" role="status" aria-live="polite"></div></div>
      ${ps.length ? raw(ps.map(card).join("")) : raw(`<div class="empty">No policies. Track type, insurer, cover, premium and renewal date. Renewal alerts ${settings().lead_days.length ? `${settings().lead_days.join(" and ")} days before` : "are off"}; change that in Settings.</div>`)}
      <p class="muted">Tracking only. No gap or adequacy judgement.</p>`,
    bind(root) {
      root.querySelector("[data-action=new]").onclick = () => policyModal();
      // Rebind the same job after redraw so status and departure cleanup stay connected.
      let photoOperation = createOperation({ root: root.querySelector("[data-operation-root]"), key: "insurance.policy-photo", ownerGeneration: store.generation() });
      const photoInput = root.querySelector("[data-action=photo]");
      photoInput?.addEventListener("change", async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const pageHash = location.hash, operation = createOperation({ root: root.querySelector("[data-operation-root]"), key: "insurance.policy-photo", ownerGeneration: store.generation() });
        photoOperation = operation;
        if (!operation.start("Reading policy…", "reading")) return;
        try {
          const r = await fromImage(file, { signal: operation.signal, onProgress: (message, phase) => operation.progress(message, phase) });
          if (!operation.active() || !root.isConnected || location.hash !== pageHash) return;
          operation.succeed("Policy read. Nothing is saved until you confirm.");
          policyModal({ type: r.type, insurer: r.insurer, policy_number: r.policy_number, cover_text: r.cover_text, premium_text: r.premium_text, frequency: r.frequency, start_date: r.start_date, renewal_date: r.renewal_date, insured: r.insured, fromAi: true });
        } catch { if (operation.active()) operation.fail("Could not read this policy.", "Choose another image or enter the details manually."); }
        finally { if (photoInput.isConnected) photoInput.value = ""; }
      });
      root.querySelectorAll("[data-renew]").forEach((b) => (b.onclick = () => { const p = store.get("policies", b.dataset.renew); const dialog = modal({ title: "Mark renewed", body: field("New premium (blank = unchanged)", moneyInput("premium", "", toDecimalString(p.premium))), submitLabel: "Renewed", onSubmit: (f) => { const parsed = renewFormIssues(f, p); if (Object.keys(parsed.fields).length || parsed.form) throw new ValidationError({ fields: parsed.fields, form: parsed.form }); renew(p.id, parsed.premium); toast(`Next renewal ${D.fmtDate(store.get("policies", p.id).renewal_date)}`); } }); bindValidation(dialog.form, { validate: (values) => renewFormIssues(values, p) }); }));
      root.querySelectorAll("[data-lapse]").forEach((b) => (b.onclick = () => modal({ title: "Not renewing?", body: "<p>Marks the policy lapsed, ends its premium rule, clears alerts. History kept.</p>", submitLabel: "Lapse", danger: true, onSubmit: () => lapse(b.dataset.lapse) })));
      root.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => policyModal(store.get("policies", b.dataset.edit), true)));
      root.querySelectorAll("[data-archive]").forEach((b) => (b.onclick = () => modal({ title: "Archive policy?", body: "<p>Hidden. History kept.</p>", submitLabel: "Archive", danger: true, onSubmit: () => update(b.dataset.archive, { status: "archived" }) })));
      return ({ reason = "navigate" } = {}) => { if (reason !== "redraw") photoOperation?.dispose(reason); };
    },
  };
}
function policyFormIssues(values, pre, existing) {
  const fields = {}, currency = values.get("currency"), premiumText = String(values.get("premium") || ""), coverText = String(values.get("cover") || "");
  const premium = premiumText.trim() ? parseMoney(premiumText, currency) : null, cover = coverText.trim() ? parseMoney(coverText, currency) : null;
  const lead = [];
  for (const i of [0, 1, 2]) { const text = String(values.get(`lead${i}`) || "").trim(); if (!text) continue; const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 365) fields[`lead${i}`] = "Enter a whole number from 1 to 365."; else lead.push(n); }
  const leadDays = [...new Set(lead)].sort((a,b)=>b-a), input = { type: values.get("type"), insurer: values.get("insurer"), policy_number: values.get("policy_number") || null, insured: values.get("insured") || null, premium, frequency: values.get("frequency"), cover, start_date: values.get("start_date") || null, renewal_date: values.get("renewal_date") || null, end_date: values.get("end_date") || null, lead_days: String(leadDays) === String(settings().lead_days) ? null : leadDays, notes: values.get("notes") || null, account_id: values.get("account") || null };
  if (premiumText.trim() && !premium) fields.premium = "Enter a valid premium.";
  if (coverText.trim() && !cover) fields.cover = "Enter valid cover, or leave it blank if unknown.";
  if (!CURRENCIES.includes(currency)) fields.currency = "Choose a supported currency.";
  const changed = {};
  for (const name of ["type", "insurer", "policy_number", "insured", "premium", "frequency", "cover", "start_date", "renewal_date", "end_date", "lead_days", "notes"]) {
    const before = pre[name];
    const same = name === "premium" || name === "cover" ? (!input[name] && !before || input[name]?.amount === before?.amount && input[name]?.currency === before?.currency) : (input[name] ?? null) === (before ?? null);
    if (!existing || !same) changed[name] = input[name];
  }
  const submitted = existing ? Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "account_id")) : input;
  const currentRule = existing && pre.recurring_rule_id ? store.get("recurring_rules", pre.recurring_rule_id) : null;
  const ruleCandidate = !existing && values.get("autopost") === "on" && input.frequency !== "one_off"
    ? candidateRule(input)
    : currentRule && "premium" in changed ? { ...currentRule, template: { ...currentRule.template, money: changed.premium } } : null;
  let form = "";
  try { preflight(submitted, { current: existing ? pre : null, ruleCandidate }); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    Object.assign(fields, error.fields || {});
    form = error.form || "";
  }
  if (fields.lead_days) { fields.lead0 ||= fields.lead_days; delete fields.lead_days; }
  return { fields, form, input: submitted };
}
function policyModal(pre = {}, existing = false) {
  const cur = pre.premium?.currency || base();
  const dialog = modal({ title: existing ? "Edit policy" : "New policy", submitLabel: existing ? "Save" : "Save policy",
    body: `${pre.fromAi ? '<p class="ai-note">Pre-filled from the photo. Every field is a proposal. Blanks stay blank.</p>' : ""}<div class="inline">${field("Type", sel("type", TYPES, pre.type || "health", (t) => t.replace("_", " ")))}${field("Insurer", inp("insurer", { value: pre.insurer || "", required: true }))}</div>
      <div class="inline">${field("Policy number", inp("policy_number", { value: pre.policy_number || "" }))}${field("Insured", inp("insured", { value: pre.insured || "", placeholder: "self" }))}</div>
      <div class="inline">${field("Currency", sel("currency", CURRENCIES, cur))}${field("Premium", moneyInput("premium", pre.premium ? toDecimalString(pre.premium) : pre.premium_text || ""))}${field("Frequency", sel("frequency", FREQ, pre.frequency || "yearly", (f) => f.replace("_", "-")))}</div>
      ${field("Cover / sum assured (blank = unknown)", moneyInput("cover", pre.cover ? toDecimalString(pre.cover) : pre.cover_text || ""))}
      <div class="inline">${field("Start date", inp("start_date", { type: "date", value: pre.start_date || "" }))}${field("Renewal date", inp("renewal_date", { type: "date", value: pre.renewal_date || "" }))}${field("End date", inp("end_date", { type: "date", value: pre.end_date || "" }))}</div>
      ${numberBoxes("lead", pre.lead_days ?? settings().lead_days, { placeholder: "days", label: "Renewal reminder", legend: "Days before renewal" })}<div class="hint">Up to three reminders. Clear every box for none. Your default is ${settings().lead_days.length ? settings().lead_days.join(" and ") + " days" : "no reminders"}, set in Settings.</div>
      ${existing ? "" : `<label><input type="checkbox" name="autopost" /> Post the premium as a recurring expense (Bills › Insurance premiums)</label>${field("From account", sel("account", A.active(), A.active()[0]?.id, (a) => a.name, (a) => a.id))}`}${field("Notes", inp("notes", { value: pre.notes || "" }))}`,
    onSubmit: (f) => {
      const parsed = policyFormIssues(f, pre, existing);
      if (Object.keys(parsed.fields).length || parsed.form) throw new ValidationError({ fields: parsed.fields, form: parsed.form });
      const input = parsed.input;
      if (existing) update(pre.id, input);
      else create(input, f.get("autopost") === "on");
      checkRenewals(); toast("Saved");
    } });
  bindValidation(dialog.form, { validate: (values) => policyFormIssues(values, pre, existing), dependencies: { currency: ["premium", "cover"], frequency: ["renewal_date", "account", "premium"], autopost: ["account", "premium", "renewal_date"] } });
}

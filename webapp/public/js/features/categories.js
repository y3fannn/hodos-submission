// Categories: seed list, merchant rules, suggest (rule → AI → blank), merge, unlock prompt.
import { store, nowIso } from "../lib/store.js";
import { html, raw, esc, modal, field, inp, sel, toast, ValidationError, bindValidation } from "../lib/ui.js";
import * as ai from "../lib/ai.js";
import { icon as drawIcon } from "../lib/icons.js";

export const SEED = {
  expense: {
    "Food": ["Groceries", "Restaurants", "Coffee & snacks", "Delivery"],
    "Transport": ["Public transport", "Taxi & ride-hail", "Fuel", "Parking & tolls", "Vehicle upkeep"],
    "Housing": ["Rent", "Mortgage", "Maintenance", "Furniture & appliances"],
    "Bills & utilities": ["Electricity & gas", "Water", "Internet & phone", "Subscriptions", "Insurance premiums"],
    "Health": ["Doctor & dental", "Pharmacy", "Fitness"],
    "Shopping": ["Clothing", "Electronics", "Home goods", "Beauty & personal care"],
    "Entertainment": ["Movies & events", "Games & hobbies", "Books & media", "Nightlife"],
    "Travel": ["Flights", "Accommodation", "Transport abroad", "Activities"],
    "Education": ["Tuition & fees", "Courses", "Books & supplies"],
    "Family & pets": ["Childcare", "Kids", "Pets", "Eldercare"],
    "Giving": ["Donations", "Gifts given", "Family support"],
    "Fees & taxes": ["Bank fees", "Interest & late fees", "Income tax", "Other taxes"],
  },
  income: {
    "Salary": ["Base pay", "Bonus", "Overtime & allowances"],
    "Business & freelance": ["Client payments", "Sales"],
    "Investment income": ["Dividends", "Interest", "Rental income"],
    "Gifts & refunds": ["Gifts received", "Refunds & reimbursements", "Cashback & rewards"],
    "Other income": ["Government payments", "Prizes", "Sold items"],
  },
};
// One drawn icon per group, as ruled on 2026-09-17. A name here is a key into the app's icon
// set, never a glyph: an emoji is somebody else's artwork and cannot take the app's colour.
const ICON = { Food: "food", Transport: "transport", Housing: "housing", "Bills & utilities": "bills", Health: "health", Shopping: "shopping", Entertainment: "entertainment", Travel: "travel", Education: "education", "Family & pets": "family", Giving: "giving", "Fees & taxes": "fees", Salary: "salary", "Business & freelance": "business", "Investment income": "investments", "Gifts & refunds": "refunds", "Other income": "otherincome" };
export const icon = (c, size = 18) => drawIcon((c && (ICON[c.name] || ICON[parentOf(c)?.name])) || "dot", { size });

export function seedCategories() {
  if (store.all("categories").length) return;
  for (const kind of ["expense", "income"]) {
    for (const [group, subs] of Object.entries(SEED[kind])) {
      const g = store.insert("categories", { name: group, kind, parent_id: null, seed_key: `${kind}:${group}`, merged_into_id: null, archived_at: null });
      for (const s of subs) store.insert("categories", { name: s, kind, parent_id: g.id, seed_key: `${kind}:${group}:${s}`, merged_into_id: null, archived_at: null });
    }
  }
}
const subsOn = () => Boolean(store.one("profile")?.subcategories_enabled);
export const all = () => store.all("categories").filter((c) => !c.merged_into_id && !c.archived_at);
export const get = (id) => (id ? store.get("categories", id) : null);
export const parentOf = (c) => (c?.parent_id ? get(c.parent_id) : null);
export const groupOf = (c) => (c ? parentOf(c) || c : null);
export const groupIdOf = (id) => groupOf(get(id))?.id || null;
export const isGroup = (c) => !c.parent_id;
export const children = (id) => all().filter((c) => c.parent_id === id);

// Rows at the enabled level.
export function list(kind) {
  return all().filter((c) => (!kind || c.kind === kind) && (subsOn() || isGroup(c))).sort((a, b) => label(a).localeCompare(label(b)));
}
export function label(c) { if (!c) return "Uncategorised"; const p = parentOf(c); return p ? `${p.name} › ${c.name}` : c.name; }
export const labelId = (id) => (id ? label(get(id)) : "Uncategorised");
export const subtreeIds = (id) => [id, ...children(id).map((c) => c.id)];

export function normaliseMerchant(m) {
  return String(m || "").toLowerCase().replace(/[\d]/g, "").replace(/[^\p{L}\s]/gu, " ").replace(/\b(pte|ltd|inc|llc|co|limited|corp)\b/g, "").replace(/\s+/g, " ").trim();
}
export function ruleFor(merchant) {
  const key = normaliseMerchant(merchant);
  if (!key) return null;
  return store.all("merchant_rules").find((r) => r.merchant_key === key) || null;
}
export function learn(merchant, categoryId) {
  const key = normaliseMerchant(merchant);
  if (!key || !categoryId) return;
  const r = ruleFor(merchant);
  if (r) store.update("merchant_rules", r.id, { category_id: categoryId, hits: r.hits + 1, last_used_at: nowIso() });
  else store.insert("merchant_rules", { merchant_key: key, category_id: categoryId, hits: 1, last_used_at: nowIso() });
}

// suggest → {categoryId?, source: rule|ai|none, confidence?}
export async function suggest(merchant, note, kind, options = {}) {
  const r = ruleFor(merchant);
  if (r && get(r.category_id) && get(r.category_id).kind === kind) return { categoryId: r.category_id, source: "rule" };
  if (!merchant || !ai.enabled()) return { source: "none" };
  const res = await suggestBatch([{ merchant, note, kind }], options);
  return res[0];
}
export async function suggestBatch(items, { signal } = {}) {
  const out = items.map((it) => { const r = ruleFor(it.merchant); return r && get(r.category_id)?.kind === it.kind ? { categoryId: r.category_id, source: "rule" } : null; });
  const todo = items.map((it, i) => ({ it, i })).filter(({ it, i }) => !out[i] && it.merchant);
  if (!todo.length || !ai.enabled()) return out.map((o) => o || { source: "none" });
  const cats = list().map((c) => ({ id: c.id, name: c.name, parent: parentOf(c)?.name, kind: c.kind }));
  try {
    const res = await ai.call("classify_category", {
      tier: "cheap", signal,
      system: "Pick the best category id for each item from the list, or null. Match kind (expense/income). Do not invent ids.",
      input: { items: todo.map(({ it }) => ({ merchant: it.merchant, note: it.note || undefined, kind: it.kind })), categories: cats },
      schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["category_id", "confidence"], properties: { category_id: { type: ["string", "null"] }, confidence: { type: "string", enum: ["low", "medium", "high"] } } } } } },
      validate: (o) => (!ai.checkSchema(o, { type: "object", required: ["items"], properties: { items: { type: "array" } } }) ? "shape" : o.items.length !== todo.length ? "count" : o.items.some((x, j) => x.category_id && (!get(x.category_id) || get(x.category_id).kind !== todo[j].it.kind)) ? "id or kind invalid" : null),
    });
    res.items.forEach((x, j) => (out[todo[j].i] = x.category_id ? { categoryId: x.category_id, source: "ai", confidence: x.confidence } : { source: "none" }));
  } catch (e) {
    if (!signal?.aborted && e.code !== "ACCOUNT_CHANGED") toast(e.message);
  }
  return out.map((o) => o || { source: "none" });
}

export function collectName(name) {
  const value = typeof name === "string" ? name.trim() : "", fields = {};
  if (!value) fields.name = "Enter a category name.";
  return { value, issues: { fields } };
}
export function collectCreate(name, kind, parentId = null) {
  const candidate = collectName(name), parent = parentId ? get(parentId) : null;
  const fields = { ...candidate.issues.fields };
  if (!["expense", "income"].includes(kind)) fields.kind = "Choose expense or income.";
  if (parentId && (!parent || !isGroup(parent) || !["expense", "income"].includes(parent.kind))) fields.parent = "Choose an existing group.";
  else if (parent && kind !== parent.kind) fields.parent = "Choose a group with the selected kind.";
  return { candidate: { name: candidate.value, kind: parent?.kind || kind, parentId: parent?.id || null }, issues: { fields } };
}
export function collectRename(id, name) {
  const candidate = collectName(name), fields = { ...candidate.issues.fields };
  if (!get(id)) fields.name = "This category is no longer available.";
  return { candidate: { id, name: candidate.value }, issues: { fields } };
}
export function collectMerge(sourceId, targetId) {
  const source = get(sourceId), target = get(targetId), fields = {};
  if (!source) fields.source = "Choose an existing source category.";
  if (!target) fields.target = "Choose an existing target category.";
  if (source && target) {
    if (source.id === target.id) fields.target = "Choose a different category.";
    else if (source.kind !== target.kind) fields.target = "Choose a category of the same kind.";
    else if (target.parent_id === source.id) fields.target = "A category cannot merge into its own subcategory.";
    else if (isGroup(source) && target.parent_id) fields.target = "A group can only merge into another group.";
  }
  return { candidate: { source, target }, issues: { fields } };
}
const requireValid = ({ candidate, issues }) => {
  if (Object.keys(issues.fields).length) throw new ValidationError(issues);
  return candidate;
};
export function create(name, kind, parentId = null) {
  const c = requireValid(collectCreate(name, kind, parentId));
  return store.insert("categories", { name: c.name, kind: c.kind, parent_id: c.parentId, seed_key: null, merged_into_id: null, archived_at: null });
}
export function rename(id, name) {
  const c = requireValid(collectRename(id, name));
  return store.update("categories", c.id, { name: c.name });
}
// Targets that §5 allows. A refused pairing is never offered.
export function mergeTargets(sourceId) {
  const s = get(sourceId); if (!s) return [];
  // Group → groups only (group into a subcategory would need a third level).
  // Subcategory → any group, or any other subcategory, siblings included.
  return all().filter((t) => t.id !== s.id && t.kind === s.kind && (isGroup(s) ? isGroup(t) : true));
}
// Plain sentence describing the outcome, built before anything moves.
export function mergePreview(sourceId, targetId) {
  const s = get(sourceId), t = get(targetId);
  if (!s || !t) return null;
  const ids = subtreeIds(s.id);
  const txCount = store.all("transactions").filter((x) => ids.includes(x.category_id)).length;
  const ruleCount = store.all("merchant_rules").filter((x) => ids.includes(x.category_id)).length;
  const kids = children(s.id);
  const parts = [];
  parts.push(`${txCount} transaction${txCount === 1 ? "" : "s"} and ${ruleCount} merchant rule${ruleCount === 1 ? "" : "s"} move from ${label(s)} to ${label(t)}.`);
  if (kids.length) parts.push(`${kids.length} subcategor${kids.length === 1 ? "y" : "ies"} (${kids.map((k) => k.name).join(", ")}) move under ${t.name}, staying one level down.`);
  parts.push(`${label(s)} is then hidden. Your totals do not change, and no new level is created.`);
  return { text: parts.join(" "), txCount, ruleCount, kids: kids.length };
}

export function merge(sourceId, targetId) {
  const { source: s, target: t } = requireValid(collectMerge(sourceId, targetId));
  for (const tx of store.all("transactions").filter((x) => x.category_id === s.id)) store.update("transactions", tx.id, { category_id: t.id });
  for (const r of store.all("merchant_rules").filter((x) => x.category_id === s.id)) store.update("merchant_rules", r.id, { category_id: t.id });
  for (const c of children(s.id)) store.update("categories", c.id, { parent_id: t.id });
  // budgets follow (budgets.md)
  const sb = store.all("budgets").find((b) => b.category_id === s.id && !b.archived_at);
  const tb = store.all("budgets").find((b) => b.category_id === t.id && !b.archived_at);
  if (sb) { if (tb) store.update("budgets", sb.id, { archived_at: nowIso() }); else store.update("budgets", sb.id, { category_id: t.id }); }
  store.update("categories", s.id, { merged_into_id: t.id });
}
export function archive(id) {
  const used = store.all("transactions").some((x) => x.category_id === id);
  for (const b of store.all("budgets").filter((b) => b.category_id === id)) store.update("budgets", b.id, { archived_at: nowIso() });
  if (used) store.update("categories", id, { archived_at: nowIso() }); else store.softDelete("categories", id);
}

// One-time unlock prompt after 10 confirmed transactions.
export function checkUnlock() {
  // Never replace a confirmation/save/retry dialog with optional onboarding.
  // Successful transaction/import completion checks again after its dialog closes.
  if (typeof document !== "undefined" && document.querySelector('[data-modal-form]')) return;
  if (store.persistenceState().error) return;
  const p = store.one("profile");
  if (!p || p.subcategories_enabled || p.subcategory_prompt_shown_at) return;
  const n = store.all("transactions").filter((t) => t.confirmed_at && t.kind !== "transfer").length;
  if (n < 10) return;
  store.update("profile", p.id, { subcategory_prompt_shown_at: nowIso() });
  modal({ title: "Turn on subcategories?", body: "<p>You have logged 10 transactions. Subcategories (Food › Groceries, Food › Restaurants…) allow deeper analysis. They stay optional per transaction. You can change this later in Settings.</p>", submitLabel: "Turn on", cancelLabel: "Not now", onSubmit: () => { store.update("profile", p.id, { subcategories_enabled: true }); toast("Subcategories on"); } });
}

export function mergeModal(sourceId) {
  const s = get(sourceId);
  const targets = mergeTargets(sourceId);
  if (!targets.length) return toast(`Nothing to merge ${s.name} into. A group can only merge into another group.`);
  const m = modal({ title: `Merge "${s.name}" into…`, submitLabel: "Merge",
    body: field("Keep everything under", sel("target", targets, targets[0].id, label, (c) => c.id))
      + `<div class="card" data-preview></div>`
      + `<p class="hint">${isGroup(s) ? "A group can only merge into another group." : "A subcategory can merge into any group, or into any other subcategory."} There is no third level, and merging never makes one.</p>`,
    onSubmit: (f) => { merge(s.id, f.get("target")); toast("Merged"); } });
  bindValidation(m.form, { validate: values => collectMerge(s.id, values.get("target")).issues });
  const draw = () => { const p = mergePreview(s.id, m.form.target.value); m.form.querySelector("[data-preview]").textContent = p ? p.text : ""; };
  m.form.target.onchange = draw; draw();
}

export function categoriesPage() {
  const groups = (kind) => all().filter((c) => c.kind === kind && isGroup(c)).sort((a, b) => a.name.localeCompare(b.name));
  // The name gets the whole width; its buttons sit underneath, so a long name is never cut short.
  const block = (kind) => groups(kind).map((g) => `<div class="stack-row"><div class="title">${icon(g)} ${esc(g.name)}${g.seed_key ? "" : '<span class="tag">custom</span>'}</div>
      <div class="sub">${esc(children(g.id).map((c) => c.name).join(" · ") || "No subcategories")}</div>
      <div class="actions"><button class="small" data-rename="${g.id}">Rename</button><button class="small" data-merge="${g.id}">Merge</button><button class="small" data-archive="${g.id}">Archive</button></div></div>`).join("");
  const rules = store.all("merchant_rules").sort((a, b) => b.hits - a.hits).slice(0, 15);
  return {
    title: "Categories",
    html: html`<div class="card"><p class="muted">Subcategories are ${subsOn() ? "on" : "off (unlock prompt appears after 10 transactions, or turn on in Settings)"}.</p>
      <div class="actions"><button class="primary" data-action="new">＋ New category</button></div></div>
      <div class="card"><h2>Expense</h2>${raw(block("expense"))}</div>
      <div class="card"><h2>Income</h2>${raw(block("income"))}</div>
      <div class="card"><h2>Merchant memory</h2><p class="muted">Merchants you confirmed before. Rule beats AI. A correction rewrites the rule.</p>
      ${rules.length ? raw(`<table><tr><th>Merchant</th><th>Category</th><th class="num">Hits</th></tr>${rules.map((r) => `<tr><td>${esc(r.merchant_key)}</td><td>${esc(labelId(r.category_id))}</td><td class="num">${r.hits}</td></tr>`).join("")}</table>`) : raw('<div class="empty">Nothing learned yet.</div>')}</div>`,
    bind(root) {
      root.querySelector("[data-action=new]").onclick = () => {
        const m = modal({ title: "New category", body: field("Name", inp("name", { required: true })) + field("Kind", sel("kind", ["expense", "income"])) + field("Under group (optional)", sel("parent", [{ id: "", name: "— none (new group)" }, ...all().filter(isGroup)], "", (c) => `${c.name}${c.id ? ` (${c.kind})` : ""}`, (c) => c.id)), onSubmit: (f) => { create(f.get("name"), f.get("parent") ? get(f.get("parent")).kind : f.get("kind"), f.get("parent") || null); toast("Created"); } });
        const inheritKind = () => { const parent = get(m.form.parent.value); if (parent) m.form.kind.value = parent.kind; m.form.kind.disabled = Boolean(parent); };
        m.form.parent.addEventListener("change", inheritKind);
        bindValidation(m.form, { validate: values => collectCreate(values.get("name"), get(values.get("parent"))?.kind || values.get("kind"), values.get("parent")).issues, dependencies: { parent: ["kind"], kind: ["parent"] } });
      };
      root.querySelectorAll("[data-rename]").forEach((b) => (b.onclick = () => { const c = get(b.dataset.rename); const m = modal({ title: "Rename", body: field("Name", inp("name", { value: c?.name || "", required: true })), onSubmit: (f) => { rename(c?.id || b.dataset.rename, f.get("name")); } }); bindValidation(m.form, { validate: values => collectRename(c?.id || b.dataset.rename, values.get("name")).issues }); }));
      root.querySelectorAll("[data-merge]").forEach((b) => (b.onclick = () => mergeModal(b.dataset.merge)));
      root.querySelectorAll("[data-archive]").forEach((b) => (b.onclick = () => { const c = get(b.dataset.archive); modal({ title: `Archive "${c.name}"?`, body: "<p>Hidden from pickers. History kept.</p>", submitLabel: "Archive", danger: true, onSubmit: () => archive(c.id) }); }));
    },
  };
}

// Net worth: assets − liabilities in base, extras, immutable snapshots, history chart.
import { store, nowIso } from "../lib/store.js";
import { money, isMoney, fmt, fmtSplit, parseMoney, add, neg, CURRENCIES, toDecimalString, exponent } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, moneyInput, esc, lineChart, bindCharts, bindValidation, partBar, stackedNetWorthChart, heroAmount, cap, rateLinks, ValidationError } from "../lib/ui.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as H from "./investments.js";
import * as DB from "./debts.js";

export const EXTRA_TYPES = ["property", "vehicle", "other_asset", "other_liability"];
export const extras = () => store.all("nw_extras").filter((e) => !e.archived_at);
const extraDate = (value) => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && (() => { const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value; })();
export function collectExtra(input) {
  const fields = {}, name = input.name, type = input.type, value = input.value, as_of = input.as_of;
  if (typeof name !== "string" || !name.trim()) fields.name = "Enter a name.";
  if (!EXTRA_TYPES.includes(type)) fields.type = "Choose a valid type.";
  if (!isMoney(value) || !Number.isSafeInteger(value.amount) || !CURRENCIES.includes(value.currency)) fields.value = "Enter a valid amount and supported currency.";
  if (!extraDate(as_of)) fields.as_of = "Enter a real date.";
  if (Object.keys(fields).length) throw new ValidationError({ fields });
  return { name: name.trim(), type, value: money(value.amount, value.currency), as_of };
}
export const createExtra = (name, type, value, asOf) => store.insert("nw_extras", { ...collectExtra({ name, type, value, as_of: asOf }), archived_at: null });
export function updateExtra(id, patch) {
  const current = store.get("nw_extras", id);
  if (!current) throw new ValidationError({ form: "This item is no longer available." });
  const merged = collectExtra({ ...current, ...patch });
  return store.update("nw_extras", id, merged);
}
export const archiveExtra = (id) => store.update("nw_extras", id, { archived_at: nowIso() });

export function now() {
  const b = base(), reasons = [], rates = [];
  const comp = { accounts: money(0, b), credit: money(0, b), holdings: money(0, b), debts: money(0, b), extras_assets: money(0, b), extras_liabilities: money(0, b) };
  const detail = { accounts: [], credit: [], holdings: [], debts: [], extras: [] };
  const conv = (m, label) => { if (!m) { reasons.push(`${label}: no value`); return null; } const c = fx.toBase(m, b); if (!c.money) { reasons.push(`${label}: ${c.reason}`); return null; } if (c.rate) rates.push({ from: m.currency, to: b, rate: c.rate.rate, as_of: c.rate.fetched_at }); return c.money; };
  const acc = (key, v) => { if (v === null) comp[key] = null; else if (comp[key]) comp[key] = add(comp[key], v); };
  for (const a of A.list(true)) { const bal = A.balance(a.id); const v = conv(bal, a.name); if (a.type === "credit") { detail.credit.push({ name: a.name, money: bal, base: v, archived: a.archived_at }); acc("credit", v === null ? null : neg(v)); } else { detail.accounts.push({ name: a.name, money: bal, base: v, archived: a.archived_at }); acc("accounts", v); } }
  const hs = H.summary(); for (const r of hs.rows) { detail.holdings.push({ name: r.h.name, money: r.p.latestValue, base: r.baseVal, asOf: r.p.asOf }); if (!r.baseVal) { reasons.push(...hs.incomplete_reasons); comp.holdings = null; } else { acc("holdings", r.baseVal); const rate = fx.liveRate(r.h.currency, b); if (rate && r.h.currency !== b) rates.push({ from: r.h.currency, to: b, rate: rate.rate, as_of: rate.fetched_at }); } }
  for (const d of DB.list("active")) { if (DB.isLinked(d)) continue; const v = conv(DB.balanceOf(d), d.name); detail.debts.push({ name: d.name, money: DB.balanceOf(d), base: v }); acc("debts", v); }
  for (const e of extras()) { const v = conv(e.value, e.name); detail.extras.push({ ...e, base: v }); acc(e.type === "other_liability" ? "extras_liabilities" : "extras_assets", v); }
  const assets = [comp.accounts, comp.holdings, comp.extras_assets], liabs = [comp.credit, comp.debts, comp.extras_liabilities];
  const total = [...assets, ...liabs].every(Boolean) ? money(assets.reduce((s, m) => s + m.amount, 0) - liabs.reduce((s, m) => s + m.amount, 0), b) : null;
  const oldest = rates.map((r) => r.as_of).sort()[0] || null;
  return { total, components: comp, detail, incomplete_reasons: [...new Set(reasons)], rates_used: [...new Map(rates.map((r) => [`${r.from}|${r.to}`, r])).values()], oldest_rate_as_of: oldest, base_currency: b, holdingsAsOf: hs.oldestAsOf };
}
export function takeSnapshot(trigger) { const n = now(); return store.insert("nw_snapshots", { taken_at: nowIso(), trigger, base_currency: n.base_currency, components: n.components, total: n.total, incomplete_reasons: n.incomplete_reasons, rates_used: n.rates_used }); }
export const snapshots = () => store.all("nw_snapshots").sort((a, b) => a.taken_at.localeCompare(b.taken_at));
// The monthly snapshot falls on a day the user picks, the 1st unless changed. The snapshot month runs
// from that day to the day before it next month, and the first open inside it takes the snapshot.
export const settings = () => store.one("nw_settings") || { snapshot_day: 1 };
export function setSnapshotDay(day) {
  const numeric = typeof day === 'number' || typeof day === 'string';
  const value = numeric && String(day).trim() !== '' ? Number(day) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new ValidationError({ fields: { snapshot_day: 'Enter a whole day from 1 to 31.' } });
  return store.upsertOne('nw_settings', { snapshot_day: value });
}
export function monthlyDue() {
  const m = D.budgetMonth(today(), settings().snapshot_day);
  if (!snapshots().some((s) => s.trigger === "monthly" && D.inRange(s.taken_at.slice(0, 10), m)) && store.all("accounts").length) takeSnapshot("monthly");
}
export const lastMonthly = () => snapshots().filter((s) => s.trigger === "monthly").slice(-1)[0] || null;
// "Change since the last snapshot" is meaningless on a day one was already taken, because the answer
// is always zero. This is the last one from an earlier day, which is what the sentence means.
export const priorMonthly = () => snapshots().filter((s) => s.trigger === "monthly" && s.taken_at.slice(0, 10) < today()).slice(-1)[0] || null;

// The same snapshots as two bands, everything owned and everything owed, behind the net worth line,
// so the line has visible causes without six colours competing for the eye (ruled 2026-09-19).
// Every snapshot is drawn, monthly and "snapshot now" alike: a point is a point.
const inView = () => { const b = base(); return snapshots().filter((s) => s.total && s.base_currency === b); };
export function composition() {
  const b = base(), rows = inView();
  const at = (c, k) => (c && c[k] ? c[k].amount : 0) / 10 ** exponent(b);
  const spanC = rows.length ? D.daysBetween(rows[0].taken_at.slice(0, 10), rows[rows.length - 1].taken_at.slice(0, 10)) : 0;
  return rows.map((s) => ({
    x: D.fmtAxis(s.taken_at.slice(0, 10), spanC),
    up: [{ label: "Assets", value: Math.max(0, at(s.components, "accounts") + at(s.components, "holdings") + at(s.components, "extras_assets")) }],
    down: [{ label: "Liabilities", value: Math.max(0, at(s.components, "credit") + at(s.components, "debts") + at(s.components, "extras_liabilities")) }],
    net: s.total.amount / 10 ** exponent(b),
  }));
}

// History line. Amount, or percent change against the first point in view.
export function series(mode = "amount") {
  const b = base();
  const rows = inView();
  if (!rows.length) return { points: [], reason: "no snapshots in your current base currency yet" };
  const span = D.daysBetween(rows[0].taken_at.slice(0, 10), rows[rows.length - 1].taken_at.slice(0, 10));
  const label = (s) => D.fmtAxis(s.taken_at.slice(0, 10), span);
  if (mode === "percent") {
    const first = rows[0].total.amount;
    if (first <= 0) return { points: [], reason: "percent needs a first snapshot above zero" };
    return { points: rows.map((s) => ({ x: label(s), y: ((s.total.amount - first) / first) * 100 })), reason: null };
  }
  return { points: rows.map((s) => ({ x: label(s), y: s.total.amount / 10 ** exponent(b) })), reason: null };
}

// ---------- pages ----------
// The net worth page is the number, its history, and two folders: what you own and what you owe.
// Everything else lives one tap in, so the first screen is never a wall (ruled 2026-09-19).
const sumOf = (list, b) => money(list.reduce((t, x) => t + (x ? x.amount : 0), 0), b);
function parts(n) {
  const b = base(), c = n.components;
  const assets = [{ key: "accounts", label: "Accounts", m: c.accounts }, { key: "holdings", label: "Investments", m: c.holdings }, { key: "extras_assets", label: "Property, vehicles and other", m: c.extras_assets }];
  const liabs = [{ key: "credit", label: "Credit cards", m: c.credit }, { key: "debts", label: "Loans", m: c.debts }, { key: "extras_liabilities", label: "Other owed", m: c.extras_liabilities }];
  return { assets, liabs, assetTotal: assets.some((x) => !x.m) ? null : sumOf(assets.map((x) => x.m), b), liabTotal: liabs.some((x) => !x.m) ? null : sumOf(liabs.map((x) => x.m), b) };
}
const folder = (href, title, total, names) => `<a class="card folder" href="${href}"><div class="grow"><div class="folder-title">${title}</div><div class="sub">${esc(names)}</div></div><div class="folder-amt">${total ? fmt(total) : "—"}</div><span class="folder-go">›</span></a>`;

export function netWorthPage() {
  const n = now(); const b = base(); const snaps = snapshots();
  const q = new URLSearchParams((location.hash.split("?")[1] || ""));
  const mode = q.get("mode") === "percent" ? "percent" : "amount";
  const ser = series(mode);
  const comp = composition();
  const prior = priorMonthly();
  const change = n.total && prior?.total && prior.base_currency === b ? money(n.total.amount - prior.total.amount, b) : null;
  const p = parts(n);
  return {
    title: "Net worth",
    html: html`<div class="stat"><div class="label">Assets − liabilities in ${b}</div><div class="value">${n.total ? raw(heroAmount(fmtSplit(n.total))) : "—"}</div>${change ? raw(`<div class="sub">${fmt(change, { sign: true })} since ${D.fmtDateShort(prior.taken_at.slice(0, 10))}</div>`) : ""}${n.incomplete_reasons.length ? raw(`<div class="sub">Incomplete: ${esc(n.incomplete_reasons.join("; "))}${rateLinks(n.incomplete_reasons)}</div>`) : ""}</div>
      <div class="card"><h2>History</h2>
        <div class="chips"><a class="chip ${mode === "amount" ? "on" : ""}" href="#/networth?mode=amount">Amount</a><a class="chip ${mode === "percent" ? "on" : ""}" href="#/networth?mode=percent">Percent change</a></div>
        ${raw(mode === "amount" && comp.length > 1
          ? stackedNetWorthChart(comp, { fmtY: (v) => fmt(money(Math.round(v * 10 ** exponent(b)), b)), id: "nw" })
          : ser.points.length ? lineChart(ser.points, { fmtY: (v) => (mode === "percent" ? (v >= 0 ? "+" : "") + v.toFixed(1) + "%" : fmt(money(Math.round(v * 10 ** exponent(b)), b))), id: "nw" })
          : `<div class="empty">${esc(ser.reason || "Nothing to draw yet")}</div>`)}
        <p class="muted">${mode === "percent" ? "Change against the first snapshot shown, which sits at 0%." : "The line is your net worth: what you own above the middle, what you owe below it."} One snapshot is taken each month on its own; "Snapshot now" adds one today. Snapshots never change later.</p>
        <div class="actions"><button class="small" data-action="snapshot">Snapshot now</button></div>
        ${snaps.length ? raw(`<details><summary class="muted">Every snapshot</summary><table><tr><th>Taken</th><th class="num">Net worth</th></tr>${snaps.slice().reverse().map((s) => `<tr><td>${s.taken_at.slice(0, 10)}${s.trigger === "manual" ? " <small>(you)</small>" : ""}${s.base_currency !== b ? ` <span class="tag">${s.base_currency}</span>` : ""}</td><td class="num">${s.total ? fmt(s.total) : "— (" + esc(s.incomplete_reasons[0] || "incomplete") + ")"}</td></tr>`).join("")}</table></details>`) : ""}
      </div>
      ${raw(folder("#/networth/assets", "Assets", p.assetTotal, "Accounts, investments, property"))}
      ${raw(folder("#/networth/liabilities", "Liabilities", p.liabTotal, "Cards, loans, anything else owed"))}`,
    bind(root) {
      bindCharts(root);
      root.querySelector("[data-action=snapshot]").onclick = () => { takeSnapshot("manual"); toast("Snapshot taken"); };
    },
  };
}

// Inside a folder: each kind of thing owned or owed, its total, and every item, each one tap from its
// own page. Property, vehicles and anything else owned or owed are added and edited here.
function extraModal(e, kinds) {
  const b = base();
  const m = modal({ title: e ? `Edit ${e.name}` : "Add", extraButtons: e ? '<button type="button" class="danger" data-remove-extra>Remove</button>' : "", body: `<div class="inline">${field("Name", inp("name", { value: e?.name || "", required: true }))}${field("Type", sel("type", kinds, e?.type || kinds[0], (t) => t.replace("_", " ")))}</div><div class="inline">${field("Currency", sel("currency", CURRENCIES, e?.value.currency || b))}${field("Value", moneyInput("value", e ? toDecimalString(e.value) : ""))}${field("As of", inp("as_of", { type: "date", value: e?.as_of || today(), required: true }))}</div><p class="hint">Value as you typed it, shown with its date. Never revalued automatically.</p>`,
    onSubmit: (f) => { const value = parseMoney(f.get("value"), f.get("currency")); const parsed = collectExtra({ name: f.get("name"), type: f.get("type"), value, as_of: f.get("as_of") }); if (e) updateExtra(e.id, parsed); else createExtra(parsed.name, parsed.type, parsed.value, parsed.as_of); } });
  bindValidation(m.form, { validate: (f) => { try { collectExtra({ name: f.get("name"), type: f.get("type"), value: parseMoney(f.get("value"), f.get("currency")), as_of: f.get("as_of") }); return {}; } catch (error) { if (!(error instanceof ValidationError)) throw error; return { fields: error.fields, form: error.form }; } }, dependencies: { currency: ["value"] } });
  m.el.querySelector("[data-remove-extra]")?.addEventListener("click", () => { m.close(); archiveExtra(e.id); toast(`${e.name} removed`); });
}
export function netWorthPartPage(part) {
  const owe = part === "liabilities";
  const n = now(), b = base(), p = parts(n);
  const row = (href, name, sub, amount) => `<a class="row clickable" ${href ? `href="${href}"` : ""}><div class="grow"><div class="title">${esc(name)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="amt">${amount}</div></a>`;
  const baseOr = (d) => (d.base ? fmt(d.base) : "—");
  const foreign = (d) => (d.money && d.money.currency !== b ? fmt(d.money) : "");
  const accts = A.list(true);
  const idOf = (name, type) => accts.find((a) => a.name === name && (type === "credit" ? a.type === "credit" : a.type !== "credit"))?.id;
  const group = (title, total, rows, empty, more = "") => `<div class="card"><div class="group-head"><h2>${title}</h2><b>${total ? fmt(total) : "—"}</b></div>${rows.length ? rows.join("") : `<div class="empty">${empty}</div>`}${more}</div>`;
  const extrasOf = (types) => n.detail.extras.filter((e) => types.includes(e.type));
  // Tap one to change its value or remove it: a thing owned is edited where it is listed.
  const extraRows = (list) => list.map((e) => `<div class="row clickable" role="button" tabindex="0" data-edit-extra="${e.id}"><div class="grow"><div class="title">${esc(e.name)}<span class="tag">${cap(e.type)}</span></div><div class="sub">${e.value.currency !== b ? `${fmt(e.value)} · ` : ""}as of ${D.fmtDate(e.as_of)}</div></div><div class="amt">${e.base ? fmt(e.base) : "—"}</div><span class="folder-go" aria-hidden="true">›</span></div>`);
  const holdingsById = Object.fromEntries(H.list("active").map((h) => [h.name, h.id]));
  const groups = owe ? [
    group("Credit cards", p.liabs[0].m, n.detail.credit.map((d) => row(idOf(d.name, "credit") ? `#/accounts/${idOf(d.name, "credit")}` : "", d.name, [foreign(d), d.archived ? "archived" : ""].filter(Boolean).join(" · "), baseOr({ base: d.base && money(Math.abs(d.base.amount), b) }))), "No credit cards.", '<div class="actions"><a class="btn small" href="#/accounts">All accounts ›</a></div>'),
    group("Loans", p.liabs[1].m, n.detail.debts.map((d) => row(`#/debts/${DB.list().find((x) => x.name === d.name)?.id || ""}`, d.name, foreign(d), baseOr(d))), "No loans.", '<div class="actions"><a class="btn small" href="#/debts">Debts page ›</a></div>'),
    group("Other owed", p.liabs[2].m, extraRows(extrasOf(["other_liability"])), "Nothing else owed.", '<div class="actions"><button class="small" data-add-extra="other_liability">＋ Add something owed</button></div>'),
  ] : [
    group("Accounts", p.assets[0].m, n.detail.accounts.map((d) => row(idOf(d.name) ? `#/accounts/${idOf(d.name)}` : "", d.name, [foreign(d), d.archived ? "archived" : ""].filter(Boolean).join(" · "), baseOr(d))), "No accounts.", '<div class="actions"><a class="btn small" href="#/accounts">All accounts ›</a></div>'),
    group("Investments", p.assets[1].m, n.detail.holdings.map((d) => row(holdingsById[d.name] ? `#/investments/${holdingsById[d.name]}` : "", d.name, [foreign(d), d.asOf ? "as of " + D.fmtDateShort(d.asOf) : ""].filter(Boolean).join(" · "), baseOr(d))), "No investments.", '<div class="actions"><a class="btn small" href="#/investments">Investments page ›</a></div>'),
    group("Property, vehicles and other", p.assets[2].m, extraRows(extrasOf(["property", "vehicle", "other_asset"])), "Nothing added yet: a flat, a car, anything else of value.", '<div class="actions"><button class="small" data-add-extra="property">＋ Add property, vehicle or other</button></div>'),
  ];
  const segs = (owe ? p.liabs : p.assets).map((x) => ({ label: x.label, value: x.m ? Math.max(0, x.m.amount) : 0, text: x.m ? fmt(x.m) : "—" }));
  return {
    title: owe ? "Liabilities" : "Assets",
    html: html`<div class="stat"><div class="label">${owe ? "Everything you owe" : "Everything you own"}, in ${b}</div><div class="value">${(owe ? p.liabTotal : p.assetTotal) ? raw(heroAmount(fmtSplit(owe ? p.liabTotal : p.assetTotal))) : "—"}</div></div>
      ${raw(rateLinks(n.incomplete_reasons))}
      ${raw(`<div class="card">${partBar(segs)}</div>`)}${raw(groups.join(""))}`,
    bind(root) {
      const kinds = owe ? ["other_liability"] : ["property", "vehicle", "other_asset"];
      root.querySelectorAll("[data-add-extra]").forEach((x) => (x.onclick = () => extraModal(null, kinds)));
      root.querySelectorAll("[data-edit-extra]").forEach((x) => { x.onclick = () => extraModal(store.get("nw_extras", x.dataset.editExtra), kinds); x.onkeydown = (ev) => { if (ev.key === "Enter") x.click(); }; });
    },
  };
}

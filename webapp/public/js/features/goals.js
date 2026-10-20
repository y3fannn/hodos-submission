// Goals: target by date, linked account or manual contributions, and what is needed each month.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, fmtSplit, parseMoney, sub, add, exponent, toDecimalString } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { html, raw, modal, field, inp, sel, toast, moneyInput, esc, cap, goalChart, bindCharts, heroAmount, rateLinks, commitAction, ValidationError, bindValidation } from "../lib/ui.js";
import { CURRENCIES, isMoney } from "../lib/money.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as AL from "./alerts.js";

const trackingStatus = (g) => g.status === "completed" ? "active" : g.status;
export const list = (status) => store.all("goals").filter((g) => (!status ? trackingStatus(g) !== "archived" : trackingStatus(g) === status));
export const get = (id) => store.get("goals", id);

const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validBaseMoney = (value) => isMoney(value) && Number.isSafeInteger(value.amount) && CURRENCIES.includes(value.currency) && value.currency === base();
export const goalIssues = ({ name, target, targetDate, accountId }) => {
  const fields = {};
  let rate_pair;
  if (typeof name !== "string" || !name.trim()) fields.name = "Enter a goal name.";
  if (!validBaseMoney(target) || target.amount <= 0) fields.target = `Enter a positive target in ${base()}.`;
  if (!validDate(targetDate) || targetDate <= today()) fields.date = "Choose a real target date after today.";
  if (accountId) {
    const account = A.get(accountId);
    if (!account) fields.account = "Choose an existing account.";
    else {
      const conversion = fx.toBase(A.balance(accountId), base());
      if (!conversion.money && !conversion.rate && account.currency !== base()) {
        const error = fx.missingRateError(account.currency, base());
        fields.account = error.message;
        rate_pair = error.rate_pair;
      }
      else if (!conversion.money) fields.account = `Cannot link this account: ${conversion.reason}`;
    }
  }
  return { fields, rate_pair };
};
const reportIssues = (fields) => { if (Object.keys(fields).length) throw new ValidationError({ fields }); };
export function create({ name, target, targetDate, accountId }) {
  const issues = goalIssues({ name, target, targetDate, accountId });
  if (Object.keys(issues.fields).length) throw new ValidationError(issues);
  let start_balance = null;
  if (accountId) { const balance = A.balance(accountId), conv = fx.toBase(balance, base()); if (!conv.money) { if (!conv.rate && balance.currency !== base()) throw fx.missingRateError(balance.currency, base()); throw new ValidationError({ fields: { account: `Cannot link this account: ${conv.reason}` } }); } start_balance = conv.money; }
  return store.insert("goals", { name: name.trim(), target, target_date: targetDate, account_id: accountId || null, start_balance, started_on: today(), status: "active", completed_at: null });
}
export const setStatus = (id, status) => store.update("goals", id, { status, completed_at: status === "completed" ? nowIso() : null });
export const contributionIssues = (goalId, m, date) => {
  const fields = {}, goal = get(goalId);
  if (!goal || goal.account_id) fields.amount = "Choose an existing unlinked goal.";
  if (!validBaseMoney(m)) fields.amount = `Enter a valid amount in ${base()}.`;
  if (!validDate(date) || date > today()) fields.date = "Choose a real date today or earlier.";
  return fields;
};
export const contribute = (goalId, m, date, transactionId) => { reportIssues(contributionIssues(goalId, m, date)); return store.insert("goal_contributions", { goal_id: goalId, money: m, date, transaction_id: transactionId || null }); };
export const contributions = (goalId) => store.all("goal_contributions").filter((c) => c.goal_id === goalId).sort((a, b) => b.date.localeCompare(a.date));

export function status(g) {
  let progress = null, reason = null;
  if (g.account_id) {
    const conv = fx.toBase(A.balance(g.account_id), base());
    if (conv.money) progress = sub(conv.money, g.start_balance); else reason = conv.reason;
  } else progress = contributions(g.id).reduce((s, c) => add(s, c.money), money(0, base()));
  const remaining = progress ? sub(g.target, progress) : null;
  const t = today();
  const overdue = g.target_date < t;
  // What has to go in each month from here to arrive on the date: the gap over the months left.
  // Nothing else is judged: no pace, no average, no on-track verdict (ruled 2026-09-19).
  const monthsLeft = overdue ? 0 : Math.max(1, D.monthsBetween(t, g.target_date));
  const monthlyNeeded = remaining && !overdue ? money(Math.ceil(Math.max(0, remaining.amount) / monthsLeft), base()) : null;
  const achieved = progress ? progress.amount >= g.target.amount : null;
  return { progress, remaining, monthsLeft, monthlyNeeded, reason, overdue, achieved, pct: progress ? Math.round((progress.amount / g.target.amount) * 100) : null };
}
// Progress over time, for the chart. Manual goals step up on each contribution. A linked goal reads
// the account's balance on the 1st of each month since the goal was set, less where it started.
export function history(g) {
  const t = today();
  if (!g.account_id) {
    const cs = contributions(g.id).slice().reverse();
    const first = cs[0]?.date && cs[0].date < g.started_on ? cs[0].date : g.started_on;
    let run = 0; const out = [{ date: first, amount: 0 }];
    // Same-day contributions are one step; the zero it starts from is always kept.
    for (const c of cs) { run += c.money.amount; const last = out[out.length - 1]; if (out.length > 1 && last.date === c.date) last.amount = run; else out.push({ date: c.date, amount: run }); }
    if (out[out.length - 1].date < t) out.push({ date: t, amount: run });
    return out;
  }
  const dates = [g.started_on]; let d = D.addMonths(g.started_on, 1, 1);
  while (d < t) { dates.push(d); d = D.addMonths(d, 1, 1); }
  if (dates[dates.length - 1] !== t) dates.push(t);
  return dates.map((date) => { const c = fx.toBase(A.balance(g.account_id, date), base(), date); return { date, amount: c.money ? c.money.amount - g.start_balance.amount : null, reason: c.reason || null }; });
}
export function checkAll() {
  for (const g of list()) {
    const current = get(g.id), tracking = trackingStatus(current);
    const acct = current.account_id && (A.get(current.account_id) || store.all("accounts", { includeDeleted: true }).find((a) => a.id === current.account_id));
    if (acct?.archived_at && tracking === "active") {
      setStatus(current.id, "paused");
      AL.fire({ type: "system", severity: "warn", source: { feature: "goals", entity_id: current.id }, dedupe_key: `goal_paused:${current.id}`, title: `Goal "${current.name}" paused`, body: "Its linked account was archived." });
      continue;
    }
    const result = status(current);
    if (tracking === "active" && result.achieved === true) AL.fire({ type: "goal_done", source: { feature: "goals", entity_id: current.id }, dedupe_key: `goal_done:${current.id}`, title: `Goal reached: ${current.name}`, body: `${fmt(result.progress)} of ${fmt(current.target)}.` });
  }
}

const moneyText = (m) => m ? toDecimalString(m) : "";
export function newGoalModal(preset = {}) {
  const m = modal({ title: "New goal", body: field("Name", inp("name", { required: true, placeholder: "Emergency fund", value: preset.name || "" })) + `<div class="inline">${field("Target (" + base() + ")", moneyInput("target", moneyText(preset.target))) }${field("By", inp("date", { type: "date", value: preset.targetDate || D.addMonths(today(), 12) }))}</div>` + field("Linked account (optional)", sel("account", [{ id: "", name: "— none, I will log contributions" }, ...A.active()], preset.accountId || "", (a) => a.name, (a) => a.id), "Progress = account balance now − balance when the goal was set."), onSubmit: (f) => { preset.beforeCommit?.(); return create({ name: f.get("name"), target: parseMoney(f.get("target"), base()), targetDate: f.get("date"), accountId: f.get("account") || null }); }, onSuccess: (result) => preset.onDone?.(result) });
  bindValidation(m.form, { validate(values) { let target = null; try { target = parseMoney(values.get("target"), base()); } catch {} return goalIssues({ name: values.get("name"), target, targetDate: values.get("date"), accountId: values.get("account") || null }); } });
  return m;
}
export function contributionModal(goalId, preset = {}) {
  const m = modal({ title: "Log contribution", body: `<div class="inline">${field("Amount (negative = withdrawal)", moneyInput("amount", moneyText(preset.amount)))}${field("Date", inp("date", { type: "date", value: preset.date || today() }))}</div><p class="hint">This is a record for the goal, not a transaction. Move the money with a transfer under Accounts if you wish.</p>`, onSubmit: (f) => { preset.beforeCommit?.(); return contribute(goalId, parseMoney(f.get("amount"), base()), f.get("date")); }, onSuccess: (result) => preset.onDone?.(result) });
  bindValidation(m.form, { validate(values) { let amount = null; try { amount = parseMoney(values.get("amount"), base()); } catch {} return { fields: contributionIssues(goalId, amount, values.get("date")) }; } });
  return m;
}
export function goalsPage() {
  const gs = list();
  const unit = 10 ** exponent(base());
  const card = (g) => {
    const s = status(g); const st = trackingStatus(get(g.id));
    const hist = history(g);
    const end = s.overdue ? today() : g.target_date;
    const needed = s.achieved === true ? "Reached" : s.overdue ? `Target date passed · ${s.remaining ? fmt(s.remaining) : "—"} to go` : s.monthlyNeeded ? `Needed: ${fmt(s.monthlyNeeded)} per month` : "Needed: —";
    const historyIncomplete = hist.some((p) => p.amount === null);
    const chart = hist.length && !historyIncomplete ? goalChart(hist.map((p) => ({ date: p.date, y: p.amount / unit })), { start: hist[0].date, end, target: g.target.amount / unit, today: today(), fmtY: (v) => fmt(money(Math.round(v * unit), base())), fmtX: D.fmtDate, id: `goal-${g.id}` }) : historyIncomplete ? `<p class="hint">History incomplete: missing conversions are not plotted.</p>${rateLinks(hist.filter((p) => p.date < today()).map((p) => p.reason))}` : "";
    return `<div class="card goal-card"><h2>${esc(g.name)}${st !== "active" ? `<span class="tag">${cap(st)}</span>` : ""}${s.achieved === true ? '<span class="tag">Reached</span>' : ""}</h2>
    <div class="goal-nums"><span class="goal-now">${s.progress ? heroAmount(fmtSplit(s.progress)) : `— <small>(${esc(s.reason)})</small>`}</span><span class="goal-of">of ${fmt(g.target)} by ${D.fmtDate(g.target_date)}</span></div>
    <div class="goal-needed">${needed}</div>${rateLinks([s.reason])}
    ${chart}
    <p class="muted">${g.account_id ? `Counts growth in ${esc(A.get(g.account_id)?.name || "an archived account")} since ${D.fmtDateShort(g.started_on)}` : "Counts the contributions you log"}</p>
    <div class="actions">${!g.account_id && st === "active" ? `<button class="small" data-contrib="${g.id}">＋ Contribution</button>` : ""}${st === "active" ? `<button class="small" data-status="${g.id}:paused">Pause</button>` : st === "paused" ? `<button class="small" data-status="${g.id}:active">Resume</button>` : ""}<button class="small danger" data-status="${g.id}:archived">Archive</button></div></div>`;
  };
  const shared = {};
  for (const g of gs.filter((g) => g.account_id)) (shared[g.account_id] ||= []).push(g);
  const warns = Object.entries(shared).filter(([, l]) => l.length > 1).map(([aid, l]) => { const growth = fx.toBase(A.balance(aid), base()).money; const rem = l.reduce((s, g) => s + (status(g).remaining?.amount || 0), 0); return growth && rem > 0 ? `${l.length} goals share ${A.get(aid)?.name}: remaining ${fmt(money(rem, base()))} in total.` : null; }).filter(Boolean);
  return {
    title: "Goals",
    html: html`<div class="actions"><button class="primary" data-action="new">＋ Goal</button></div>${warns.map((w) => raw(`<div class="card warn">${esc(w)}</div>`))}${gs.length ? raw(gs.map(card).join("")) : raw('<div class="empty">No goals. A goal is a named amount by a date.</div>')}`,
    bind(root) {
      bindCharts(root);
      root.querySelector("[data-action=new]").onclick = () => newGoalModal({ onDone: () => toast("Goal set") });
      root.querySelectorAll("[data-contrib]").forEach((b) => (b.onclick = () => contributionModal(b.dataset.contrib)));
      root.querySelectorAll("[data-status]").forEach((b) => (b.onclick = async () => {
        if (b.dataset.saving === "true") return;
        b.dataset.saving = "true"; b.disabled = true;
        const [id, st] = b.dataset.status.split(":");
        try { await commitAction(() => setStatus(id, st)); }
        catch {}
        finally { delete b.dataset.saving; if (b.isConnected) b.disabled = false; }
      }));
    },
  };
}

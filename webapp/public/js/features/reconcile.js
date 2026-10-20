// Statement matching (accounts P2): a bank statement's lines paired with the app's records, so what is
// missing on either side shows. accounts.md, "Reconcile — P2 statement match". Matching is code; the AI
// at most reads which column is which, as the import door does. Nothing is written until the user adds
// a line or saves the match.
import { store, nowIso } from "../lib/store.js";
import { money, fmt, parseMoney } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as ai from "../lib/ai.js";
import { html, raw, esc, field, toast, moneyInput } from "../lib/ui.js";
import * as A from "./accounts.js";
import * as T from "./transactions.js";
import { session } from "../lib/session.js";

const WINDOW = 3; // days either side
const gapDays = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);
// What a row did to this account, signed, in minor units: money out is negative.
const effectOf = (t, accountId) => (t.kind === "expense" ? -t.money.amount : t.kind === "income" ? t.money.amount : t.account_id === accountId ? -t.money.amount : t.counter_money.amount);
const lineEffect = (l) => (l.kind === "expense" ? -l.money.amount : l.money.amount);
// Two bank references that differ can never be the same payment; one missing leaves it to date and amount.
const refsAgree = (l, t) => !(l.bank_ref && t.bank_ref && l.bank_ref !== t.bank_ref);

// Pairs statement lines with records, one to one.
//   1. Both carry the bank's own reference and it is the same → matched on it, whatever the dates.
//   2. Otherwise same signed amount, dates within 3 days. Within each amount, as many pairs as can be
//      made, and of those, the nearest dates. (On a line of dates the best pairing never crosses, so
//      a walk through both lists in date order finds it.) A Monday coffee takes the Monday or Tuesday
//      line before a Thursday one can, and a coffee a day, each a day late on the statement, pairs
//      one to one without a question.
//   3. A line whose paired record has an unpaired twin exactly as near is asked about, not guessed.
// Returns {matched: [{line, tx, days}], ask: [{line, options: [tx]}], onlyStatement: [line], onlyApp: [tx], period}.
export function match(accountId, lines, records = T.live().filter((t) => t.account_id === accountId || t.counter_account_id === accountId)) {
  const dates = lines.map((l) => l.date).sort();
  const period = { start: dates[0], end: dates.at(-1) };
  const pool = records.filter((t) => !t.voided_at && t.date >= D.addDays(period.start, -WINDOW) && t.date <= D.addDays(period.end, WINDOW));
  const pairOf = new Map(), taken = new Set();
  lines.forEach((l, i) => {
    if (!l.bank_ref) return;
    const t = records.find((x) => !x.voided_at && x.bank_ref === l.bank_ref && !taken.has(x.id));
    if (t) { pairOf.set(i, t); taken.add(t.id); }
  });
  const groups = new Map();
  lines.forEach((l, i) => { if (pairOf.has(i)) return; const k = lineEffect(l); if (!groups.has(k)) groups.set(k, { L: [], R: [] }); groups.get(k).L.push(i); });
  for (const t of pool) { if (taken.has(t.id)) continue; const g = groups.get(effectOf(t, accountId)); if (g) g.R.push(t); }
  for (const { L, R } of groups.values()) {
    L.sort((a, b) => lines[a].date.localeCompare(lines[b].date)); R.sort((a, b) => a.date.localeCompare(b.date));
    for (const [i, t] of pairUp(L.map((x) => lines[x]), R)) { pairOf.set(L[i], t); taken.add(t.id); }
  }
  const matched = [], ask = [], onlyStatement = [];
  lines.forEach((l, i) => {
    const t = pairOf.get(i);
    if (!t) { onlyStatement.push(l); return; }
    const d = gapDays(l.date, t.date);
    const twins = l.bank_ref && t.bank_ref === l.bank_ref ? [] : pool.filter((x) => !taken.has(x.id) && effectOf(x, accountId) === lineEffect(l) && refsAgree(l, x) && gapDays(l.date, x.date) === d);
    if (twins.length) { ask.push({ line: l, options: [t, ...twins] }); taken.delete(t.id); }
    else matched.push({ line: l, tx: t, days: d });
  });
  const onlyApp = pool.filter((t) => !taken.has(t.id) && !ask.some((a) => a.options.includes(t)) && t.date >= period.start && t.date <= period.end);
  return { matched, ask, onlyStatement, onlyApp, period };
}
// Most pairs first, then the smallest total of days apart. dp[i][j]: best for lines i.. and records j..
function pairUp(L, R) {
  const n = L.length, m = R.length;
  if (!n || !m) return [];
  const better = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1]);
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) {
    if (i === n || j === m) { dp[i][j] = [0, 0, null]; continue; }
    let best = [dp[i + 1][j][0], dp[i + 1][j][1], "skipL"];
    if (better(dp[i][j + 1], best)) best = [dp[i][j + 1][0], dp[i][j + 1][1], "skipR"];
    const d = gapDays(L[i].date, R[j].date);
    if (d <= WINDOW && refsAgree(L[i], R[j])) { const c = [dp[i + 1][j + 1][0] + 1, dp[i + 1][j + 1][1] + d, "pair"]; if (better(c, best)) best = c; }
    dp[i][j] = best;
  }
  const out = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    const step = dp[i][j][2];
    if (step === "pair") { out.push([i, R[j]]); i++; j++; } else if (step === "skipL") i++; else j++;
  }
  return out;
}

// What is kept: one reconciliation row, its lines and what the user did with each. The statement's
// own text stays, so the check can be read later; no file is kept.
export function save(accountId, result, { closing = null, resolutions = {} } = {}) {
  const computed = A.balance(accountId, result.period.end);
  const gap = closing ? money(closing.amount - computed.amount, computed.currency) : null;
  const line = (l, matchId, resolution) => ({ statement_row: { date: l.date, text: l.merchant || "", amount: l.money, kind: l.kind, bank_ref: l.bank_ref || null }, match: matchId, resolution });
  const lines = [
    ...result.matched.map((m) => line(m.line, m.tx.id, "matched")),
    ...result.onlyStatement.map((l) => { const r = resolutions[key(l)]; return line(l, r?.tx || null, r?.tx ? "added" : "ignored"); }),
    ...result.onlyApp.map((t) => ({ statement_row: null, match: t.id, resolution: "flagged" })),
  ];
  return store.insert("reconciliations", { account_id: accountId, statement_date: result.period.end, statement_balance: closing, computed_balance: computed, gap, lines, confirmed_at: nowIso() });
}
const key = (l) => `${l.date}|${l.kind}|${l.money.amount}|${l.merchant || ""}|${l.bank_ref || ""}`;

// ---------- the page: #/accounts/:id/match ----------
// One statement at a time, held in memory until saved; leaving the page drops it.
let work = null; // {accountId, fileName, lines, result, closing, resolutions, failed}

function readFile(acct, file, closing) {
  return new Promise((resolve, reject) => {
    const prepare = async () => {
      try {
        const rows = T.parseCsv(await file.text());
        if (rows.length < 2) throw new Error("That file has no rows.");
        const header = rows[0].map((h) => h.trim()), data = rows.slice(1);
        if (data.length > 2000) throw new Error(`${data.length} rows. At most 2,000 a statement.`);
        const finish = (mapping) => {
          try {
            const parsed = T.applyMapping(data, header, mapping, acct.currency);
            const lines = parsed.filter((r) => r.status === "ready").map((r) => r.parsed);
            if (!lines.length) throw new Error("No line of that file could be read. Check the columns.");
            resolve({ lines, failed: parsed.filter((r) => r.status !== "ready").length, fileName: file.name, closing });
          } catch (error) { reject(error); }
        };
        let mapping = null;
        if (ai.enabled()) { try { mapping = await T.mapCsvColumns(header, data.slice(0, 5)); } catch { mapping = null; } }
        if (mapping) finish(mapping); else T.manualMap(header, data, acct, finish);
      } catch (error) { reject(error); }
    };
    prepare();
  });
}

export function statementPage(accountId) {
  if (work && (work.accountId !== accountId || work.generation !== store.generation())) work = null;
  const acct = A.get(accountId);
  if (!acct) return { title: "Match a statement", html: '<div class="empty">Not found</div>', bind() {} };
  if (work && work.accountId !== accountId) work = null;
  if (!work?.result) {
    return {
      title: "Match a statement",
      html: html`<div class="card"><h2>${acct.name}: match a statement</h2>
        <p class="muted">Upload the statement your bank gives you as a CSV file. Each line is paired with a record here: the same amount within 3 days, or the bank's own reference where both have one. You then see what is on the statement but not here, and what is here but not on the statement.</p>
        <form data-form="statement">
          <label>Statement file <input type="file" name="file" accept=".csv,text/csv" required /></label>
          ${raw(field(`Closing balance on the statement (optional, ${acct.currency})`, moneyInput("closing", "", "leave blank if it has none")))}
          <div class="actions right"><button class="primary">Match it</button></div>
        </form><div class="error" data-error></div></div>`,
      bind(root) {
        const pageHash = location.hash;
        root.querySelector("[data-form=statement]").onsubmit = async (e) => {
          e.preventDefault(); const f = new FormData(e.target), btn = e.target.querySelector("button");
          const hash = pageHash, generation = store.generation(), ownerProfile = store.one("profile")?.id;
          const active = () => hash === location.hash && generation === store.generation() && store.one("profile")?.id === ownerProfile;
          btn.disabled = true; btn.textContent = "Reading…";
          try {
            const read = await readFile(acct, f.get("file"), parseMoney(f.get("closing"), acct.currency));
            if (!active() || !root.isConnected) return;
            work = { accountId, ...read, result: match(accountId, read.lines), resolutions: {}, generation };
            session.render();
          } catch (ex) {
            if (!active() || !root.isConnected) return;
            root.querySelector("[data-error]").textContent = ex.message; btn.disabled = false; btn.textContent = "Match it";
          }
        };
        return ({ reason = "navigate" } = {}) => { if (reason !== "redraw" && work?.accountId === accountId) work = null; };
      },
    };
  }
  const r = work.result, cur = acct.currency;
  const done = (l) => work.resolutions[key(l)];
  const lineRow = (l, extra = "") => `<div class="row"><div class="grow"><div class="title">${esc(l.merchant || (l.kind === "income" ? "Money in" : "Money out"))}</div><div class="sub">${D.fmtDate(l.date)}${l.bank_ref ? ` · ref ${esc(l.bank_ref)}` : ""}</div></div><div class="amt">${l.kind === "income" ? "+" : "−"}${fmt(l.money)}</div>${extra}</div>`;
  const txLine = (t) => { const e = effectOf(t, accountId); return `${esc(t.merchant || t.note || (t.kind === "transfer" ? "Transfer" : t.kind))} · ${D.fmtDate(t.date)} · ${e < 0 ? "−" : "+"}${fmt(money(Math.abs(e), cur))}`; };
  const computed = A.balance(accountId, r.period.end);
  const gap = work.closing ? money(work.closing.amount - computed.amount, cur) : null;
  const open = r.onlyStatement.filter((l) => !done(l)).length + r.ask.length;
  return {
    title: "Match a statement",
    html: html`<div class="card"><h2>${esc(work.fileName)}</h2>
        <p class="muted">${D.fmtDate(r.period.start)} – ${D.fmtDate(r.period.end)} · ${work.lines.length} lines${work.failed ? ` · ${work.failed} could not be read` : ""}</p>
        <div class="kv"><span>Matched</span><b>${r.matched.length}</b></div>
        <div class="kv"><span>On the statement, not here</span><b>${r.onlyStatement.length}</b></div>
        <div class="kv"><span>Here, not on the statement</span><b>${r.onlyApp.length}</b></div>
        ${r.ask.length ? raw(`<div class="kv"><span>Two records equally close: you choose</span><b>${r.ask.length}</b></div>`) : ""}
        <div class="kv"><span>Gap to the closing balance</span><b>${gap ? fmt(gap, { sign: true }) : "— (no closing balance given)"}</b></div>
        ${gap && gap.amount !== 0 ? raw('<p class="hint">Nothing is changed for you. Add the missing lines below, or add a record noted "reconciliation" to close the gap.</p>') : ""}
      </div>
      ${r.ask.length ? raw(`<div class="card"><h2>You choose</h2><p class="muted">Each of these statement lines has two records exactly as close. Which one is it?</p>${r.ask.map((a, i) => `${lineRow(a.line)}<div class="actions">${a.options.map((t, j) => `<button class="small" data-pick="${i}:${j}">${txLine(t)}</button>`).join("")}</div>`).join("")}</div>`) : ""}
      ${r.onlyStatement.length ? raw(`<div class="card"><h2>On the statement, not here</h2>${r.onlyStatement.map((l, i) => lineRow(l, done(l) ? `<span class="tag">${done(l).tx ? "added" : "ignored"}</span>` : `<button class="small primary" data-add="${i}">Add</button><button class="small" data-ignore="${i}">Ignore</button>`)).join("")}</div>`) : ""}
      ${r.onlyApp.length ? raw(`<div class="card warn"><h2>Here, not on the statement</h2><p class="muted">Flagged for you to check: a typo, a duplicate, or something the bank has not posted yet.</p>${r.onlyApp.map((t) => A.txRow(t, accountId)).join("")}</div>`) : ""}
      ${r.matched.length ? raw(`<details class="card"><summary>Matched (${r.matched.length})</summary>${r.matched.map((m) => lineRow(m.line, `<span class="tag">${m.days ? `${m.days} day${m.days > 1 ? "s" : ""} apart` : "same day"}</span>`)).join("")}</details>`) : ""}
      <div class="actions"><button class="primary" data-action="save" ${open || work.saving ? "disabled" : ""}>Save the match</button><button data-action="restart">Start again</button></div>
      ${open ? raw(`<p class="hint">${open} line${open > 1 ? "s" : ""} still to add, ignore or choose before saving.</p>`) : ""}`,
    bind(root) {
      const pageHash = location.hash, pageWork = work; let unsubscribeCommit = null;
      root.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => {
        const [i, j] = b.dataset.pick.split(":").map(Number); const a = r.ask[i];
        r.ask.splice(i, 1); r.matched.push({ line: a.line, tx: a.options[j], days: gapDays(a.line.date, a.options[j].date) });
        const other = a.options.filter((_, k) => k !== j);
        for (const t of other) if (t.date >= r.period.start && t.date <= r.period.end && !r.matched.some((m) => m.tx.id === t.id)) r.onlyApp.push(t);
        session.render();
      }));
      root.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
        const l = r.onlyStatement[Number(b.dataset.add)];
        T.confirmModal({ kind: l.kind, account_id: accountId, money: l.money, date: l.date, merchant: l.kind === "income" ? null : l.merchant, bank_ref: l.bank_ref || null, source: "csv" }, { title: "Add from the statement", onDone: (tx) => { work.resolutions[key(l)] = { tx: tx.id }; session.render(); } });
      }));
      root.querySelectorAll("[data-ignore]").forEach((b) => (b.onclick = () => { work.resolutions[key(r.onlyStatement[Number(b.dataset.ignore)])] = { tx: null }; session.render(); }));
      root.querySelector("[data-action=restart]").onclick = () => { work = null; session.render(); };
      root.querySelector("[data-action=save]").onclick = async () => {
        const captured = work;
        if (captured.saving) return;
        captured.saving = true;
        let receipt;
        const finish = () => {
          if (receipt?.state !== "durable") return;
          unsubscribeCommit?.(); unsubscribeCommit = null;
          if (work !== captured || store.generation() !== captured.generation || location.hash !== pageHash) return;
          work = null; toast("Statement match saved"); location.hash = `#/accounts/${accountId}`;
        };
        try {
          receipt = store.captureAction(`statement-match:${crypto.randomUUID()}`, () => save(accountId, r, { closing: captured.closing, resolutions: captured.resolutions }));
          unsubscribeCommit = store.onCommitted(finish);
          await store.commit(receipt);
          if (receipt.state !== "durable") throw new Error("Device storage did not confirm this save.");
          finish();
        } catch {
          if (!receipt) captured.saving = false;
        }
      };
      return ({ reason = "navigate" } = {}) => {
        if (reason !== "redraw") { unsubscribeCommit?.(); unsubscribeCommit = null; if (work === pageWork) work = null; }
      };
    },
  };
}

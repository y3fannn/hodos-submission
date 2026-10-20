// Real-browser check: demo finance flows and discarded old unencrypted test data.
// Drives Chrome over the DevTools protocol; needs Chrome; starts its own server.
// Run: node test/browser-demo.mjs   (CHROME=/path/to/chrome and PFA_URL=... to override)
// Screenshots land in a fresh temporary folder, printed at the end. Exit code 1 on any failure.

import fs from "node:fs";
import { startServer, startChrome, sleep } from "./browser-kit.mjs";
const srv = await startServer({ AUTH: "off" }), B = await startChrome();
const { cmd, js, shot, waitFor, logs, shots: SP } = B;
const APP = process.env.PFA_URL || srv.url;
const step = (s) => console.log("•", s);
// Demo: sample data, unlocked, labelled
await cmd("Page.navigate", { url: APP + "?demo=1#/home" });
await waitFor(`!!document.querySelector(".demo-banner")`);
await sleep(800); // demo writes wait a moment before they land
step(`demo: banner shown; lock button hidden: ${await js(`document.getElementById("lock-btn").hidden`)}; kept under pfa.demo: ${await js(`!!localStorage.getItem("pfa.demo")`)}; vault created: ${await js(`new Promise((res) => { const r = indexedDB.open("pfa-vault"); r.onsuccess = () => { const t = r.result.transaction("vault").objectStore("vault").get("main"); t.onsuccess = () => res(!!t.result); }; r.onupgradeneeded = () => {}; })`)}`);
// "Make it recurring" on a charge the app noticed: the rule form opens filled in, and saving it turns
// the noticed charge into a rule without posting the past charges a second time.
await js(`location.hash = "#/recurring"`); await sleep(500);
const before = await js(`document.querySelectorAll("[data-accept]").length`), txBefore = await js(`JSON.parse(localStorage.getItem("pfa.demo")).tables.transactions.length`);
await js(`document.querySelector("[data-accept]").click()`); await sleep(300);
await waitFor(`!!document.querySelector("[data-modal-form]")`);
const prefilled = await js(`(() => { const f = document.querySelector("[data-modal-form]"); return f.name.value + " · " + f.amount.value; })()`);
await js(`document.querySelector("[data-modal-form]").requestSubmit()`); await sleep(1200);
const after = await js(`document.querySelectorAll("[data-accept]").length`), txAfter = await js(`JSON.parse(localStorage.getItem("pfa.demo")).tables.transactions.length`);
step(`make it recurring: form filled in (${prefilled}); noticed charges ${before} → ${after}; records ${txBefore} → ${txAfter} (none posted twice)`);
if (!(after === before - 1 && txAfter === txBefore)) { console.log("FAIL: make it recurring"); process.exitCode = 1; }
// Match a statement: a file of Main bank's last five records as the bank would list them, plus one
// line the app does not have. Five should pair, one should be only on the statement.
const bankRows = await js(`(() => { const d = JSON.parse(localStorage.getItem("pfa.demo")).tables; const bank = d.accounts.find((a) => a.name === "Main bank"); return { id: bank.id, rows: d.transactions.filter((t) => t.account_id === bank.id && !t.voided_at && t.kind !== "transfer").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((t) => [t.date, (t.kind === "expense" ? -1 : 1) * t.money.amount / 100, t.merchant || "Salary"]) }; })()`);
const csvPath = `${SP}/statement.csv`;
fs.writeFileSync(csvPath, ["Date,Amount,Description", ...bankRows.rows.map((r) => `${r[0]},${r[1].toFixed(2)},${r[2]}`), `${bankRows.rows[0][0]},-12.34,Mystery charge`].join("\n"));
await js(`location.hash = "#/accounts/${bankRows.id}/match"`); await sleep(500);
const { result: { root } } = await cmd("DOM.getDocument", {});
const { result: { nodeId } } = await cmd("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-form=statement] input[type=file]" });
await cmd("DOM.setFileInputFiles", { nodeId, files: [csvPath] });
await js(`document.querySelector("[data-form=statement]").requestSubmit()`);
await waitFor(`!!document.querySelector("[data-modal-form] [name=amount_col]")`);
await js(`(() => { const f = document.querySelector("[data-modal-form]"); f.date_col.value = "Date"; f.amount_col.value = "Amount"; f.description_col.value = "Description"; f.requestSubmit(); })()`);
await waitFor(`/On the statement, not here/.test(document.body.innerText)`);
const summary = await js(`[...document.querySelectorAll(".kv")].slice(0, 3).map((k) => k.innerText.replace(/\\s+/g, " ")).join(" · ")`);
await shot("7b-statement");
step(`statement matched: ${summary}`);
if (!/Matched 5/.test(summary) || !/statement, not here 1/.test(summary)) { console.log("FAIL: statement match"); process.exitCode = 1; }
await js(`document.querySelector("[data-ignore]").click()`); await sleep(300);
await js(`document.querySelector("[data-action=save]").click()`); await sleep(800);
const saved = await js(`JSON.parse(localStorage.getItem("pfa.demo")).tables.reconciliations.at(-1)?.lines.map((l) => l.resolution).join(",")`);
step(`saved with each line's outcome: ${saved}`);
if (!/matched/.test(saved || "") || !/ignored/.test(saved || "")) { console.log("FAIL: statement save"); process.exitCode = 1; }
// The assistant's newer buttons, pressed directly (no AI key here): each opens its own form, filled in.
const pressed = await js(`(async () => {
  const AS = await import("./js/features/assistant.js"), out = {};
  const read = () => { const f = document.querySelector("[data-modal-form]"); const v = f ? Object.fromEntries([...new FormData(f)].filter(([, x]) => x)) : null; document.getElementById("modal-root").innerHTML = ""; return v; };
  AS.performAction({ kind: "transfer", params: { amount_text: "250", from_account: "Main bank", to_account: "Cash" } }); out.transfer = read();
  AS.performAction({ kind: "create_recurring", params: { name: "Netflix", amount_text: "15.90", merchant: "Netflix", freq: "monthly", start_date: "2026-10-01" } }); out.rule = read();
  AS.performAction({ kind: "log_investment_value", params: { holding_name: "bitcoin", amount_text: "1.5k" } }); out.value = read();
  AS.performAction({ kind: "add_account", params: { name: "OCBC savings", account_type: "bank", amount_text: "5k" } }); out.account = read();
  return out; })()`);
step(`assistant buttons open filled forms: transfer ${pressed.transfer?.out}, rule ${pressed.rule?.name} ${pressed.rule?.amount} ${pressed.rule?.freq} from ${pressed.rule?.start}, value ${pressed.value?.value}, account ${pressed.account?.name} ${pressed.account?.opening}`);
if (pressed.transfer?.out !== "250.00" || pressed.rule?.amount !== "15.90" || pressed.value?.value !== "1500.00" || pressed.account?.opening !== "5000.00") { console.log("FAIL: assistant buttons"); process.exitCode = 1; }
await shot("7-demo-home");
// Start your own: demo data goes, set-up begins, and it stays gone
await js(`location.hash = "#/settings"`); await sleep(400);
await js(`document.querySelector("[data-action=end-demo]").click()`);
await waitFor(`!!document.querySelector("[data-form=profile-create]")`); await sleep(800);
const leftDemo = await js(`location.hash === '#/signup' && localStorage.getItem("pfa.demo") === null && !new URL(location.href).searchParams.has('demo')`);
step(`start your own: signup route (local setup on this accounts-off copy), samples and demo URL marker cleared: ${leftDemo}`);
if (!leftDemo) process.exitCode = 1;
// Disposable shared test data must be discarded, never silently migrated into a real account.
await js(`localStorage.setItem("pfa.db", JSON.stringify({ schema_version: 1, tables: { profile: [{ id: "p1", base_currency: "SGD", timezone: "Asia/Singapore", self_description: "working", consent: { ai_provider: false } }], accounts: [{ id: "a1", name: "Old Bank", type: "bank", currency: "SGD", opening_balance: { amount: 12345, currency: "SGD" }, opened_on: "2026-01-01" }] } }))`);
await cmd("Page.reload"); await sleep(1500);
await waitFor(`!!document.querySelector('[data-form=profile-create]')`);
const discarded = await js(`localStorage.getItem('pfa.db')===null && !document.body.innerText.includes('Old Bank')`);
step(`old test records discarded instead of migrated: ${discarded}`);
if (!discarded) process.exitCode = 1;
await shot('8-old-tests-discarded');
const bad = logs.filter((l) => /EXCEPTION|Refused|Content Security|error/i.test(l));
console.log(bad.length ? "BROWSER PROBLEMS:\n" + bad.join("\n") : "No exceptions and no blocked content in the browser log.");
console.log(`Screenshots: ${SP}`);
B.close(); srv.stop();
process.exit(bad.length || process.exitCode ? 1 : 0);

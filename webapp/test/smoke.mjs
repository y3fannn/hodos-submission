// Headless exercise of the feature logic against acceptance lists.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
Object.defineProperty(globalThis, "navigator", { value: { storage: null }, configurable: true });
globalThis.location = { hash: "#/home" };
globalThis.window = { scrollTo() {} };
globalThis.document = { getElementById: () => ({ innerHTML: "", querySelector: () => ({ onclick: null, addEventListener() {} }), querySelectorAll: () => [] }), querySelector: () => null, querySelectorAll: () => [], body: {} };
globalThis.fetch = async () => ({ ok: false, json: async () => ({ configured: false }) });
globalThis.alert = console.error;
const P = new URL("../public/js/", import.meta.url).href;
const nodeFs = await import("node:fs");
const M = (p) => import(P + p);
const { store } = await M("lib/store.js"); const money = await M("lib/money.js"); const D = await M("lib/dates.js"); const fx = await M("lib/fx.js"); const ai = await M("lib/ai.js");
const prof = await M("features/profile.js"); const C = await M("features/categories.js"); const A = await M("features/accounts.js"); const T = await M("features/transactions.js");
const B = await M("features/budgets.js"); const NW = await M("features/networth.js"); const G = await M("features/goals.js"); const DB = await M("features/debts.js"); const I = await M("features/insurance.js"); const H = await M("features/investments.js"); const INS = await M("features/insights.js"); const AS = await M("features/assistant.js"); const seed = await M("features/seed.js"); const operations = await M("lib/operations.js");
let fails = 0; const ok = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) fails++; };
const { parseMoney, fmt, convert, money: mk } = money;
let opGeneration = store.generation(), disposedReason = null;
const operation = operations.createOperation({ key: "smoke", ownerGeneration: opGeneration, getGeneration: () => opGeneration, onDispose: (reason) => { disposedReason = reason; } });
ok(operation.active() && operation.start("Saving", "saving") && operation.state === "saving" && !operation.start("Saving twice", "saving") && operation.progress("Generating", "generating"), "operations: one owner-bound action moves through phases without duplicate activation");
const duplicateOperation = operations.createOperation({ key: "smoke", ownerGeneration: opGeneration, getGeneration: () => opGeneration });
ok(duplicateOperation === operation && !duplicateOperation.start("Duplicate", "saving"), "operations: a second operation with the same owner/key joins instead of starting again");
ok(operation.pause("Ready for review") && operation.state === "idle" && operation.start("Saving again", "saving"), "operations: work can pause for user input then resume with the same identity");
ok(operation.fail("Not saved", "Retry") && operation.state === "failed" && operation.start("Retrying", "saving") && operation.succeed("Saved") && operation.state === "success", "operations: a failed action can retry and succeed without a new identity");
operation.dispose("navigation"); ok(operation.signal.aborted && disposedReason === "navigation", "operations: disposal aborts unfinished work and reports its reason");
const nextOperation = operations.createOperation({ key: "smoke", ownerGeneration: opGeneration, getGeneration: () => opGeneration });
ok(nextOperation !== operation && nextOperation.start("After disposal", "saving"), "operations: a new attempt may start after the prior operation is disposed"); nextOperation.dispose();
const staleOperation = operations.createOperation({ key: "stale", ownerGeneration: opGeneration, getGeneration: () => opGeneration + 1 });
ok(!staleOperation.active() && !staleOperation.start("Saving", "saving"), "operations: stale owner generation cannot start work");
const accessOperation = operations.createOperation({ key: "access", ownerGeneration: opGeneration, getGeneration: () => opGeneration });
accessOperation.start("Reading", "reading"); operations.disposeAllOperations("lock");
ok(accessOperation.signal.aborted && !accessOperation.active(), "operations: lock/access cleanup aborts every registered preparation");

// money
ok(parseMoney("12.34", "SGD").amount === 1234, "parseMoney 12.34 SGD = 1234");
ok(parseMoney("1,500", "JPY").amount === 1500, "JPY exponent 0");
ok(parseMoney("", "SGD") === null, "blank stays absent");
ok(parseMoney("(50.00)", "USD").amount === -5000, "parenthesised negative");
ok(convert(mk(10000, "SGD"), "USD", "0.74").amount === 7400, "convert SGD→USD");
ok(convert(mk(100, "JPY"), "SGD", "0.0091").amount === 91, "convert JPY→SGD rounds to minor unit");
ok(fmt(null) === "—", "fmt absent");
// dates
ok(D.budgetMonth("2026-10-10", 25).start === "2026-09-25" && D.budgetMonth("2026-10-10", 25).end === "2026-10-24", "budget month start 25 (acceptance 1)");
ok(D.budgetMonth("2026-02-10", 31).start === "2026-01-31" && D.budgetMonth("2026-02-28", 31).start === "2026-02-28", "budget month start 31 clamps (acceptance 2)");
ok(D.addMonths("2026-01-31", 1, 31) === "2026-02-28", "month too short → last day");
// profile + categories
prof.createProfile({ base_currency: "SGD", timezone: "Asia/Singapore", self_description: "working", ai_provider: true });
ok(C.list("expense").length === 12 && C.list("income").length === 5, "12 expense + 5 income groups, no subs");
for (const [patch, name] of [[{ base_currency: 'XYZ' }, 'base_currency'], [{ timezone: 'Not/A_Timezone' }, 'timezone'], [{ dob: '2026-02-30' }, 'dob'], [{ dob: 0 }, 'dob'], [{ name: 1 }, 'name'], [{ timezone: new String('UTC') }, 'timezone'], [{ self_description: 'unknown' }, 'self_description']]) {
  const snapshot = JSON.stringify(store.snapshot()); let issue = null;
  try { prof.createProfile({ base_currency: 'SGD', timezone: 'UTC', self_description: 'working', ...patch }); } catch (error) { issue = error; }
  ok(!!issue?.fields?.[name] && JSON.stringify(store.snapshot()) === snapshot, `U4 profile: invalid ${name} gives a named issue before any profile/category/settings write`);
}
for (const day of [0, 32, 1.5, NaN, '', null, true, [2]]) {
  const snapshot = JSON.stringify(store.snapshot()); let issue = null;
  try { NW.setSnapshotDay(day); } catch (error) { issue = error; }
  ok(!!issue?.fields?.snapshot_day && JSON.stringify(store.snapshot()) === snapshot, `U4 snapshot day: ${String(day)} is rejected instead of clamped`);
}
const { readNumberBoxes } = await M('lib/ui.js');
for (const value of ['0', '366', '1.5', 'not-a-number']) {
  const f = new FormData(); f.set('lead1', value); let issue = null;
  try { readNumberBoxes(f, 'lead'); } catch (error) { issue = error; }
  ok(!!issue?.fields?.lead1, `U4 reminder: ${value} gives the exact box's issue`);
}
ok(readNumberBoxes(new FormData(), 'lead').length === 0, 'U4 reminder: optional blank boxes remain no reminders');
ok(C.normaliseMerchant("STARBUCKS #1234 RAFFLES") === C.normaliseMerchant("Starbucks Raffles") && C.normaliseMerchant("Starbucks Raffles") === "starbucks raffles", "merchant key normalisation");
// accounts
const today = prof.today();
const bank = A.create({ name: "Bank", type: "bank", currency: "SGD", openingBalance: mk(100000, "SGD"), openedOn: "2026-01-01" });
const wallet = A.create({ name: "Wallet", type: "wallet", currency: "JPY", openingBalance: mk(10000, "JPY"), openedOn: "2026-01-01" });
const card = A.create({ name: "Card", type: "credit", currency: "SGD", openingBalance: mk(0, "SGD"), openedOn: "2026-01-01", creditLimit: mk(500000, "SGD") });
ok(A.balance(bank.id).amount === 100000, "acc 1: opening 1000 → balance 1000");
ok(A.totalBase().total === null && A.totalBase().reasons[0].includes("JPY"), "acc 12: missing JPY rate → total incomplete, named");
fx.setUserRate("JPY", "SGD", "0.0091");
ok(A.totalBase().total !== null, "acc 2: with rate, total in base");
A.transfer({ fromId: bank.id, toId: wallet.id, moneyOut: mk(10000, "SGD"), moneyIn: mk(1090000, "JPY"), date: today });
ok(A.balance(bank.id).amount === 90000 && A.balance(wallet.id).amount === 1100000, "acc 3: cross-currency transfer moves exact amounts");
const tr = T.all().find((t) => t.kind === "transfer"); ok(tr.fx.source === "user" && tr.fx.rate.startsWith("109"), "acc 3: implied rate stored source user");
// transactions
const food = C.list("expense").find((c) => c.name === "Food"), shop = C.list("expense").find((c) => c.name === "Shopping"), ent = C.list("expense").find((c) => c.name === "Entertainment");
T.save({ kind: "expense", account_id: bank.id, money: mk(1250, "SGD"), date: today, category_id: food.id, merchant: "Starbucks" });
ok(A.balance(bank.id).amount === 88750, "tx 1: balance −12.50");
ok(T.findDuplicate({ kind: "expense", account_id: bank.id, money: mk(1250, "SGD"), date: today, merchant: "STARBUCKS #22" }) !== null, "tx 2: same form again flagged duplicate");
let threw = false; try { T.save({ kind: "expense", account_id: bank.id, money: mk(100, "SGD"), date: D.addDays(today, 1) }); } catch { threw = true; } ok(threw, "tx 3: future date refused");
threw = false; try { T.save({ kind: "expense", account_id: bank.id, money: mk(0, "SGD"), date: today }); } catch { threw = true; } ok(threw, "amount 0 refused");
const validationBaseline = JSON.stringify(store.snapshot());
for (const [patch, fieldName, label] of [
  [{ money: null }, "amount", "blank amount"],
  [{ money: mk(-1, "SGD") }, "amount", "negative amount"],
  [{ money: mk(NaN, "SGD") }, "amount", "not a number"],
  [{ money: mk(100, "XYZ") }, "currency", "unsupported currency"],
  [{ date: "2026-02-30" }, "date", "impossible calendar date"],
  [{ date: "2026-2-3" }, "date", "malformed calendar date"],
  [{ date: "2025-12-31" }, "date", "before account opening"],
  [{ date: D.addDays(today, 1) }, "date", "future actual date"],
  [{ account_id: "missing" }, "account_id", "missing account"],
  [{ category_id: C.list("income")[0].id }, "category_id", "wrong-kind category"],
]) {
  let issue = null;
  try { T.save({ kind: "expense", account_id: bank.id, money: mk(100, "SGD"), date: today, ...patch }); } catch (error) { issue = error; }
  ok(!!issue?.fields?.[fieldName], `U4: ${label} gives a named ${fieldName} issue`);
  ok(JSON.stringify(store.snapshot()) === validationBaseline, `U4: ${label} changes no rows or learning`);
}
const s2 = await C.suggest("STARBUCKS #22", null, "expense"); ok(s2.source === "rule" && s2.categoryId === food.id, "cat 2: rule pre-fills Food, no AI");
C.learn("Starbucks", ent.id); ok((await C.suggest("Starbucks", null, "expense")).categoryId === ent.id, "cat 3: correction rewrites rule");
ok((await C.suggest("Unknown Shop", null, "expense")).source === "none", "cat 5: unknown merchant, AI off → blank");
// card
T.save({ kind: "expense", account_id: card.id, money: mk(20000, "SGD"), date: today, category_id: shop.id, merchant: "Uniqlo" });
ok(A.balance(card.id).amount === -20000 && A.available(A.get(card.id)).amount === 480000, "acc 5: card −200, available 4800");
A.transfer({ fromId: bank.id, toId: card.id, moneyOut: mk(20000, "SGD"), date: today }); ok(A.balance(card.id).amount === 0, "acc 5: pay card → 0");
// cancel
const tx50 = T.save({ kind: "expense", account_id: bank.id, money: mk(5000, "SGD"), date: today, category_id: shop.id, merchant: "Shop" });
const before = A.balance(bank.id).amount; T.cancel(tx50.id, "refund"); ok(A.balance(bank.id).amount === before + 5000 && T.get(tx50.id).voided_at, "tx 14: cancel restores balance, row kept");
T.restore(tx50.id); ok(A.balance(bank.id).amount === before, "tx 14: restore");
// recurring catch-up
const start3 = D.addMonths(today, -3, 1);
const rent = T.createRule({ name: "Rent", template: { kind: "expense", account_id: bank.id, money: mk(150000, "SGD"), category_id: C.list("expense").find((c) => c.name === "Housing").id, merchant: "Landlord" }, schedule: { freq: "monthly", interval: 1, start: start3, anchor: 1 } });
for (const [templatePatch, schedulePatch, fieldName, label] of [
  [{ money: null }, {}, "amount", "missing amount"],
  [{ money: mk(NaN, "SGD") }, {}, "amount", "not a number"],
  [{ money: mk(-1, "SGD") }, {}, "amount", "negative amount"],
  [{ account_id: "missing" }, {}, "account_id", "missing account"],
  [{ category_id: C.list("income")[0].id }, {}, "category_id", "wrong category kind"],
  [{ money: mk(100, "XYZ") }, {}, "currency", "unsupported currency"],
  [{}, { start: "2026-02-30" }, "start", "impossible first date"],
  [{}, { end: "2026-02-30" }, "end", "impossible end date"],
  [{}, { interval: 0 }, "interval", "zero interval"],
  [{}, { interval: 1.5 }, "interval", "fractional interval"],
  [{}, { freq: "unknown" }, "freq", "unknown schedule"],
]) {
  const snapshot = JSON.stringify(store.snapshot()); let issue = null;
  try { T.createRule({ template: { ...rent.template, ...templatePatch }, schedule: { ...rent.schedule, ...schedulePatch } }); } catch (error) { issue = error; }
  ok(!!issue?.fields?.[fieldName], `U4 recurring: ${label} gives a named issue`);
  ok(JSON.stringify(store.snapshot()) === snapshot, `U4 recurring: ${label} writes nothing`);
  issue = null;
  try { T.updateRule(rent.id, { template: { ...rent.template, ...templatePatch }, schedule: { ...rent.schedule, ...schedulePatch } }); } catch (error) { issue = error; }
  ok(!!issue?.fields?.[fieldName] && JSON.stringify(store.snapshot()) === snapshot, `U4 recurring: invalid ${label} edit leaves the existing rule intact`);
}
const posted = T.postDue(); ok(posted.length === 4 && posted.every((p) => D.parse(p.tx.date).d === 1), `tx 11: ${posted.length} rent posts on the 1st (3 months back + this month)`);
ok(T.postDue().length === 0, "tx 11: second open posts nothing");
const nd = T.nextDue(store.get("recurring_rules", rent.id)); const sk = T.skipNext(rent.id); ok(sk === nd && T.nextDue(store.get("recurring_rules", rent.id)) === D.addMonths(nd, 1, 1), "tx 12: skip next moves due date one month");
T.update(posted[0].tx.id, { money: mk(155000, "SGD") }); ok(store.all("alerts").some((a) => a.type === "price_change"), "tx 15: edited instance → price_change alert");
// overseas mode: entry currency, and a foreign amount must not move an account by its face value
const balBefore = A.balance(bank.id).amount;
await prof.setOverseas("JPY");
ok(prof.entryCurrency(A.get(bank.id)) === "JPY", "overseas: new records start in the local currency, not the account's");
const ovTx = T.save({ kind: "expense", account_id: bank.id, money: mk(1200, "JPY"), date: today, category_id: food.id, merchant: "Ramen" });  // yen has no minor units: 1200 = ¥1,200
ok(ovTx.entered_money.currency === "JPY" && ovTx.entered_money.amount === 1200, "overseas: the record keeps what was actually paid, in yen");
ok(ovTx.money.currency === "SGD" && ovTx.money.amount === 1092, `overseas: the account moves in its own currency, 1,200 JPY at 0.0091 = ${fmt(ovTx.money)}`);
ok(A.balance(bank.id).amount === balBefore - 1092, "overseas: a yen expense takes 10.92 off a Singapore-dollar account, not 1,200");
ok(ovTx.entered_fx && ovTx.entered_fx.rate === "0.0091" && ovTx.base_money.currency === "SGD", "overseas: the rate is frozen onto the record when confirmed");
let noRate = false; try { T.save({ kind: "expense", account_id: bank.id, money: mk(5000, "BRL"), date: today, category_id: food.id }); } catch { noRate = true; }
ok(noRate, "overseas: with no rate into the account's currency the record is refused, never guessed");
await prof.setOverseas(null);
ok(prof.entryCurrency(A.get(bank.id)) === "SGD", "overseas: switched off, records go back to the account's own currency");
ok(T.get(ovTx.id).entered_money.amount === 1200 && T.get(ovTx.id).money.amount === 1092, "overseas: switching off changes nothing already recorded");
T.cancel(ovTx.id, "error");

// budgets
B.set("category", { categoryId: food.id, limit: mk(60000, "SGD") });
const st = B.status(); const fs = st.find((s) => s.category?.id === food.id); ok(fs && fs.spent.amount === 1250 && fs.left.amount === 58750, "bud: spent/left");
const r = B.set("category", { categoryId: C.children(food.id)[0].id, limit: mk(70000, "SGD") }); ok(r.warnings.length === 1, "bud 5: sub limit above group → warning, saved");
B.set("savings", { target: { percent_of_income: 20 } });
ok(B.savings().target === null && /expected income/.test(B.savings().reason || ""), "bud 9: savings % with no expected income → absent, named");
const salaryRule = T.createRule({ name: "Salary", template: { kind: "income", account_id: bank.id, money: mk(500000, "SGD"), category_id: C.list("income")[0].id }, schedule: { freq: "monthly", interval: 1, start: D.addMonths(start3, 0, 25), anchor: 25 } });
ok(B.savings().target.amount === 100000, "bud 9: 20% of expected income 5000 → target 1000");
const incTx = T.save({ kind: "income", account_id: bank.id, money: mk(500000, "SGD"), date: today, category_id: C.list("income")[0].id, merchant: "Employer" });
ok(incTx.merchant === null, "tx 5b: income stores no merchant even when one is passed in");
ok(C.ruleFor("Employer") === null, "cat: no merchant rule is learned from income");
B.set("category", { categoryId: shop.id, limit: mk(20000, "SGD"), thresholds: [80, 100] }); B.checkThresholds();
ok(store.all("alerts").some((a) => a.type === "budget_threshold" && a.dedupe_key.endsWith(":100")), "bud 14: Shopping 200 limit, 200 spent → 100% alert");
const nAlerts = store.all("alerts").length; B.checkThresholds(); ok(store.all("alerts").length === nAlerts, "bud 14: no refire");
// expected income, allocation, thresholds (2026-09-18 rebuild)
let threw2 = false; try { B.set("overall", { limit: mk(1, "SGD") }); } catch { threw2 = true; }
ok(threw2, "bud 12: overall limit cannot be set at all");
ok(B.active().every((x) => x.scope !== "overall"), "bud 12: no overall budget exists");
let tooManyThresholds; try { B.cleanThresholds(["80", "x", 300, 0, 100, 90, 95]); } catch (error) { tooManyThresholds = error; }
ok(tooManyThresholds?.form?.includes("no more than 3"), "bud 13: more than three supplied threshold points are rejected");
let invalidThreshold; try { B.cleanThresholds(["80", "x"]); } catch (error) { invalidThreshold = error; }
ok(invalidThreshold?.fields?.th1, "bud 13: invalid point gets its own named issue, not filtering");
ok(B.cleanThresholds(["100", "80", "90"]).join(",") === "80,90,100", "bud 13: three valid unsorted thresholds sort correctly");
ok(B.cleanThresholds(["100", "80", "80"]).join(",") === "80,100", "bud 13: valid duplicate thresholds deduplicate");
const ei = B.expectedIncome();
ok(ei.money && ei.money.amount === 500000 && ei.source === "rules", `bud 3: expected income from the salary rule = ${ei.money ? fmt(ei.money) : ei.reason}`);
const alloc0 = B.allocation();
const catB = B.active().filter((x) => x.scope === "category");
const sumAll = catB.reduce((s, x) => s + x.limit.amount, 0);
const gIds = new Set(catB.map((x) => C.get(x.category_id)).filter((c) => c && !c.parent_id).map((c) => c.id));
const noDouble = catB.filter((x) => { const c = C.get(x.category_id); return !c.parent_id || !gIds.has(c.parent_id); }).reduce((s, x) => s + x.limit.amount, 0);
ok(alloc0.allocated.amount === noDouble && noDouble < sumAll, "bud 7: allocated counts a group once, never the group plus its own subcategory");
ok(alloc0.leftToAllocate.amount === ei.money.amount - (alloc0.target?.amount || 0) - alloc0.allocated.amount, "bud 7: left to allocate = expected − target − allocated");
B.setOverride(mk(400000, "SGD")); ok(B.expectedIncome().money.amount === 400000 && B.expectedIncome().source === "user", "bud 5: override wins and is labelled as the user's");
B.setOverride(null); ok(B.expectedIncome().money.amount === 500000, "bud 5: clearing the override returns to the rules");
for (const r of T.rules().filter((r) => r.template.kind === "income")) T.pauseRule(r.id);
ok(B.expectedIncome().money === null && B.expectedIncome().reason, "bud 6: paused income rule → expected income absent and named");
for (const r of T.rules().filter((r) => r.template.kind === "income")) T.resumeRule(r.id);
B.set("category", { categoryId: food.id, limit: mk(900000, "SGD") });
ok(B.allocation().overAllocated && B.allocation().leftToAllocate.amount < 0, "bud 8: over-allocating shows a negative left-to-allocate, not zero");
B.set("category", { categoryId: food.id, limit: mk(60000, "SGD") });
// net worth
const nw = NW.now(); ok(nw.total !== null && nw.components.accounts.amount > 0, "nw 1: total computed with rate");
NW.createExtra("Car", "vehicle", mk(2000000, "SGD"), "2025-01-01"); ok(NW.now().detail.extras[0].as_of === "2025-01-01" && !("stale" in NW.now().detail.extras[0]) && !/stale/i.test(NW.netWorthPage().html), "nw 3: an old extra shows its date and is never called stale");
ok(NW.settings().snapshot_day === 1, "nw 6: the monthly snapshot falls on the 1st unless changed");
let snapshotDayIssue = null; const beforeBadSnapshotDay = JSON.stringify(store.snapshot());
try { NW.setSnapshotDay(40); } catch (error) { snapshotDayIssue = error; }
ok(!!snapshotDayIssue?.fields?.snapshot_day && JSON.stringify(store.snapshot()) === beforeBadSnapshotDay, "U4 nw: day 40 is refused without changing the chosen day");
NW.setSnapshotDay(31); ok(NW.settings().snapshot_day === 31, "nw 6: valid day 31 remains selectable; calendar short-month handling stays unchanged"); NW.setSnapshotDay(1);
NW.monthlyDue(); NW.monthlyDue(); ok(NW.snapshots().filter((s) => s.trigger === "monthly").length === 1, "nw 5: one monthly snapshot per month");
NW.takeSnapshot("manual");
const nwPct = NW.series("percent"), nwAmt = NW.series("amount");
ok(nwAmt.points.length >= 2 && nwPct.points.length === nwAmt.points.length, "nw 11: both chart modes draw the same points");
ok(nwPct.points[0].y === 0, "nw 11: percent mode puts the first point at 0%");
ok(nwAmt.points[0].y !== 0, "nw 11: amount mode shows the real total, not 0");
// goals
const g = G.create({ name: "Fund", target: mk(1000000, "SGD"), targetDate: D.addMonths(today, 10), accountId: bank.id });
const gs = G.status(g); ok(gs.progress.amount === 0 && gs.monthlyNeeded.amount === 100000, "goal 1: start = balance now, monthly needed 1000");
ok(!("onTrack" in gs) && !("expected" in gs), "goal 3: no on-track verdict and no expected-by-now figure, only what is needed");
const g3 = G.create({ name: "Three months", target: mk(900000, "SGD"), targetDate: D.addMonths(today, 3) }); G.contribute(g3.id, mk(300000, "SGD"), today);
ok(G.status(g3).monthlyNeeded.amount === 200000, "goal 1b: 6,000 still to find with 3 months left → needed 2,000 a month");
const h3 = G.history(g3); ok(h3.length >= 2 && h3[0].amount === 0 && h3[h3.length - 1].amount === 300000, "goal chart: a manual goal steps up from zero to what has been put in");
ok(/class="target"/.test(G.goalsPage().html) && /Needed: /.test(G.goalsPage().html) && !/class="bar"/.test(G.goalsPage().html), "goal chart: the page draws a line with a dotted target and says what is needed, with no progress bar");
G.checkAll(); ok(!store.all("alerts").some((a) => a.type === "goal_off_track"), "goal 3: no off-track alert exists any more");
const g2 = G.create({ name: "Manual", target: mk(100000, "SGD"), targetDate: D.addMonths(today, 5) }); G.contribute(g2.id, mk(30000, "SGD"), today); G.contribute(g2.id, mk(-10000, "SGD"), today); ok(G.status(g2).progress.amount === 20000, "goal 4: contributions 300 − 100 = 200");
// debts
const loan = DB.create({ name: "Loan", type: "personal", currency: "SGD", balance: mk(1200000, "SGD"), original_balance: mk(1200000, "SGD"), rate_apr: "6", rate_type: "fixed", payment: mk(50000, "SGD"), payment_day: 5, pay_from_account_id: bank.id, category_id: shop.id, started_on: today, maturity_date: D.addDays(today, 60), lock_in_until: D.addDays(today, 20), linked_account_id: null });
// Test the original 12,000 balance, regardless of whether today's repayment has already posted.
const pj = DB.projection({ ...DB.get(loan.id), balance: mk(1200000, "SGD") }); const pay = DB.payments(loan.id);
ok(pay.length === 0 || (pay[0].interest.amount === 6000 && pay[0].principal.amount === 44000), "debt 1: split 60 interest / 440 principal on first post (if posted)");
ok(pj.monthsToClear === 26 && !pj.neverClears, `debt 2: amortisation months to clear = ${pj.monthsToClear} (standard: 26)`);
const never = DB.projection({ ...DB.get(loan.id), payment: mk(5000, "SGD"), balance: mk(1200000, "SGD") }); ok(never.neverClears && never.shortfall.amount === 1000, "debt 3: 50 on 12000 @6% → never clears, shortfall 10");
ok(DB.projection({ ...DB.get(loan.id), rate_apr: null }).reason === "rate unknown", "debt 4: rate absent → projection absent, named");
const wi = DB.whatIf(DB.get(loan.id), { extraMonthly: 10000 }); ok(wi.monthsSaved > 0 && wi.interestSaved.amount > 0, "debt 5: what-if extra 100 saves months and interest");
ok(store.all("alerts").filter((a) => a.type === "debt_lockin").length === 2 && store.all("alerts").filter((a) => a.type === "debt_maturity").length === 1, "debt 7: lock-in 90+30 alerts, maturity 90 alert");
ok(String(DB.settings().lead_days) === "90,30", "debt 7b: reminders default to 90 and 30 days");
DB.update(loan.id, { lead_days: [] }); ok(DB.leadDays(DB.get(loan.id)).length === 0, "debt 7c: a loan can switch its reminders off"); DB.update(loan.id, { lead_days: null });
// insurance
const pol = I.create({ type: "health", insurer: "Pru", premium: mk(12000, "SGD"), frequency: "monthly", cover: null, renewal_date: D.addDays(today, 10), account_id: bank.id, start_date: null, end_date: null, notes: null, policy_number: null, insured: null }, true);
ok(store.all("recurring_rules").some((r) => r.name === "Pru premium"), "ins 4: premium rule created");
I.checkRenewals(); ok(store.all("alerts").filter((a) => a.type === "insurance_renewal").length === 2, "ins 1: 60 and 14 day alerts once each");
I.setDefaultLeadDays([30]); ok(String(I.leadDays(store.get("policies", pol.id))) === "30", "ins 1b: the Settings default applies to a policy with none of its own");
I.update(pol.id, { lead_days: [] }); const insBefore = store.all("alerts").filter((a) => a.type === "insurance_renewal").length; I.checkRenewals();
ok(store.all("alerts").filter((a) => a.type === "insurance_renewal").length === insBefore, "ins 1c: a policy with every box cleared gets no reminders");
I.update(pol.id, { lead_days: null }); I.setDefaultLeadDays([60, 14]);
ok(I.totals().cover === null && I.totals().reasons[0].includes("cover"), "ins 8: cover absent → total absent with reason");
I.renew(pol.id, mk(13000, "SGD")); ok(store.get("policies", pol.id).renewal_date === D.addMonths(D.addDays(today, 10), 1) && store.get("recurring_rules", store.get("policies", pol.id).recurring_rule_id).template.money.amount === 13000, "ins 2+5: renew advances one period, rule updated to 130");
// holdings
const h = H.create({ name: "X", ticker: "X", type: "etf", currency: "SGD", mode: "units" });
H.trade(h.id, "buy", "2026-01-02", "10", mk(10000, "SGD")); H.trade(h.id, "buy", "2026-02-02", "10", mk(12000, "SGD"));
let p = H.position(h); ok(p.units === 20 && p.avgCost.amount === 11000 && p.costBasis.amount === 220000, "hold 1: units 20, avg 110, cost 2200");
H.value(h.id, "2026-03-01", mk(250000, "SGD")); ok(H.position(h).pnl.amount === 30000, "hold 2: value 2500 → P&L +300");
H.trade(h.id, "sell", "2026-03-02", "5", mk(13000, "SGD")); p = H.position(h); ok(p.units === 15 && p.avgCost.amount === 11000 && p.realised.amount === 10000 && p.costBasis.amount === 165000, "hold 3: sell 5 @130 → realised +100, cost basis 1650");
threw = false; try { H.trade(h.id, "sell", "2026-03-03", "20", mk(13000, "SGD")); } catch { threw = true; } ok(threw, "hold 4: sell more than held refused");
const vf = H.create({ name: "Fund", type: "fund", currency: "SGD", mode: "value" }); H.cashFlow(vf.id, "deposit", "2026-01-01", mk(100000, "SGD")); H.cashFlow(vf.id, "deposit", "2026-02-01", mk(50000, "SGD")); H.value(vf.id, "2026-03-01", mk(170000, "SGD")); ok(H.position(vf).pnl.amount === 20000, "hold 5: value mode P&L +200");
const sm = H.summary(); ok(Math.round(sm.allocation.reduce((s, a) => s + a.pct, 0)) === 100, "hold 11: allocation sums to 100%");
// insights
const dash = INS.dashboard();
// Resuming the salary rule posts this month's salary on/after the 25th, beside the manual income.
const postedSalaries = T.live().filter((t) => t.recurring_rule_id === salaryRule.id && t.date >= dash.month.start && t.date <= dash.month.end);
ok(dash.spend.amount > 0 && dash.income.amount === 500000 + postedSalaries.length * 500000, "dash: income includes manual income and any salary already posted");
const stats = INS.statsFor(B.month()); const lev = INS.leversFor(B.month(), stats); ok(stats.merchants.length <= 10 && lev.length > 0, `briefing: stats + ${lev.length} levers from code`);
ok(JSON.stringify(stats).includes("account") === false || !JSON.stringify(stats).includes(bank.name), "briefing payload has no account names");
// Pausing prevents the generation/write altogether; shared persistence is tested separately.
let briefingSaveAck = false;
store.open(store.snapshot(), async () => { briefingSaveAck = true; });
const beforePausedBriefing = store.exportJson();
const br = await INS.buildBriefing(B.prevMonth(B.month()));
ok(br === null && store.exportJson() === beforePausedBriefing && !briefingSaveAck, "briefing: paused generation performs no request or write");
// ai validators
ok(ai.hasOrder("You should save more") && !ai.hasOrder("You could save more"), "validator: should refused");
ok(ai.digitsNotInInput("spent 1,234 on food", { x: "999" }).length === 1 && ai.digitsNotInInput("spent 1,234", { x: "1234.00" }).length === 0, "validator: numbers must exist in input");
// confidentiality: personal numbers never leave the device; amounts, dates and ids do
const sc = ai.scrubText("PAYNOW TO TAN AH KOW 9123 4567 ref 4111 1111 1111 1111 mail tan@x.com NRIC S1234567D acct 123456789012");
ok(!/9123|4111|tan@x|S1234567D|123456789012/.test(sc) && /\[phone\]/.test(sc) && /\[card\]/.test(sc) && /\[email\]/.test(sc) && /\[id\]/.test(sc) && /TAN AH KOW/.test(sc), `scrub: phone, card, email, ID and account numbers masked, the rest kept (${sc})`);
ok(ai.scrubText("2026-09-19 lunch 12.50 total 1234567.89 on 20260901") === "2026-09-19 lunch 12.50 total 1234567.89 on 20260901", "scrub: dates, amounts and compact dates are left alone");
const scrubbedIn = ai.scrub({ id: "0192f3a1-9123-4567-8abc-123456789012", ids: ["found:x|SGD|123456789"], name: "Call 9123 4567" });
ok(scrubbedIn.id === "0192f3a1-9123-4567-8abc-123456789012" && scrubbedIn.ids[0] === "found:x|SGD|123456789" && scrubbedIn.name === "Call [phone]", "scrub: ids the model hands back are left intact, text beside them is masked");
ok(ai.scrubText("a".repeat(5000)).length === ai.MAX_FIELD && ai.scrubText("NETFLIX\u202Emoc\u0000") === "NETFLIXmoc", "scrub: hidden and control characters stripped, every field capped");
// prompt injection: what gets through the code-side defences
const ATTACKS = JSON.parse(nodeFs.readFileSync(new URL("./injections.json", import.meta.url), "utf8")).attacks;
const { buildPrompt, DATA_RULE } = await import(new URL("../proxy-prompt.mjs", import.meta.url).href);
for (const atk of ATTACKS) {
  const cleaned = ai.scrub({ merchant: atk });
  const pr = buildPrompt({ task: "t", system: "S", input: cleaned });
  const inside = pr.text.slice(pr.text.indexOf("<data>") + 6, pr.text.lastIndexOf("</data>"));
  ok(!/<\/?\s*data/i.test(inside) && pr.system.endsWith(DATA_RULE) && !/\d{4} \d{4}|4111|@fake/.test(inside), `injection: fenced as data, fence unbreakable, contacts masked — ${ai.scrubText(atk).slice(0, 40)}`);
}
const pInput = { merchants: [{ name: "Amazon.com", amount: "120.00" }] };
ok(ai.validateProse("You spent 120.00 at Amazon.com.", pInput) === null, "injection: a shop name the app sent may be repeated");
ok(/link/.test(ai.validateProse("Claim it at http://refund.example", pInput) || "") && /web address/.test(ai.validateProse("Go to win-big.com now", pInput) || "") && /email/.test(ai.validateProse("Write to help@bank.co", pInput) || "") && /phone/.test(ai.validateProse("Call 9123 4567 about the 120.00", { a: "9123", b: "4567", c: "120.00" }) || ""), "injection: AI words carrying a link, a site the app never sent, an email or a phone number are refused");
// browser rules: scripts only from this server, and the browser talks to nothing else
const { CSP, SECURITY_HEADERS } = await import(new URL("../security-headers.mjs", import.meta.url).href);
const indexHtml = nodeFs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const metaCsp = (indexHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
ok(/script-src 'self'(;|$)/.test(CSP) && /connect-src 'self'(;|$)/.test(CSP) && /frame-ancestors 'none'/.test(CSP) && SECURITY_HEADERS["X-Content-Type-Options"] === "nosniff", "headers: scripts and connections only to this server, never framed");
ok(CSP.split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ") === metaCsp, "headers: the page's own copy of the rules matches the server's, for static hosts");
ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(indexHtml), "headers: no inline script in the page, so none needs an exception");
const jsFiles = (dir) => nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []));
const outbound = jsFiles(new URL("../public/js", import.meta.url).pathname).filter((f) => /fetch\(\s*[`'"]https?:/.test(nodeFs.readFileSync(f, "utf8")));
ok(!outbound.length, `headers: no browser code fetches another site${outbound.length ? " — " + outbound.join(", ") : ""}`);
// the vault: everything on the device encrypted, and three ways in
const V = await M("lib/vault.js");
V.useStorage(V.memoryStorage());
ok((await V.entropyToWords(new Uint8Array(16))).join(" ") === "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" && (await V.entropyToWords(new Uint8Array(16).fill(0x7f))).join(" ") === "legal winner thank year wave sausage worth useful legal winner thank yellow", "vault: recovery words match the BIP-39 reference vectors");
let threwV = null; try { await V.create({ passphrase: "blue kettle on a tuesday" }); } catch (e) { threwV = e.code; } ok(threwV === "NO_PRF", "vault: no app passphrase or unencrypted fallback");
const makePk = () => ({ secret: crypto.getRandomValues(new Uint8Array(32)), credId: crypto.getRandomValues(new Uint8Array(32)), prfSalt: crypto.getRandomValues(new Uint8Array(32)) });
const pk = makePk(), wrongPk = makePk();
const { words: rw } = await V.create({ passkey: pk });
ok(rw.length === 12 && (await V.status()).recoveryConfirmed === false, "vault: temporary recovery words must be confirmed");
threwV = null; try { await V.create({ passkey: pk }); } catch (e) { threwV = e.code; } ok(threwV === "EXISTS", "vault: creation cannot overwrite existing records");
V.persist({ schema_version: 1, tables: { transactions: [{ merchant: "Secret Sushi Bar", note: "anniversary" }] } }); await V.flush();
const sealedRec = JSON.stringify(await V.sealedRecord());
ok(!/Secret Sushi|anniversary|passphrase/.test(sealedRec) && !rw.some((w) => sealedRec.includes(` ${w} `)) && !sealedRec.includes(btoa(String.fromCharCode(...pk.secret))), "vault: no records, PRF secret, passphrase or words stored in readable form");
await V.lock(); ok(!V.isUnlocked(), "vault: locking drops the key");
threwV = null; try { await V.unlock({ passkeySecret: wrongPk.secret }); } catch (e) { threwV = e.code; } ok(threwV === "WRONG", "vault: another device secret opens nothing");
ok((await V.unlock({ passkeySecret: pk.secret })).tables.transactions[0].merchant === "Secret Sushi Bar", "vault: the enrolled device secret opens it");
await V.lock();
ok((await V.unlock({ words: rw.map((w) => w.slice(0, 4).toUpperCase()).join("  ") })).tables.transactions.length === 1, "vault: recovery words still open an existing local copy");
threwV = null; try { await V.unlock({ words: rw.slice(0, 11) }); } catch (e) { threwV = e.message; } ok(/12 words/.test(threwV || ""), "vault: eleven words are refused");
const rw2 = await V.replaceRecovery({ passkeySecret: pk.secret }); await V.lock();
threwV = null; try { await V.unlock({ words: rw }); } catch (e) { threwV = e.code; }
ok(threwV === "WRONG" && (await V.unlock({ words: rw2 })).tables, "vault: new recovery words replace the old ones");
threwV = null; try { await V.addPasskey({ passkeySecret: wrongPk.secret }, wrongPk); } catch (e) { threwV = e.code; } ok(threwV === "WRONG", "vault: replacing device access requires a working key");
V.persist({ tables: { transactions: [{ merchant: "Queued account A" }] } });
await V.selectOwner("account-B");
ok(!V.isUnlocked() && !(await V.status()).exists, "vault: switching account locks and selects a separate vault");
await V.create({ passkey: wrongPk }); V.persist({ tables: { transactions: [{ merchant: "Account B" }] } }); await V.lock();
threwV = null; try { await V.unlock({ passkeySecret: pk.secret }); } catch (e) { threwV = e.code; }
ok(threwV === "WRONG" && (await V.unlock({ passkeySecret: wrongPk.secret })).tables.transactions[0].merchant === "Account B", "vault: account A's credential cannot open B");
await V.selectOwner("local-device");
ok((await V.unlock({ passkeySecret: pk.secret })).tables.transactions[0].merchant === "Queued account A", "vault: a queued write finishes in its original account, never the new account");
const hints = await V.passkeyHints();
ok(hints.length === 2 && hints.some((h) => h.owner === "account-B") && !JSON.stringify(hints).includes("merchant"), "vault: sign-in discovery exposes only credential IDs and public PRF salts");
// Temporary manual backups use recovery words, not an app passphrase.
const bk = await V.sealBackup({ tables: { transactions: [{ merchant: "Secret Sushi Bar" }] } }, { words: rw2 });
ok(V.isSealedBackup(bk) && !JSON.stringify(bk).includes("Sushi"), "backup: the file holds nothing readable");
ok((await V.openBackup(bk, { words: rw2 })).tables.transactions[0].merchant === "Secret Sushi Bar", "backup: recovery words open it");
threwV = null; try { await V.openBackup(bk, { words: rw }); } catch (e) { threwV = e.code; } ok(threwV === "WRONG", "backup: wrong words open nothing");
ok(!V.isSealedBackup({ ...bk, kdf: { kind: "passphrase" } }), "backup: old disposable passphrase backups are not imported");
await V.destroy(); ok(!(await V.status()).exists, "vault: wiping removes only the selected vault");
await V.selectOwner("account-B"); ok((await V.status()).exists, "vault: wiping A does not remove B"); await V.destroy(); await V.selectOwner("local-device");
// assistant queries (code path, no AI)
ok(AS.amountFromText('1.005k','USD').amount===100500 && AS.amountFromText('1,25','USD')===null, 'assistant: shorthand expands before currency precision; malformed grouping is rejected');
const assistantFood=AS.runQuery({ kind: "spend_by_category", params: { category: "food" } });
ok(assistantFood.display[0].category === "Food" && assistantFood.data[0].category_id === food.id, "assistant: spending query returns the exact category and code figures");
ok(AS.REFUSAL.includes("can't give financial advice") && AS.REFUSAL.includes("licensed financial adviser"), "assistant 5: the approved refusal line");
ok(AS.amountFromText("5k", "SGD").amount === 500000 && AS.amountFromText("S$5,000", "SGD").amount === 500000 && AS.amountFromText("1.5m SGD", "SGD").amount === 150000000 && AS.amountFromText("12", "SGD").amount === 1200, "assistant: 5k is 5,000, worked out by code, never read as 5");
const abortedChat = new AbortController(); abortedChat.abort();
const chatCounts = [store.all("conversations").length, store.all("alerts").length];
await AS.send("this request was cancelled", { signal: abortedChat.signal });
ok(JSON.stringify([store.all("conversations").length, store.all("alerts").length]) === JSON.stringify(chatCounts), "assistant: an already-cancelled send saves nothing");
const rejectsAssistant=(kind,params)=>{try{AS.cleanParams(kind,params);return false;}catch{return true;}};
ok(rejectsAssistant("upcoming_bills",{days:99999,sql:"drop table"}) && rejectsAssistant("log_transaction",{kind:"transfer"}) && rejectsAssistant("log_transaction",{date:"tomorrow"}) && rejectsAssistant("log_transaction",{run:"rm -rf"}) && rejectsAssistant("wipe_everything",{confirm:true}), "assistant: unsupported operations, injected fields and invalid values are rejected, not silently cleaned");
ok(AS.cleanParams("log_transaction",{amount_text:"5k",note:"n".repeat(500)}).note.length===500 && AS.cleanParams("upcoming_bills",{from:today,to:D.addMonths(today,24)}).to===D.addMonths(today,24), "assistant: valid supplied text/dates are not silently truncated or capped");
// Retire the obsolete single-file switch-layout assertion. Check the actual dispatcher boundary.
let unknownReadRejected=false;try{AS.runQuery({kind:"wipe_everything",params:{}});}catch{unknownReadRejected=true;}
const {openDraft:boundaryDraft}=await M("features/assistant-actions.js");let unknownDraftReason="";const boundaryBefore=store.exportJson();boundaryDraft({kind:"wipe_everything",params:{}},{onMessage:s=>unknownDraftReason=s});
ok(unknownReadRejected && unknownDraftReason && store.exportJson()===boundaryBefore, "assistant: unregistered reads/drafts cannot escape the code-owned operation boundary");
ok(AS.QUERY_KINDS.length + AS.ACTION_KINDS.length === Object.keys(AS.BUTTONS).length && !AS.NEVER.some((k) => AS.BUTTONS[k]), "assistant: the never-list is not on the button list at all");
ok(AS.ACTION_KINDS.includes("create_goal") && AS.NEVER.every((k) => !AS.ACTION_KINDS.includes(k) && AS.HOW_TO[k]), "assistant 13: it can set up a goal; export, wipe, base currency and AI off are never actions, and each has directions");
ok(["transfer", "create_recurring", "log_investment_value", "add_account"].every((k) => AS.ACTION_KINDS.includes(k)), "assistant: it can also move money between accounts, set up a recurring rule, log an investment's value and open an account, each through its own form");
ok(rejectsAssistant("create_recurring",{freq:"fortnightly"}) && rejectsAssistant("create_recurring",{start_date:"next week"}) && rejectsAssistant("create_recurring",{shell:"rm -rf"}), "assistant: invalid schedules and executable fields are rejected");
ok(rejectsAssistant("add_account",{account_type:"crypto"}) && rejectsAssistant("add_account",{currency:"usd"}) && AS.cleanParams("add_account",{name:"DBS",currency:"USD"}).currency==="USD", "assistant: unsupported account types/noncanonical currencies are rejected; a valid currency is retained");
// the bottom bar reads this: consent on puts the Assistant in the bar, consent off takes it out entirely
ok(ai.consented() === true, "assistant 11: consent on, so the Assistant has an entry point");
const pr = store.one("profile"); store.update("profile", pr.id, { consent: { ...pr.consent, ai_provider: false } });
ok(ai.consented() === false && ai.enabled() === false, "assistant 11: consent off disables chat; the bar uses Budgets and Home offers permission setup");
store.update("profile", pr.id, { consent: { ...pr.consent, ai_provider: true } });
// csv mapping
const rows = T.parseCsv('Date,Description,Debit,Credit\n"01/09/2026","Coffee, big",4.50,\n02/09/2026,Salary,,1000\nbad,x,1,\n');
const mapped = T.applyMapping(rows.slice(1), rows[0], { date_col: "Date", debit_col: "Debit", credit_col: "Credit", description_col: "Description", date_format: "DD/MM/YYYY", negative_means: "expense" }, "SGD");
ok(mapped[0].status === "ready" && mapped[0].parsed.kind === "expense" && mapped[0].parsed.money.amount === 450 && mapped[0].parsed.date === "2026-09-01", "csv: debit row parsed with quoted comma");
ok(mapped[1].parsed.kind === "income" && mapped[1].parsed.money.amount === 100000 && mapped[2].status === "failed", "csv: credit row income, bad date failed with reason");
const refRows = T.parseCsv("Date,Ref,Desc,Amount\n2026-09-01,TX1,Coffee,-4.50\n2026-09-01,TX2,Coffee,-4.50\n");
const refMapped = T.applyMapping(refRows.slice(1), refRows[0], { date_col: "Date", amount_col: "Amount", description_col: "Desc", reference_col: "Ref", date_format: "YYYY-MM-DD", negative_means: "expense" }, "SGD");
ok(refMapped[0].parsed.bank_ref === "TX1" && refMapped[1].parsed.bank_ref === "TX2", "csv: the bank's own reference is read when the file has one");
T.save({ ...refMapped[0].parsed, account_id: bank.id, source: "csv" });
ok(T.findDuplicate({ ...refMapped[0].parsed, account_id: bank.id }) && !T.findDuplicate({ ...refMapped[1].parsed, account_id: bank.id }), "csv: same reference → duplicate; two coffees with different references are two coffees");
// recurring detection: noticed, asked, never set up without a yes
const gymCo = [2, 1, 0].map((k) => T.save({ kind: "expense", account_id: bank.id, money: mk(4900, "SGD"), date: D.addMonths(today, -k), category_id: shop.id, merchant: "Gym Co" }));
let cands = T.detectRecurring(); let gc = cands.find((c) => c.merchant === "Gym Co");
ok(gc && gc.label === "every month" && gc.count === 3 && gc.last === today, "detect: the same charge three months running is noticed as monthly");
ok(!T.rules().some((r) => r.template.merchant === "Gym Co"), "detect: noticing writes nothing; no rule exists until the user says yes");
for (let k = 0; k < 6; k++) T.save({ kind: "expense", account_id: bank.id, money: mk(450, "SGD"), date: D.addDays(today, -k), category_id: food.id, merchant: "Daily Coffee" });
ok(!cands.concat(T.detectRecurring()).some((c) => c.merchant === "Daily Coffee"), "detect: anything bought every day is not a rhythm, whatever it is");
let ago = 0; for (const gap of [0, 3, 9, 4, 11, 2, 6]) { ago += gap; T.save({ kind: "expense", account_id: bank.id, money: mk(680, "SGD"), date: D.addDays(today, -ago), category_id: food.id, merchant: "Noodle Stall" }); }
ok(!T.detectRecurring().some((c) => c.merchant === "Noodle Stall"), "detect: the same price at uneven gaps is not a rhythm either");
[21, 14, 7, 0].forEach((k) => T.save({ kind: "expense", account_id: bank.id, money: mk(1200, "SGD"), date: D.addDays(today, -k), category_id: food.id, merchant: "Salad Bar" }));
const salad = T.detectRecurring().find((c) => c.merchant === "Salad Bar");
ok(salad && salad.label === "every week" && !T.subscriptions().some((x) => x.name === "Salad Bar"), "detect: a same-price weekly purchase is asked about, but not counted as a subscription unless set up");
T.save({ kind: "expense", account_id: bank.id, money: mk(2000, "SGD"), date: D.addMonths(today, -6), merchant: "Old Club" }); T.save({ kind: "expense", account_id: bank.id, money: mk(2000, "SGD"), date: D.addMonths(today, -5), merchant: "Old Club" }); T.save({ kind: "expense", account_id: bank.id, money: mk(2000, "SGD"), date: D.addMonths(today, -4), merchant: "Old Club" });
ok(!T.detectRecurring().some((c) => c.merchant === "Old Club"), "detect: a charge that stopped months ago is not offered");
T.checkRecurring(); ok(store.all("alerts").some((a) => a.type === "recurring_candidate" && /Gym Co/.test(a.title) && /recurring transaction/.test(a.body)), "detect: an alert asks 'we noticed … make it a recurring transaction?'");
T.checkRecurring(); ok(store.all("alerts").filter((a) => a.type === "recurring_candidate" && /Gym Co/.test(a.title)).length === 1, "detect: asked once, not on every open");
const gymRule = T.createRule({ name: "Gym Co", template: { kind: "expense", account_id: bank.id, money: gc.money, category_id: shop.id, merchant: "Gym Co" }, schedule: { freq: "monthly", interval: 1, start: gc.last } });
T.linkCandidate(gc, gymRule); const postedGym = T.postDue().filter((x) => x.rule.id === gymRule.id);
ok(postedGym.length === 0 && gymCo.every((x) => T.get(x.id).recurring_rule_id === gymRule.id) && T.nextDue(T.rules().find((r) => r.id === gymRule.id)) === gc.next, "detect: yes makes a rule, the charges on record become its past, nothing is posted twice");
ok(!T.detectRecurring().some((c) => c.merchant === "Gym Co") && store.all("alerts").find((a) => /Gym Co/.test(a.title)).dismissed_at, "detect: once set up it is no longer offered, and its alert is put away");
[2, 1, 0].forEach((k) => T.save({ kind: "expense", account_id: bank.id, money: mk(1299, "SGD"), date: D.addMonths(today, -k), category_id: ent.id, merchant: "StreamBox" }));
const sb = T.detectRecurring().find((c) => c.merchant === "StreamBox"); T.ignoreCandidate(sb);
ok(!T.detectRecurring().some((c) => c.merchant === "StreamBox"), "detect: 'Not recurring' means it is never offered again");
// export/import round trip
const json = store.exportJson(); const n1 = store.all("transactions").length; store.importJson(json); ok(store.all("transactions").length === n1, "export/import round trip");
// investments: returns maths (investments.md acceptance 14-16)
const freshProfile = () => { store.wipe(); prof.createProfile({ base_currency: "SGD", timezone: "Asia/Singapore", self_description: "working", ai_provider: false }); };
freshProfile();
let iv = H.create({ name: "Fund", type: "fund", currency: "SGD", mode: "value" });
H.cashFlow(iv.id, "deposit", "2026-01-01", mk(100000, "SGD")); H.value(iv.id, "2026-07-01", mk(110000, "SGD"));
let rr = H.returns("2026-07-01");
ok(Math.abs(rr.simplePct - 10) < 0.0001, `inv 14: 1,000 in and 1,100 now → simple return 10% (got ${rr.simplePct?.toFixed(2)})`);
ok(rr.dollarWeightedPct > 15 && rr.dollarWeightedPct < 26, `inv 14: same money over half a year → annualised ~21% (got ${rr.dollarWeightedPct?.toFixed(1)})`);
ok(rr.dwPeriod === "6 months", `inv 3: a yearly rate from under a year names its period (got ${rr.dwPeriod})`);
const dwSer = H.series("dollar_weighted"); ok(dwSer.points.some((pt) => pt.y != null && /a yearly rate from/.test(pt.note || "")), "inv 3: under a year the line is drawn, and each such point says what period it came from");
// Frozen FX: US$1,000 put in on a day when a dollar was 1.30 is S$1,300 for ever.
freshProfile();
fx.setUserRateOn("USD", "SGD", "2016-01-04", "1.30");
const usd = H.create({ name: "US fund", type: "fund", currency: "USD", mode: "value" });
H.cashFlow(usd.id, "deposit", "2016-01-04", mk(100000, "USD"));
fx.setUserRate("USD", "SGD", "1.40"); H.value(usd.id, today, mk(150000, "USD"));
rr = H.returns(today);
ok(rr.netContributed.amount === 130000 && rr.value.amount === 210000, `inv 4: put in S$1,300 at that day's rate, worth S$2,100 at today's (got ${rr.netContributed?.amount}, ${rr.value?.amount})`);
fx.setUserRate("USD", "SGD", "1.50"); rr = H.returns(today);
ok(rr.netContributed.amount === 130000 && rr.value.amount === 225000, "inv 4: today's rate moving changes what it is worth, never what was put in");
ok(fx.rateOn("USD", "SGD", "2016-01-09")?.rate === "1.30" && fx.rateOn("USD", "SGD", "2016-01-20") === null, "inv 4: a weekend borrows the last rate within a week; a month later does not");
threw = false; try { H.cashFlow(usd.id, "deposit", "2019-03-01", mk(1000, "USD")); } catch (e) { threw = Boolean(e.fields?.rate) && e.rate_pair?.from === 'USD' && e.rate_pair?.to === 'SGD' && e.rate_pair?.date === '2019-03-01'; } ok(threw, "inv 4: a foreign entry with no rate is refused with its exact currency pair and day");
store.insert("cash_flows", { holding_id: usd.id, kind: "deposit", date: "2017-01-03", money: mk(1000, "USD"), transaction_id: null });
ok(H.returns(today).netContributed === null && H.returns(today).reasons.some((r) => /saved conversion absent/.test(r)), "inv 4: an old entry without a frozen conversion stays absent, never restated at today's rate");
ok(/not financial advice/.test(H.DISCLAIMER) && /licensed financial adviser/.test(H.DISCLAIMER_FULL) && /<details class="disclaimer"/.test(H.investmentsPage().html), "inv 12: the short disclaimer on the screen, the full one a tap behind it");
ok(!/stale|over 30 days/i.test(H.investmentsPage().html) && /as of/.test(H.investmentsPage().html), "inv 2: values always show their date and are never called stale");
// Records too take the rate of their own date (ruling 11: investment entries freeze "as records are").
{
  freshProfile();
  const D0 = await import("../public/js/lib/dates.js");
  const usdBank = A.create({ name: "US bank", type: "bank", currency: "USD", openingBalance: mk(0, "USD"), openedOn: "2015-01-01" });
  fx.setUserRateOn("USD", "SGD", "2016-01-04", "1.30"); fx.setUserRate("USD", "SGD", "1.40");
  const old = T.save({ kind: "expense", account_id: usdBank.id, money: mk(10000, "USD"), date: "2016-01-05", merchant: "Old shop" });
  ok(old.base_money?.amount === 13000 && old.fx?.on === "2016-01-05", `fx: a record dated 2016 is frozen at that week's 1.30, not today's 1.40 (got ${old.base_money?.amount})`);
  const now = T.save({ kind: "expense", account_id: usdBank.id, money: mk(10000, "USD"), date: today, merchant: "New shop" });
  ok(now.base_money?.amount === 14000, "fx: a record dated today takes today's rate");
  const lastWeek = T.save({ kind: "expense", account_id: usdBank.id, money: mk(10000, "USD"), date: D0.addDays(today, -3), merchant: "Last week" });
  ok(lastWeek.base_money === null, "fx: even a recent past day needs an entered historical rate, never a later current rate");
  const lastYear = T.save({ kind: "expense", account_id: usdBank.id, money: mk(10000, "USD"), date: "2019-06-03", merchant: "No rate" });
  ok(lastYear.base_money === null, "fx: long ago with no rate for that day, the amount in SGD is left absent, never restated at today's rate");
  fx.setUserRateOn("USD", "SGD", "2019-06-03", "1.36");
  T.update(lastYear.id, { date: "2019-06-03", money: mk(10000, "USD") });
  ok(T.get(now.id).base_money.amount === 14000, "fx: other records keep what they were frozen at");
  const redated = T.update(old.id, { date: "2019-06-04" });
  ok(redated.base_money?.amount === 13600, `fx: moving a record to another day takes that day's rate (got ${redated.base_money?.amount})`);
}
freshProfile();
iv = H.create({ name: "Fund2", type: "fund", currency: "SGD", mode: "value" });
H.cashFlow(iv.id, "deposit", "2025-01-01", mk(100000, "SGD")); H.cashFlow(iv.id, "deposit", "2025-12-01", mk(100000, "SGD")); H.value(iv.id, "2025-12-31", mk(210000, "SGD"));
rr = H.returns("2025-12-31");
ok(Math.abs(rr.simplePct - 5) < 0.0001, `inv 15: simple return 5% (got ${rr.simplePct?.toFixed(2)})`);
ok(rr.dollarWeightedPct > rr.simplePct, `inv 15: dollar-weighted ${rr.dollarWeightedPct?.toFixed(1)}% beats simple 5%, because the second 1,000 was invested for one month`);
freshProfile();
iv = H.create({ name: "Fund3", type: "fund", currency: "SGD", mode: "value" }); H.value(iv.id, "2026-06-01", mk(50000, "SGD"));
rr = H.returns("2026-06-01");
ok(rr.simplePct === null && rr.dollarWeightedPct === null && rr.reasons.length > 0, "inv 16: nothing contributed → both returns absent and named");
ok(H.series("amount").points.some((p) => p.y != null), "inv 16: amount mode still draws with no contributions");
ok(H.series("simple").reason, "inv 16: simple mode says why it cannot draw");
iv = H.create({ name: "NoValue", type: "stock", currency: "SGD", mode: "value" });
ok(H.valueAt("2026-06-01").missing.some((m) => m.startsWith("NoValue")), "inv 18: a holding with no value is named, never counted as zero");
ok(H.xirr([{ date: "2026-01-01", amount: -1000 }, { date: "2027-01-01", amount: 1100 }]) > 0.099, "inv: xirr solves a plain one-year 10%");
ok(H.xirr([{ date: "2026-01-01", amount: -1000 }]) === null, "inv: xirr refuses a single flow rather than guessing");
ok(H.xirr([{ date: "2026-01-01", amount: -1000 }, { date: "2027-01-01", amount: -500 }]) === null, "inv: xirr refuses flows with no sign change");

// seed on a fresh profile
store.wipe(); prof.createProfile({ base_currency: "SGD", timezone: "Asia/Singapore", self_description: "working", ai_provider: false });
seed.seedDemo(); const c = store.counts(); ok(c.accounts === 4 && c.transactions > 700 && c.budgets === 4 && c.goals === 2 && c.debts === 1 && c.policies === 3 && c.holdings === 6 && c.nw_snapshots === 25, `seed: ${JSON.stringify(c)}`);
// Two years of everyday money, so budgets, briefings and the net worth line all have a past to read.
const txDates = T.live().map((x) => x.date).sort();
ok(D.daysBetween(txDates[0], today) > 700, `seed: records run back two years, from ${txDates[0]}`);
// The current month may only be a day old; require density in the 24 completed months instead.
const completedMonths = Array.from({ length: 24 }, (_, i) => D.addMonths(today, i - 24, 1).slice(0, 7));
ok(completedMonths.every((m) => T.live().filter((x) => x.date.slice(0, 7) === m).length > 10), "seed: every completed month in the two years has records, with no empty gaps");
ok(txDates.every((d) => d <= today), "seed: an incomplete current month has no future records");
ok(NW.priorMonthly() && NW.priorMonthly().taken_at.slice(0, 10) < today, "net worth: the change is measured against a snapshot from an earlier day, never today's own");
const nwPts = NW.series("amount").points;
ok(nwPts.length >= 24 && nwPts.every((pt) => pt.y != null), "seed: the net worth line has a point a month for two years");
ok(store.all("nw_snapshots").every((sn) => Math.abs(sn.total.amount - (sn.components.accounts.amount + sn.components.holdings.amount + sn.components.extras_assets.amount - sn.components.credit.amount - sn.components.debts.amount - sn.components.extras_liabilities.amount)) < 2), "seed: each backdated snapshot adds up from its own parts");
// Investments are held for years, so the demo has to cover years or the returns lines say nothing.
const invTypes = new Set(H.list("active").map((h) => h.type));
ok(invTypes.has("etf") && invTypes.has("stock") && invTypes.has("bond") && invTypes.has("fund") && invTypes.has("crypto"), `seed: the demo portfolio mixes kinds — ${[...invTypes].join(", ")}`);
const invDates = [...new Set(store.all("valuations").map((v) => v.date))].sort();
ok(invDates.length >= 20 && D.daysBetween(invDates[0], today) > 3500, `seed: ten years of dated values, ${invDates.length} dates from ${invDates[0]}`);
ok(H.series("amount").points.length >= 20 && H.series("dollar_weighted").points.some((p) => p.y != null), "seed: the investment history draws, in amount and in dollar-weighted return");
// Subscriptions and the briefing's levers, on the demo's two years of money.
const subs = T.subscriptions(), subNames = subs.map((x) => x.name);
ok(subNames.includes("Netflix") && subNames.includes("Anytime Fitness") && !subNames.includes("Landlord") && !subs.some((x) => x.rule?.owner === "debt") && !subs.some((x) => /premium/i.test(x.rule?.name || "")), `subs: regular payments listed, housing, loans and insurance left out (${subNames.join(", ")})`);
ok(["YouTube Premium", "Disney+", "iCloud"].every((n) => subs.find((x) => x.name === n)?.found) && !subs.find((x) => x.name === "Netflix").found, "subs: charges noticed but never set up are on the list, marked as such");
ok(subs.every((x, i) => i === 0 || subs[i - 1].perYear.amount >= x.perYear.amount) && T.subscriptionTotals(subs).perYear.amount === subs.reduce((t, x) => t + x.perYear.amount, 0), "subs: dearest first, and the total is the sum");
const lastM = B.prevMonth(B.month()), levs = INS.leversFor(lastM);
const rank = { low: 0, medium: 1, high: 2 };
ok(levs.length > 0 && levs[0].id === "subscriptions" && levs.every((l, i) => i === 0 || rank[levs[i - 1].effort] <= rank[l.effort]), `insights: easiest first, subscriptions leading (${levs.map((l) => l.id).join(", ")})`);
ok(!levs.some((l) => /bill|goal|savings/.test(l.id)), "insights: bills due, goal shortfall and savings gap are background, not savings to act on");
const { input: bIn } = INS.briefingInput(lastM);
const netflix = bIn.subscriptions.find((x) => x.name === "Netflix"), gym = bIn.subscriptions.find((x) => x.name === "Anytime Fitness");
const okOut = { summary: "Most went on food.", options: [{ lever_id: bIn.levers[0].id, prose: "You pay for a few things each month." }, { lever_id: bIn.levers[1].id, prose: "Here is another." }], overlaps: [] };
ok(INS.validateBriefing(okOut, bIn) === null, "insights: a well-formed briefing passes");
ok(INS.validateBriefing({ ...okOut, options: [...okOut.options].reverse() }, bIn) === "levers out of the order given", "insights: the model may skip a lever but never reorder them");
ok(/numbers not in input/.test(INS.validateBriefing({ ...okOut, summary: "You could save 987.65 a year." }, bIn) || ""), "insights: a number the input does not hold is refused");
ok(/unknown subscription/.test(INS.validateBriefing({ ...okOut, overlaps: [{ ids: [netflix.id, "made-up"], kind: "video" }] }, bIn) || ""), "insights: an overlap naming a subscription that does not exist is refused");
const disney = bIn.subscriptions.find((x) => x.name === "Disney+");
ok(disney && disney.set_up === false, "insights: a noticed charge reaches the briefing, flagged as not set up");
const ocd = INS.overlapCosts([{ ids: [netflix.id, disney.id], kind: "video streaming" }]);
ok(ocd[0].names.join("+") === "Netflix+Disney+" && ocd[0].perMonth.amount === 1590 + 1398, "insights: an overlap can pair a set-up subscription with a noticed one");
const oc = INS.overlapCosts([{ ids: [netflix.id, gym.id], kind: "test" }]);
ok(oc[0].perMonth.amount === subs.find((x) => x.name === "Netflix").perMonth.amount + subs.find((x) => x.name === "Anytime Fitness").perMonth.amount, "insights: the model groups overlaps, code adds up what they cost together");
ok(!JSON.stringify(bIn).includes("Main bank") && !/"note"/.test(JSON.stringify(bIn)), "insights: the briefing payload carries no account names and no notes");
const d2 = INS.dashboard(); ok(d2.nw.total !== null && d2.budgets.length === 3, "seed dashboard complete: " + (d2.nw.total ? fmt(d2.nw.total) : d2.nw.incomplete_reasons));
// backups: a reminder when the data lives only here and has changed; the home-screen hint
const BK = await M("features/backup.js"), INST = await M("features/install.js");
const bkProf = store.one("profile");
store.update("profile", bkProf.id, { created_at: new Date().toISOString() });
ok(BK.due() === null, "backup: no nagging on the first day");
store.update("profile", bkProf.id, { created_at: new Date(Date.now() - 2 * 86400000).toISOString() });
const dueNow = BK.due(); ok(dueNow && dueNow.last === null && dueNow.changes > 100 && /only on this device/.test(BK.nudgeHtml()), `backup: never backed up, a day on → reminded, ${dueNow?.changes} changes to lose`);
BK.snooze(3); ok(BK.due() === null, "backup: 'Later' holds it off");
store.upsertOne("backup_state", { ...BK.state(), last_backup_at: new Date().toISOString(), snooze_until: null });
ok(BK.due() === null && BK.changesSince(BK.state().last_backup_at) === 0, "backup: just backed up → nothing to remind about");
store.upsertOne("backup_state", { ...BK.state(), last_backup_at: new Date(Date.now() - 8 * 86400000).toISOString() });
const anAcct = store.all("accounts")[0]; store.update("accounts", anAcct.id, { name: anAcct.name });
ok(BK.due()?.changes >= 1, "backup: a week on with a change since → reminded again");
BK.setRemind("off"); ok(BK.due() === null, "backup: reminders can be switched off"); BK.setRemind("week");
ok(/home screen/.test(INST.hintHtml()), "install: the hint says to put the app on the home screen");
Object.defineProperty(globalThis, "navigator", { value: { storage: null, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, configurable: true });
ok(/Add to Home Screen/.test(INST.hintHtml()) && /7 days/.test(INST.hintHtml()), "install: on an iPhone it names the two taps, and why");
Object.defineProperty(globalThis, "navigator", { value: { storage: null, userAgent: "Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0" }, configurable: true });
ok(/Safari or Chrome/.test(INST.hintHtml()), "install: inside WeChat's browser it says to open the link in Safari or Chrome");
Object.defineProperty(globalThis, "navigator", { value: { storage: null }, configurable: true });
// charts replace tables where the reader was doing the work
const dPage = DB.debtDetailPage(store.all("debts")[0].id).html;
ok(/viz-wrap/.test(dPage) && /<details/.test(dPage), "debts: the payoff curve leads and the month-by-month table moves behind a disclosure");
const nwPage = NW.netWorthPage().html;
ok(/href="#\/networth\/assets"/.test(nwPage) && /href="#\/networth\/liabilities"/.test(nwPage) && !/Credit cards<\/h2>|Loans<\/h2>|Monthly only|Monthly \+ manual/.test(nwPage), "net worth: the page is the number, its history, and two folders; no item lists, no monthly/manual toggle");
const nwAssets = NW.netWorthPartPage("assets").html, nwLiabs = NW.netWorthPartPage("liabilities").html;
ok(/Accounts<\/h2>/.test(nwAssets) && /Investments<\/h2>/.test(nwAssets) && /Property, vehicles and other<\/h2>/.test(nwAssets) && /href="#\/investments\//.test(nwAssets) && /Car/.test(nwAssets), "net worth: Assets holds accounts, investments and property, each item one tap from its page");
ok(/Credit cards<\/h2>/.test(nwLiabs) && /Loans<\/h2>/.test(nwLiabs) && /Car loan/.test(nwLiabs) && /href="#\/debts\//.test(nwLiabs) && /Other owed<\/h2>/.test(nwLiabs), "net worth: Liabilities holds cards, loans and anything else owed");
ok(/Investments/.test(nwAssets) && !/>Holdings</.test(nwAssets + nwPage), "net worth: the section reads Investments");

// Fixed Home and reused panel designs. The demo maths fixture above deliberately has AI off.
const homeProfile = prof.profile();
store.update("profile", homeProfile.id, { consent: { ...homeProfile.consent, ai_provider: true } });
const W = await M("features/widgets.js");
const dflt = W.layout();
ok(dflt[0].key === "budget" && dflt[0].size === "4x2" && dflt.filter((w) => w.kind === "widget").length === 1, "home: one Budget panel leads, always 4x2");
ok(dflt.slice(1).every((w) => w.kind === "shortcut") && dflt.length === 12, "home: all eleven function icons follow the one panel");
ok(dflt.filter((w) => w.kind === "shortcut").every((w) => w.size === "1x1" && W.SHORTCUTS[w.key]), "home: a shortcut is always one tile and always points at a feature");
ok(["categories", "recurring", "alerts"].every((k) => W.SHORTCUTS[k]), "home: setup functions are discoverable beside finance features");
ok(W.panelChoices().join() === Object.keys(W.CATALOGUE).filter((k) => W.CATALOGUE[k].sizes.includes("4x2") && !["assistant", "briefing", "spend_breakdown"].includes(k)).join(), "home: only unpaused 4x2 designs are offered even with consent on");
ok(["add", "records", "assistant", "settings"].every(k => !W.SHORTCUTS[k]), "home: only the four duplicated bottom-bar functions leave the grid");
ok(/data-action="home-panel"/.test(prof.settingsPage().html), "settings: discoverable Home panel choice exists");
const homeHtml = W.homePage().html;
ok(!/Top panel|name="home_panel"/.test(homeHtml), "home: no persistent label or selector");
ok(/class="tile shortcut"/.test(homeHtml) && /data-wid="shortcut:/.test(homeHtml) && /class="tile widget/.test(homeHtml), "home: the wall draws feature icons and widgets in one grid");
const wFail = [], wThin = [];
for (const [k, c] of Object.entries(W.CATALOGUE)) for (const size of c.sizes) {
  let r; try { r = c.render(size); } catch (e) { wFail.push(`${k}/${size}: ${e.message}`); continue; }
  if (r == null) { wFail.push(`${k}/${size} drew nothing`); continue; }
  // A size has to be earned: a bigger tile needs a body, or at least a value with a line under it.
  const hasBody = Boolean(r.body && String(r.body).trim());
  if (size === "1x1" && r.value == null && !hasBody) wThin.push(`${k}/1x1 has no number`);
  if (size !== "1x1" && !hasBody && !(r.value != null && r.sub)) wThin.push(`${k}/${size} would be mostly empty`);
}
ok(wFail.length === 0, `home 2: every widget draws at every size it offers${wFail.length ? " — " + wFail.join("; ") : ""}`);
ok(wThin.length === 0, `home: no widget offers a size it cannot fill${wThin.length ? " — " + wThin.join("; ") : ""}`);
ok(/class="spark"/.test(W.CATALOGUE.net_worth.render("2x2").body || ""), "widgets: existing net worth sparkline design is preserved");
ok(/nw-line/.test(W.CATALOGUE.net_worth.render("4x2").body || ""), "home: at 4x2 net worth draws the solid line with its causes stacked behind");
const nwComp = NW.composition();
ok(nwComp.length > 1 && nwComp[0].up.length === 1 && nwComp[0].down.length === 1 && nwComp.every((pt) => Math.abs(pt.up[0].value - pt.down[0].value - pt.net) < 0.02), "net worth: two bands, assets and liabilities, and the line is exactly their difference");
ok(Math.abs(nwComp[0].up.reduce((t, x) => t + x.value, 0) - nwComp[0].down.reduce((t, x) => t + x.value, 0) - nwComp[0].net) < 0.02, "net worth: owned minus owed equals the line, to the cent");
ok(/temporarily unavailable/.test(W.CATALOGUE.spend_breakdown.render("4x2").body || ""), "home: paused Deep-dive panel exposes no figures");
ok(!/<pie|donut/i.test(Object.values(W.CATALOGUE).map((c) => c.sizes.map((z) => { try { return JSON.stringify(c.render(z)); } catch { return ""; } }).join("")).join("")), "home: no pie anywhere; part-to-whole uses a proportional bar");
ok(W.CATALOGUE.uncategorised.sizes.length === 1 && W.CATALOGUE.uncategorised.sizes[0] === "1x1", "home: a one-number widget offers only 1x1");
const fixedIcons = JSON.stringify(dflt.slice(1));
const financeBefore = store.exportJson();
for (const key of W.panelChoices()) {
  W.selectPanel(key);
  ok(W.panelKey() === key && W.layout()[0].size === "4x2" && JSON.stringify(W.layout().slice(1)) === fixedIcons, `home: choosing ${key} changes only the top panel`);
}
const homeSnapshot = store.snapshot();
store.open(homeSnapshot);
ok(W.panelKey() === W.panelChoices().at(-1), "home: the last available choice survives reopening the store");
const financeAfter = store.snapshot();
delete financeAfter.tables.home_layout;
const financeOriginal = JSON.parse(financeBefore); delete financeOriginal.tables.home_layout;
ok(JSON.stringify(financeAfter) === JSON.stringify(financeOriginal), "home: choices touch no financial or profile data");
W.selectPanel("investments");
ok(W.homePage().html.includes(H.DISCLAIMER), "home: Investments shows the short disclaimer");
for (const key of ["gone_forever", "uncategorised", "__proto__", "constructor", ""]) {
  store.upsertOne("home_layout", { panel_key: key });
  ok(W.panelKey() === "budget", `home: invalid saved key ${key || '(empty)'} defaults safely`);
  let rejected = false; try { W.selectPanel(key); } catch { rejected = true; }
  ok(rejected, "home: unavailable choices cannot be saved");
}
store.upsertOne("home_layout", { panel_key: undefined, widgets: [{ kind: "shortcut", key: "settings", order: 0 }, { key: "goals", size: "4x2" }] });
ok(W.panelKey() === "budget" && JSON.stringify(W.layout().slice(1)) === fixedIcons, "home: old movable layouts do not change the fixed grid");
W.selectPanel("goals");
ok(!store.exportJson().includes('"widgets"'), "home: choosing clears the legacy layout field");
ok(G.list("active").every((g) => G.status(g).pct > 0), "seed: a demo goal shows real progress, not a zero bar");
for (const g of G.list("active").slice(1)) G.setStatus(g.id, "archived");
ok(W.panelChoices().includes("goals") && W.layout()[0].size === "4x2", "home: one goal never shrinks or removes the chosen 4x2 panel");
const pHome = prof.profile();
// Model a previously saved choice; new selection of a paused panel is forbidden.
store.upsertOne("home_layout", { panel_key: "assistant" });
store.update("profile", pHome.id, { consent: { ...pHome.consent, ai_provider: false } });
ok(!W.panelChoices().includes("assistant") && W.panelKey() === "budget" && store.one("home_layout").panel_key === "assistant", "home: AI off temporarily substitutes Budget without forgetting Assistant");
const offHtml = W.homePage().html;
ok(W.layout().length === 12 && !/shortcut:assistant|href="#\/chat"|data-ask/.test(offHtml), "home: AI-off panel offers no chat; removed Assistant icon does not reappear");
ok(!/Every screen|tap Edit|add it as a shortcut/.test(prof.settingsPage().html), "settings: no duplicate Quick Access list or obsolete Home directions");
ok(/tick Allow AI help below, then Save/.test(prof.settingsPage({ enableAi: true }).html), "settings: explicit AI setting explains permission");
store.update("profile", pHome.id, { consent: { ...pHome.consent, ai_provider: true } });
ok(W.panelKey() === "budget" && store.one("home_layout").panel_key === "assistant" && !/href="#\/chat"/.test(W.homePage().html), "home: permission on cannot bypass the pause or erase the saved choice");
ok(!/data-action="edit"|data-remove|data-size|data-add|Drag to move|Hold any tile/.test(W.homePage().html), "home: no edit, resize, remove, add or drag controls remain");
ok(/press and hold/i.test(AS.HOW_TO.home_screen) && /Settings → Home panel/.test(AS.HOW_TO.home_screen) && !/Every screen/.test(AS.HOW_TO.home_screen), "assistant: Home directions describe the fixed layout");

// Rendering helpers: raw() carries trusted HTML, and it has to survive a plain template literal as
// well as an html`` one. It did not, and the first-run screen shipped with "[object Object]" on it.
{
  const U = await M("lib/ui.js");
  ok(`${U.raw("<b>x</b>")}` === "<b>x</b>", "ui: raw() in a plain template literal prints its HTML, not [object Object]");
  ok(U.html`${U.raw("<b>x</b>")}` === "<b>x</b>", "ui: raw() in an html template is still inserted unescaped");
  ok(U.html`${"<b>x</b>"}` === "&lt;b&gt;x&lt;/b&gt;", "ui: a plain value in an html template is still escaped");
}

// theme: a device preference, kept out of the store on purpose
const attrs = {};
globalThis.document.documentElement = { setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k], getAttribute: (k) => attrs[k] ?? null };
const TH = await M("lib/theme.js");
ok(TH.theme() === "system", "theme: nothing chosen means follow the device");
TH.setTheme("dark"); ok(TH.theme() === "dark" && attrs["data-theme"] === "dark", "theme: dark is stored and applied to the page");
TH.setTheme("system"); ok(TH.theme() === "system" && attrs["data-theme"] === undefined, "theme: back to the device means no override on the page");
TH.setTheme("nonsense"); ok(TH.theme() === "system", "theme: an unknown value falls back to the device rather than breaking the page");
ok(!JSON.stringify(store.exportJson()).includes("pfa.theme"), "theme: the choice is not in the backup, so restoring elsewhere leaves that device alone");

// Statement matching (accounts P2; acceptance 10, 11, 11b, 11c). Pure code over lines and records.
{
  const R = await M("features/reconcile.js");
  let n = 0; const rec = (date, amt, extra = {}) => ({ id: `r${++n}`, kind: "expense", account_id: "acc", counter_account_id: null, money: mk(amt, "SGD"), date, ...extra });
  const line = (date, amt, extra = {}) => ({ kind: "expense", money: mk(amt, "SGD"), date, merchant: "Shop", ...extra });
  // 10: twenty lines; eighteen are here, one is only on the statement, one record only in the app.
  const recs10 = [], lines10 = [];
  for (let i = 1; i <= 18; i++) { const d = `2026-08-${String(i).padStart(2, "0")}`; recs10.push(rec(d, 1000 + i * 37)); lines10.push(line(d, 1000 + i * 37)); }
  lines10.push(line("2026-08-19", 5555)); recs10.push(rec("2026-08-15", 7777));
  let m = R.match("acc", lines10, recs10);
  ok(m.matched.length === 18 && m.onlyStatement.length === 1 && m.onlyApp.length === 1 && m.onlyApp[0].money.amount === 7777 && !m.ask.length, "acct 10: 20 lines → 18 matched, 1 only on the statement, 1 only in the app (flagged)");
  // 11: two records of the same amount, 1 and 2 days from one line → the 1-day one.
  m = R.match("acc", [line("2026-08-10", 450)], [rec("2026-08-08", 450), rec("2026-08-09", 450)]);
  ok(m.matched.length === 1 && m.matched[0].tx.date === "2026-08-09", "acct 11: the nearer of two records matches");
  m = R.match("acc", [line("2026-08-10", 450)], [rec("2026-08-09", 450), rec("2026-08-11", 450)]);
  ok(m.ask.length === 1 && m.ask[0].options.length === 2 && !m.matched.length, "acct 11: both exactly one day away → the user picks");
  // 11b: a 4.50 coffee every weekday, each a day later on the statement → five pairs, no question.
  const wk = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
  m = R.match("acc", wk.map((d) => line(D.addDays(d, 1), 450)), wk.map((d) => rec(d, 450)));
  ok(m.matched.length === 5 && !m.ask.length && !m.onlyStatement.length && !m.onlyApp.length && m.matched.every((x) => x.days === 1), "acct 11b: a coffee a day, each a day late → five pairs, one each, no question asked");
  // 11c: the bank's reference decides, whatever the dates.
  m = R.match("acc", [line("2026-08-20", 450, { bank_ref: "TX-9" })], [rec("2026-08-19", 450), rec("2026-08-10", 450, { bank_ref: "TX-9" })]);
  ok(m.matched.length === 1 && m.matched[0].tx.bank_ref === "TX-9" && m.onlyApp.length === 0, "acct 11c: same bank reference → matched on it, 10 days apart");
  m = R.match("acc", [line("2026-08-20", 450, { bank_ref: "TX-9" })], [rec("2026-08-20", 450, { bank_ref: "TX-8" })]);
  ok(m.matched.length === 0 && m.onlyStatement.length === 1, "acct 11c: two different bank references never match, even on the same day and amount");
  // Money in and money out never pair; transfers count from this account's side.
  m = R.match("acc", [line("2026-08-10", 450, { kind: "income" })], [rec("2026-08-10", 450)]);
  ok(m.matched.length === 0, "acct: 4.50 in does not match 4.50 out");
  m = R.match("acc", [line("2026-08-10", 20000, { kind: "income" })], [{ id: "tr", kind: "transfer", account_id: "other", counter_account_id: "acc", money: mk(20000, "SGD"), counter_money: mk(20000, "SGD"), date: "2026-08-10" }]);
  ok(m.matched.length === 1, "acct: a transfer into this account matches money in on its statement");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);

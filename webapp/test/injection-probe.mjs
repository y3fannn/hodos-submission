// Live prompt-injection probe. Needs the server running with a key: `npm start`, then
// `node test/injection-probe.mjs` (or PFA_URL=http://host:port/ node test/injection-probe.mjs).
// Every known attack from injections.json is planted in merchant names, then the real briefing and
// deep dive run through the real client: scrubbed, fenced, validated. The probe reports what the
// model did and whether any words that reached the screen carry an order, a link or a contact.
const { featurePaused } = await import("../public/js/lib/feature-policy.js");
if (featurePaused("briefings") || featurePaused("deepDive")) {
  console.log("SKIPPED: Briefing/Deep-dive are paused. No provider request made; this is not an attack-test pass.");
  process.exit(2);
}
const BASE = process.env.PFA_URL || "http://localhost:8787/";
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
Object.defineProperty(globalThis, "navigator", { value: { storage: null }, configurable: true });
globalThis.location = { hash: "#/home", href: BASE };
globalThis.window = { scrollTo() {} };
globalThis.document = { getElementById: () => ({ innerHTML: "", querySelector: () => ({}), querySelectorAll: () => [] }), querySelector: () => null, querySelectorAll: () => [], body: {} };
globalThis.alert = console.error;
const fs = await import("node:fs");
const P = new URL("../public/js/", import.meta.url).href;
const M = (p) => import(P + p);
const ai = await M("lib/ai.js"), prof = await M("features/profile.js"), seed = await M("features/seed.js"), T = await M("features/transactions.js"), B = await M("features/budgets.js"), INS = await M("features/insights.js"), C = await M("features/categories.js");
const status = await ai.refreshStatus();
if (!status.configured) { console.log(`No AI key on ${BASE}. Start the server with ANTHROPIC_API_KEY set, then run this again.`); process.exit(2); }
const ATTACKS = JSON.parse(fs.readFileSync(new URL("./injections.json", import.meta.url), "utf8")).attacks;
prof.createProfile({ base_currency: "SGD", timezone: "Asia/Singapore", self_description: "working", ai_provider: true });
seed.seedDemo();
const last = B.prevMonth(B.month());
const acct = (await M("features/accounts.js")).active()[0];
const food = C.list("expense").find((c) => c.name === "Food");
ATTACKS.forEach((atk, i) => T.save({ kind: "expense", account_id: acct.id, money: { amount: 5000 + i, currency: "SGD" }, date: last.end, category_id: food.id, merchant: atk }));
const flagged = (text) => (text ? ai.hasOrder(text) || ai.contactNotInInput(text, {}) !== null : false);
let bad = 0;
const br = await INS.buildBriefing(last);
console.log(`briefing: ${br.failed_reason ? `words refused or unavailable (${br.failed_reason})` : "words shown"}`);
for (const text of [br.summary, ...br.options.map((o) => o.prose)]) if (flagged(text)) { bad++; console.log("  REACHED THE SCREEN:", text); }
const dd = await INS.deepDive({ kind: "category", id: food.id, months: 1 });
console.log(`deep dive: ${dd.prose ? "words shown" : `words refused or unavailable (${dd.reason})`}`);
if (flagged(dd.prose)) { bad++; console.log("  REACHED THE SCREEN:", dd.prose); }
console.log(bad ? `${bad} harmful outputs reached the screen` : "No order, link or contact reached the screen.");
process.exit(bad ? 1 : 0);

// Demo data. Prototype only. Deterministic-ish so screens look real.
import { store } from "../lib/store.js";
import { money, exponent } from "../lib/money.js";
import * as D from "../lib/dates.js";
import * as fx from "../lib/fx.js";
import { base, today } from "./profile.js";
import * as A from "./accounts.js";
import * as C from "./categories.js";
import * as T from "./transactions.js";
import * as B from "./budgets.js";
import * as G from "./goals.js";
import * as DB from "./debts.js";
import * as I from "./insurance.js";
import * as H from "./investments.js";
import * as NW from "./networth.js";

export function seedDemo() { for (const step of seedDemoSteps()) { /* synchronous maths-test entry */ } }

// Same recipe/order; yield points let the browser prepare it without a long frozen frame.
export function* seedDemoSteps() {
  const b = base(), t = today();
  const MONTHS = 24;                       // two years of everyday money, so every screen has a past
  const start = D.addMonths(t, -MONTHS, 1);
  const bank = A.create({ name: "Main bank", type: "bank", currency: b, openingBalance: money(820000, b), openedOn: D.addDays(start, -1) });
  const cash = A.create({ name: "Cash", type: "cash", currency: b, openingBalance: money(90000, b), openedOn: D.addDays(start, -1) });
  const card = A.create({ name: "Credit card", type: "credit", currency: b, openingBalance: money(0, b), openedOn: D.addDays(start, -1), creditLimit: money(500000, b), statementDay: 20 });
  const usd = A.create({ name: "US wallet", type: "wallet", currency: "USD", openingBalance: money(200000, "USD"), openedOn: D.addDays(start, -1) });
  if (b !== "USD") fx.setUserRate("USD", b, b === "SGD" ? "1.35" : b === "EUR" ? "0.92" : b === "GBP" ? "0.79" : b === "JPY" ? "150" : "1.00");
  const cat = (name) => C.all().find((c) => c.name === name && !c.parent_id);
  const cats = { Food: cat("Food"), Transport: cat("Transport"), Housing: cat("Housing"), Bills: cat("Bills & utilities"), Shopping: cat("Shopping"), Entertainment: cat("Entertainment"), Health: cat("Health"), Travel: cat("Travel") || cat("Entertainment"), Salary: cat("Salary") };
  const day = (d, n) => D.clampDay(...Object.values(D.parse(d)).slice(0, 2), n);
  // recurring: the things that arrive whether or not anyone logs them
  T.createRule({ name: "Salary", template: { kind: "income", account_id: bank.id, money: money(480000, b), category_id: cats.Salary.id, merchant: "Employer" }, schedule: { freq: "monthly", interval: 1, start: day(start, 25), anchor: 25 } });
  T.createRule({ name: "Rent", template: { kind: "expense", account_id: bank.id, money: money(150000, b), category_id: cats.Housing.id, merchant: "Landlord" }, schedule: { freq: "monthly", interval: 1, start, anchor: 1 } });
  T.createRule({ name: "Streaming", template: { kind: "expense", account_id: card.id, money: money(1590, b), category_id: cats.Entertainment.id, merchant: "Netflix" }, schedule: { freq: "monthly", interval: 1, start: day(start, 12), anchor: 12 } });
  T.createRule({ name: "Gym", template: { kind: "expense", account_id: card.id, money: money(8900, b), category_id: cats.Health.id, merchant: "Anytime Fitness" }, schedule: { freq: "monthly", interval: 1, start: day(start, 5), anchor: 5 } });
  T.createRule({ name: "Phone bill", template: { kind: "expense", account_id: bank.id, money: money(4500, b), category_id: cats.Bills.id, merchant: "Singtel" }, schedule: { freq: "monthly", interval: 1, start: day(start, 18), anchor: 18 } });
  // Charges logged by hand every month but never set up as recurring: what detection exists to find.
  // Disney+ began three months ago, next to a Netflix rule, so the briefing has an overlap to name.
  // Merchants here are ones the everyday spending below never uses, or its odd amounts break the run.
  for (const [merchant, amt, months, dd, c] of [["YouTube Premium", 1598, 10, 7, "Entertainment"], ["Disney+", 1398, 3, 21, "Entertainment"], ["iCloud", 128, 14, 3, "Bills"]])
    for (let k = months; k >= 0; k--) { const d = D.addMonths(t, -k, dd); if (d <= t) T.save({ kind: "expense", account_id: card.id, money: money(amt, b), date: d, category_id: cats[c].id, merchant, source: "form" }); }
  yield;
  // ad-hoc transactions, pseudo-random but deterministic
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const merchants = [["Starbucks", "Food", 650, cash], ["NTUC FairPrice", "Food", 4200, card], ["Grab", "Transport", 1450, card], ["MRT top-up", "Transport", 2000, cash], ["Din Tai Fung", "Food", 5800, card], ["Uniqlo", "Shopping", 5900, card], ["Watsons", "Health", 1800, cash], ["Shopee", "Shopping", 3300, card], ["Golden Village", "Entertainment", 1400, card], ["Hawker centre", "Food", 850, cash], ["SP Group", "Bills", 12000, bank], ["Ya Kun Kaya Toast", "Food", 720, cash], ["Cold Storage", "Food", 3800, card], ["Guardian", "Health", 2200, card], ["Decathlon", "Shopping", 4500, card], ["Spotify", "Entertainment", 1090, card], ["Taxi", "Transport", 2400, card], ["Bookshop", "Shopping", 2600, card]];
  // Spending is not flat across a year: December and June cost more, because that is when people
  // travel and buy presents. A year that looks the same every month teaches nothing about a budget.
  const seasonal = (date) => { const m = D.parse(date).m; return m === 12 ? 1.45 : m === 6 ? 1.2 : m === 1 ? 0.85 : 1; };
  // And no two months are alike even without a reason: some months everything costs more.
  const moods = {}; const mood = (date) => (moods[date.slice(0, 7)] ??= 0.7 + rnd() * 0.75);
  const days = D.daysBetween(start, t);
  for (let i = 0; i < days; i++) {
    const date = D.addDays(start, i); const n = rnd() < 0.6 ? 1 : rnd() < 0.55 ? 2 : 0;
    for (let k = 0; k < n; k++) {
      const m = merchants[Math.floor(rnd() * merchants.length)];
      if (m[0] === "SP Group" && D.parse(date).d !== 15) continue;
      const amt = Math.round(m[2] * (0.6 + rnd() * 0.9) * seasonal(date) * mood(date));
      try { T.save({ kind: "expense", account_id: m[3].id, money: money(amt, b), date, category_id: cats[m[1]].id, merchant: m[0], source: "form" }); } catch {}
    }
    yield;
  }
  // The one-offs that make a month look nothing like the month before it.
  const oneOffs = [
    [D.addMonths(t, -21, 14), "Japan Airlines", "Travel", 128000, bank], [D.addMonths(t, -21, 18), "Hotel Gracery", "Travel", 96000, card],
    [D.addMonths(t, -17, 9), "Apple Store", "Shopping", 289000, card], [D.addMonths(t, -14, 21), "Dentist", "Health", 45000, bank],
    [D.addMonths(t, -11, 3), "IKEA", "Shopping", 82000, card], [D.addMonths(t, -9, 14), "Singapore Airlines", "Travel", 74000, bank],
    [D.addMonths(t, -8, 16), "Airbnb", "Travel", 63000, card], [D.addMonths(t, -5, 12), "Car servicing", "Transport", 52000, bank],
    [D.addMonths(t, -4, 25), "Specialist clinic", "Health", 38000, bank], [D.addMonths(t, -2, 8), "Wedding gift", "Shopping", 30000, bank],
    // The months that cost more than they earn, because every real year has some.
    [D.addMonths(t, -19, 6), "Family flight home", "Travel", 340000, bank], [D.addMonths(t, -13, 11), "Home renovation", "Housing", 880000, bank],
    [D.addMonths(t, -7, 4), "Europe holiday package", "Travel", 460000, bank], [D.addMonths(t, -7, 9), "Paris hotel", "Travel", 230000, bank],
    [D.addMonths(t, -3, 17), "Car repair", "Transport", 210000, bank],
  ];
  for (const [date, merchant, c, amt, acct] of oneOffs) { try { T.save({ kind: "expense", account_id: acct.id, money: money(amt, b), date, category_id: cats[c].id, merchant, source: "form" }); } catch {} }
  // A year-end bonus, the one month income jumps.
  for (let k = MONTHS; k >= 0; k--) { const d = D.addMonths(t, -k, 20); if (D.parse(d).m === 12 && d <= t && d >= start) try { T.save({ kind: "income", account_id: bank.id, money: money(480000, b), date: d, category_id: cats.Salary.id, note: "Year-end bonus", source: "form" }); } catch {} }
  // A second income, so the month is not one salary and nothing else.
  for (let k = MONTHS - 2; k >= 0; k -= 3) { const d = D.addMonths(t, -k, 14); if (d <= t) try { T.save({ kind: "income", account_id: bank.id, money: money(Math.round(60000 + rnd() * 90000), b), date: d, category_id: cats.Salary.id, merchant: "Freelance project", source: "form" }); } catch {} }
  // Cash comes out of a machine before it is spent. Without this the wallet goes negative, which is
  // not a thing a wallet does.
  for (let i = 10; i < days; i += 14) { const d = D.addDays(start, i); if (d <= t) try { A.transfer({ fromId: bank.id, toId: cash.id, moneyOut: money(8000, b), date: d, note: "ATM" }); } catch {} }
  // The US wallet is what gets spent abroad, in its own currency, on the trips above.
  const abroad = [[-21, 15, "Shinjuku izakaya", "Food", 8200], [-21, 16, "Don Quijote", "Shopping", 15600], [-21, 17, "JR Pass", "Travel", 29500],
    [-9, 15, "Hotel breakfast", "Food", 4200], [-9, 16, "Museum tickets", "Entertainment", 6800], [-8, 17, "Duty free", "Shopping", 12400]];
  // A record takes its own day's rate, so each day spent abroad gets one, near today's.
  const usdNow = Number(fx.liveRate("USD", b)?.rate || 1);
  for (const [mo, dd, merchant, c, amt] of abroad) { const d = D.addMonths(t, mo, dd); if (b !== "USD") fx.setUserRateOn("USD", b, d, (usdNow * (0.98 + ((dd * 7) % 5) * 0.01)).toFixed(4)); try { T.save({ kind: "expense", account_id: usd.id, money: money(amt, "USD"), date: d, category_id: cats[c].id, merchant, source: "form" }); } catch {} }
  yield;
  T.postDue();
  yield;
  // pay the card from the bank once a month
  for (let k = MONTHS; k >= 0; k--) { const d = D.addMonths(t, -k, 22); if (d <= t && d >= start) { const owed = -A.balance(card.id, d).amount; if (owed > 0) A.transfer({ fromId: bank.id, toId: card.id, moneyOut: money(Math.min(owed, 120000), b), date: d, note: "card bill" }); } }
  // budgets
  B.set("category", { categoryId: cats.Food.id, limit: money(60000, b) });
  B.set("category", { categoryId: cats.Transport.id, limit: money(20000, b) });
  B.set("category", { categoryId: cats.Shopping.id, limit: money(25000, b) });
  B.set("savings", { target: { percent_of_income: 20 } });
  B.checkThresholds();
  // goal, debt, insurance, holdings, extras
  // Money put aside is logged as contributions rather than linked to the bank account: a linked goal
  // measures growth from the day it was made, so a freshly seeded one would read zero on every screen.
  const ef = G.create({ name: "Emergency fund", target: money(1500000, b), targetDate: D.addMonths(t, 10) });
  for (let k = 14; k >= 1; k--) G.contribute(ef.id, money(80000, b), D.addMonths(t, -k, 26));
  const trip = G.create({ name: "Japan trip", target: money(300000, b), targetDate: D.addMonths(t, 7) });
  for (let k = 5; k >= 1; k--) G.contribute(trip.id, money(35000, b), D.addMonths(t, -k, 26));
  const loan = DB.create({ name: "Car loan", type: "car", lender: "DBS", currency: b, balance: money(1200000, b), original_balance: money(2400000, b), rate_apr: "3.5", rate_type: "fixed", payment: money(45000, b), payment_day: 8, pay_from_account_id: bank.id, category_id: cats.Transport.id, started_on: D.addMonths(t, -28), maturity_date: D.addMonths(t, 26), lock_in_until: D.addMonths(t, 2), linked_account_id: null });
  I.create({ type: "health", insurer: "Prudential", policy_number: "PH-2291", insured: "self", premium: money(14000, b), frequency: "monthly", cover: money(20000000, b), start_date: D.addMonths(t, -20), renewal_date: D.addDays(t, 40), end_date: null, notes: null, account_id: bank.id }, false);
  I.create({ type: "travel", insurer: "AIG", policy_number: null, insured: "self", premium: money(9000, b), frequency: "yearly", cover: null, start_date: D.addMonths(t, -14), renewal_date: D.addMonths(t, 10), end_date: null, notes: null, account_id: bank.id }, false);
  I.create({ type: "life", insurer: "Great Eastern", policy_number: "GE-88120", insured: "self", premium: money(22000, b), frequency: "monthly", cover: money(50000000, b), start_date: D.addMonths(t, -22), renewal_date: D.addMonths(t, 4), end_date: null, notes: null, account_id: bank.id }, false);
  yield;
  yield* seedInvestments(b, t);
  const carValue = money(3600000, b);
  NW.createExtra("Car", "vehicle", carValue, D.addMonths(t, -1));
  NW.takeSnapshot("monthly");
  yield* backdateSnapshots(b, t, { months: MONTHS, card, loan, carValue });
}

// Investments run on a different clock from spending. Money put away is meant to sit there for
// years, so a short history says nothing about it: this lays down ten years, valued every month,
// across the kinds of thing people actually hold. Prices move month to month the way markets do,
// shares by a few percent, crypto by a lot, bonds hardly at all, and six years in every listed
// holding falls together for three months and then claws back, because a bad stretch hits the whole
// market at once and a portfolio that only ever rises teaches the wrong thing.
function* seedInvestments(b, t) {
  const STEPS = 120; // ten years, valued monthly
  let s = 99991; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const unit = (cur) => 10 ** exponent(cur);
  const at = (i) => D.addMonths(D.addMonths(t, -STEPS), i);
  const CRASH = 72; // the month the fall begins
  const shock = (i, crash) => (i >= crash && i < crash + 3 ? -0.075 : i >= crash + 3 && i < crash + 9 ? 0.02 : 0);
  // Each US-dollar entry is frozen at its own day's rate, so the demo needs a rate for every one of
  // those days. They wander around today's rate, as a currency does over ten years.
  const now = fx.liveRate("USD", b)?.rate;
  if (b !== "USD" && now) for (let i = 0; i <= STEPS; i++) fx.setUserRateOn("USD", b, at(i), (Number(now) * (1 - 0.035 * Math.sin(i / 16) - 0.02 * (STEPS - i) / STEPS + (rnd() - 0.5) * 0.012)).toFixed(4));
  // amp: how far a month can move, either way. A share's month is a few percent; crypto's is a lot.
  const path = (p0, drift, amp, crash = CRASH) => {
    const out = []; let p = p0;
    for (let i = 0; i <= STEPS; i++) { out.push(p); p = Math.max(p0 * 0.05, p * (1 + drift / 12 + (rnd() - 0.5) * amp + shock(i, crash))); }
    return out;
  };
  // Units mode: buys at a price, and the value on each date is simply what is held times that price.
  function* shares(meta, prices, buys) {
    const h = H.create(meta); const u = unit(meta.currency); let units = 0;
    for (let i = 0; i <= STEPS; i++) {
      const buy = buys.find((x) => x.i === i);
      if (buy) { const n = buy.units ?? Number((buy.cash / prices[i]).toFixed(3)); H.trade(h.id, "buy", at(i), String(n), money(Math.round(prices[i] * u), meta.currency)); units += n; }
      if (units > 0) H.value(h.id, at(i), money(Math.round(units * prices[i] * u), meta.currency));
      yield;
    }
    return h;
  }
  // Value mode: deposits go in, the pot grows or shrinks, and only the total is ever known.
  function* pot(meta, deposits, drift, amp, crash = null) {
    const h = H.create(meta); const u = unit(meta.currency); let v = 0;
    for (let i = 0; i <= STEPS; i++) {
      v = v * (1 + drift / 12 + (rnd() - 0.5) * amp + (crash == null ? 0 : shock(i, crash)));
      const dep = deposits.find((x) => x.i === i);
      if (dep) { H.cashFlow(h.id, "deposit", at(i), money(Math.round(dep.amount * u), meta.currency)); v += dep.amount; }
      if (v > 0) H.value(h.id, at(i), money(Math.round(v * u), meta.currency));
      yield;
    }
    return h;
  }
  yield* shares({ name: "Vanguard S&P 500", ticker: "VOO", type: "etf", currency: "USD", mode: "units", accountLabel: "IBKR" },
    path(190, 0.09, 0.15), Array.from({ length: 11 }, (_, k) => ({ i: k * 12, cash: 1500 })));
  yield* shares({ name: "Apple", ticker: "AAPL", type: "stock", currency: "USD", mode: "units", accountLabel: "IBKR" },
    path(27, 0.17, 0.26), [{ i: 0, units: 40 }, { i: 60, units: 20 }, { i: 96, units: 10 }]);
  yield* shares({ name: "DBS Group", ticker: "D05", type: "stock", currency: b, mode: "units", accountLabel: "Local broker" },
    path(16, 0.07, 0.14), [{ i: 6, units: 500 }, { i: 66, units: 300 }]);
  yield* pot({ name: "Singapore Savings Bonds", type: "bond", currency: b, mode: "value", accountLabel: "CDP" },
    [{ i: 48, amount: 5000 }, { i: 84, amount: 5000 }], 0.028, 0.002);
  yield* pot({ name: "Global balanced fund", type: "fund", currency: b, mode: "value", accountLabel: "Endowus" },
    Array.from({ length: 5 }, (_, k) => ({ i: 24 + k * 24, amount: 2000 })), 0.045, 0.08, CRASH);
  yield* pot({ name: "Bitcoin", ticker: "BTC", type: "crypto", currency: "USD", mode: "value", accountLabel: "Exchange" },
    [{ i: 36, amount: 1000 }, { i: 72, amount: 1000 }], 0.25, 0.6, CRASH + 6);
}

// Demo only. A snapshot is computed from the state of the day it is taken, so earlier months have to
// be written directly. These are not invented: each month is rebuilt from the data that is already
// there — every account balance as of that date, the portfolio valued on that date, the loan walked
// back one payment at a time — so the history line agrees with the records behind it.
function* backdateSnapshots(b, t, { months, card, loan, carValue }) {
  const today = store.all("nw_snapshots")[0];
  if (!today) return;
  const toBase = (m) => { const c = fx.toBase(m, b); return c.money ? c.money.amount : 0; };
  // The loan runs forward as balance × (1 + monthly rate) − payment, so backwards it is the inverse.
  const r = Number(loan.rate_apr) / 100 / 12, pay = loan.payment.amount;
  const loanAt = {}; let bal = loan.balance.amount;
  for (let k = 0; k <= months; k++) { loanAt[k] = Math.max(0, Math.round(bal)); bal = (bal + pay) / (1 + r); if (D.addMonths(t, -k) < loan.started_on) loanAt[k] = 0; }
  for (let k = months; k >= 1; k--) {
    const d = D.addMonths(t, -k, 1);
    let accounts = 0, credit = 0;
    for (const a of A.list(true)) {
      const bAt = A.balance(a.id, d);
      if (a.type === "credit") credit += Math.max(0, -toBase(bAt));
      else accounts += toBase(bAt);
    }
    const holdings = H.valueAt(d).amount;
    // A car is worth less every year, so going backwards it was worth more.
    const extras = Math.round(carValue.amount * Math.pow(1.15, k / 12));
    const c = {
      accounts: money(accounts, b), holdings: money(holdings, b), extras_assets: money(extras, b),
      credit: money(credit, b), debts: money(loanAt[k], b), extras_liabilities: money(0, b),
    };
    const total = money(accounts + holdings + extras - credit - loanAt[k], b);
    store.insert("nw_snapshots", { taken_at: new Date(D.toUtc(d)).toISOString(), trigger: "monthly", base_currency: b, components: c, total, incomplete_reasons: [], rates_used: today.rates_used });
    yield;
  }
}

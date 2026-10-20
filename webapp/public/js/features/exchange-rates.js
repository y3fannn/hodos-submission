// Settings' manual editor. No Assistant actions yet; the validated core is shared for later plumbing.
import { store } from "../lib/store.js";
import * as fx from "../lib/fx.js";
import { CURRENCIES } from "../lib/money.js";
import { fmtDate } from "../lib/dates.js";
import { esc, field, inp, sel, moneyInput, modal, toast } from "../lib/ui.js";

function requestedPair(query) {
  const from = query.get("rate-from"), to = query.get("rate-to");
  try { fx.validatePair(from, to); return { from, to, date: query.get("rate-date") || "" }; } catch { return null; }
}
export function ratesCard({ base, overseas, today, query }) {
  const foreign = fx.foreignCurrencies(base), requested = requestedPair(query);
  if (!overseas && !foreign.length && !requested) return "";
  const from = requested?.from || overseas || foreign[0] || "USD", to = requested?.to || base;
  const history = store.all("fx_rates").slice().reverse();
  const pairs = new Map();
  for (const c of new Set([...foreign, overseas].filter(Boolean))) if (c !== base) pairs.set(`${c}:${base}`, { from: c, to: base });
  for (const r of history) if (!r.on && r.source === "user") pairs.set(`${r.from}:${r.to}`, { from: r.from, to: r.to });
  const current = [...pairs.values()].map((p) => {
    const r = fx.liveRate(p.from, p.to);
    return `<div class="fx-current-row"><div class="grow">${r ? `<b>1 ${esc(p.from)} = ${esc(r.rate)} ${esc(p.to)}</b><div class="sub">Entered ${esc(fmtDate(r.fetched_at.slice(0, 10)))}</div>` : `<b>Exchange rate missing</b><div class="sub">${esc(p.from)} → ${esc(p.to)}</div>`}</div><button type="button" class="small" data-rate-from="${esc(p.from)}" data-rate-to="${esc(p.to)}">${r ? "Edit" : "Update rate"}</button></div>`;
  }).join("");
  const row = (r) => `<div class="fx-history-row"><div><b>1 ${esc(r.from)} = ${esc(r.rate)} ${esc(r.to)}</b><div class="sub">${r.on ? `For ${esc(fmtDate(r.on))}` : "Current rate"} · entered ${esc(fmtDate((r.fetched_at || r.created_at).slice(0, 10)))}${r.source !== "user" ? " · old online rate, not used for new entries" : ""}</div></div></div>`;
  return `<div class="card" id="exchange-rates"><h2>Exchange rates</h2>
    <p class="muted">Enter rates yourself. Nothing is looked up online. New rates update current totals, not saved records. To add a conversion to an old record, edit and confirm that record.</p>
    ${current ? `<div class="fx-current">${current}</div>` : ""}
    <form data-form="fx">
      <div class="inline">${field("From currency", sel("from", CURRENCIES, from))}${field("To currency", sel("to", CURRENCIES, to))}</div>
      <label class="fx-equation"><span data-rate-direction>1 ${esc(from)} =</span>${moneyInput("rate", "", "e.g. 1.30")}<span data-rate-unit>${esc(to)}</span></label>
      <div class="inline">${field("Use this rate for", sel("scope", [["current", "New records and current totals"], ["past", "A past date"]], requested?.date && requested.date !== today ? "past" : "current", (x) => x[1], (x) => x[0]))}<div data-rate-date-wrap ${requested?.date && requested.date !== today ? "" : "hidden"}>${field("Rate date", inp("date", { type: "date", value: requested?.date || today, max: today }))}</div></div>
      <p class="hint">The direction matters: for example, 1 USD = 1.30 SGD. A past-date rate can cover the following seven days; it never changes a saved entry.</p>
      <div class="error" data-rate-error role="alert"></div><div class="actions right"><button class="primary">Review rate</button></div>
    </form>
    <details class="fx-history"><summary>Rate history <span class="muted">(${history.length})</span></summary><div class="fx-history-list">${history.length ? history.map(row).join("") : '<p class="muted">No rates entered yet.</p>'}</div></details>
  </div>`;
}
export function bindRates(root, { query, today }) {
  const form = root.querySelector('[data-form="fx"]'); if (!form) return;
  const error = form.querySelector("[data-rate-error]");
  const direction = () => {
    form.querySelector("[data-rate-direction]").textContent = `1 ${form.from.value} =`;
    form.querySelector("[data-rate-unit]").textContent = form.to.value;
    error.textContent = "";
  };
  form.from.onchange = form.to.onchange = () => { form.rate.value = ""; direction(); };
  const scope = () => {
    const past = form.scope.value === "past";
    form.querySelector("[data-rate-date-wrap]").hidden = !past; form.date.disabled = !past;
  };
  form.scope.onchange = scope; scope();
  root.querySelectorAll("[data-rate-from]").forEach((button) => (button.onclick = () => {
    form.from.value = button.dataset.rateFrom; form.to.value = button.dataset.rateTo;
    form.scope.value = "current"; scope(); direction();
    form.rate.value = fx.liveRate(form.from.value, form.to.value)?.rate || "";
    form.scrollIntoView({ block: "center" }); form.rate.focus({ preventScroll: true });
  }));
  form.onsubmit = (event) => {
    event.preventDefault(); error.textContent = "";
    try {
      const from = form.from.value, to = form.to.value, rate = fx.validateRate(form.rate.value);
      fx.validatePair(from, to);
      const date = form.scope.value === "past" ? fx.validateDate(form.date.value) : null;
      modal({ title: "Save exchange rate?", submitLabel: "Confirm & save rate", body: `<p class="fx-confirm">1 ${esc(from)} = <b>${esc(rate)} ${esc(to)}</b></p><p>${date ? `For ${esc(fmtDate(date))} and up to seven days after it.` : "For new records and current totals."}</p><p class="hint">Saved records keep their original rates and amounts.</p>`, onSubmit: () => {
        if (date) fx.setUserRateOn(from, to, date, rate); else fx.setUserRate(from, to, rate);
        toast("Exchange rate saved");
      } });
    } catch (ex) { error.textContent = ex.message; }
  };
  if (requestedPair(query)) {
    const card = root.querySelector("#exchange-rates"); card.scrollIntoView({ block: "start" });
    form.rate.focus({ preventScroll: true });
    const pair = requestedPair(query), date = pair.date && pair.date !== today ? pair.date : null;
    form.rate.value = (date ? fx.rateOn(pair.from, pair.to, date) : fx.liveRate(pair.from, pair.to))?.rate || "";
  }
}

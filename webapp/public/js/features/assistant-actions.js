// Assistant action bridge. Candidate identity remains local; models only supply search criteria and draft text.
import { store } from "../lib/store.js";
import { ownerId, accessRevision } from "../lib/vault.js";
import { parseMoney, toDecimalString, fmt, CURRENCIES, exponent } from "../lib/money.js";
import { modal, field, sel, esc, toast, commitAction } from "../lib/ui.js";
import * as T from "./transactions.js";
import * as A from "./accounts.js";
import * as C from "./categories.js";
import * as B from "./budgets.js";
import * as G from "./goals.js";
import * as NW from "./networth.js";
import * as H from "./investments.js";
import { base, today } from "./profile.js";
import { cleanParams } from "../lib/assistant-tasks.js";
import * as fx from "../lib/fx.js";
import { convert as moneyConvert } from "../lib/money.js";
import { checkLocalReferences, localReference } from "./assistant-data.js";

const offered = new WeakMap();
const textAmount = (text, currency) => {
  if (text == null || text === "") return null;
  if (!CURRENCIES.includes(currency) || typeof text !== "string") return null;
  const raw = text.trim().replace(/\s+/g, " ").replace(/^S\$\s*/i, currency === "SGD" ? "" : "S$");
  const s = raw.replace(/^(?:([A-Z]{3})\s*|([$€£¥])\s*)|(?:\s*([A-Z]{3})|\s*([$€£¥]))$/g, "");
  if (!s || /[^\d.,kKmM+-]/.test(s) || !/^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?:[kKmM])?$/.test(s)) return null;
  const shorthand = /([kKmM])$/.exec(s)?.[1];
  const numeric = shorthand ? s.slice(0, -1) : s;
  if (numeric.includes(",") && numeric.includes(".") && !/^[-+]?(?:\d{1,3},)+\d{3}\.\d+$/.test(numeric)) return null;
  let shift = 0;
  if (shorthand) shift = /k/i.test(shorthand) ? 3 : 6;
  const [whole,fraction=""] = numeric.replace(/,/g,"").split(".");
  let expanded = numeric.replace(/,/g,"");
  if (shift) {
    expanded = whole + fraction.padEnd(shift,"0").slice(0,shift);
    if (fraction.length>shift) expanded += "."+fraction.slice(shift);
  }
  if ((expanded.split(".")[1]?.length || 0)>exponent(currency)) return null;
  try { return parseMoney(expanded,currency); } catch { return null; }
};
export { textAmount as amountFromText };

const snapshot = (row) => JSON.stringify(row);
const actionContext = (action,params) => `${action.kind}|${JSON.stringify(params)}|${JSON.stringify(action.local_refs||null)}`;
const readable = (t) => `${t.date} · ${fmt(t.money)} · ${A.get(t.account_id)?.name || "account unavailable"} · ${t.kind} · ${t.merchant || t.note || "no description"}`;
function findRows(action) {
  if(!checkLocalReferences(action))throw new Error("Saved information changed. Review again; no change saved.");
  const p = cleanParams(action.kind, action.params || {});
  if (!["edit_transaction", "cancel_transaction", "set_category"].includes(action.kind)) return [];
  const bound=localReference(action,"q");
  const matches = bound ? [T.get(bound)].filter(Boolean) : T.search({ q: p.q || "", kind: p.kind, from: p.from, to: p.to, showCancelled: false });
  return matches.filter((t) => (action.kind === "cancel_transaction" || t.kind !== "transfer") && !t.voided_at && !t.deleted_at && (action.kind !== "edit_transaction" || ["income", "expense"].includes(t.kind)));
}
export function prepareCandidates(action) {
  if (!action || typeof action.kind !== "string") return [];
  const params = cleanParams(action.kind, action.params || {});
  const context = actionContext(action,params);
  const rows = findRows({ ...action, params });
  const candidates = rows.map((row) => {
    const candidate = Object.freeze({ id: row.id, owner: ownerId(), accessRevision: accessRevision(), generation: store.generation(), context, snapshot: snapshot(row), description: readable(row) });
    offered.set(candidate, { rowId: row.id, owner: candidate.owner, accessRevision: candidate.accessRevision, generation: candidate.generation, context, row: snapshot(row) });
    return candidate;
  });
  return { candidates, select(candidate) { return candidates.includes(candidate) ? candidate : null; } };
}
function currentCandidate(action, selected) {
  const stamp = selected && offered.get(selected);
  const params = cleanParams(action.kind, action.params || {}), context = actionContext(action,params);
  if (!stamp || stamp.context !== context || stamp.generation !== store.generation() || selected.generation !== store.generation() || stamp.owner !== ownerId() || stamp.accessRevision !== accessRevision()) return null;
  const row = T.get(stamp.rowId);
  if (!row || snapshot(row) !== stamp.row || (action.kind !== "cancel_transaction" && row.kind === "transfer") || row.voided_at || row.deleted_at) return null;
  return row;
}
const escapeCandidate = (t) => esc(readable(t));
function showChangePreview(dialog, before, readAfter) {
  if (!dialog?.form) return dialog;
  const form = dialog.form, section = document.createElement("section");
  section.dataset.changePreview = "";
  const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text??"—";return n;};
  const table=document.createElement("table"),head=document.createElement("thead"),header=document.createElement("tr"),body=document.createElement("tbody");
  for(const label of ["Field","Before","After"]){const th=node("th",label);th.scope="col";header.append(th);}
  head.append(header);table.append(head,body);section.append(node("h3","Review changes"),table);
  const render = () => {
    const after = readAfter(new FormData(form));
    body.replaceChildren(...Object.entries(before).map(([key,value])=>{const tr=document.createElement("tr"),label=node("th",key),original=node("td",value),proposed=node("td",after[key]);label.scope="row";original.dataset.before=key;proposed.dataset.after=key;tr.append(label,original,proposed);return tr;}));
  };
  form.prepend(section); form.addEventListener("input", render); form.addEventListener("change", render); render();
  return dialog;
}
function reviewSelected(action, options, candidate) {
  const p = cleanParams(action.kind, action.params || {});
  const validCurrent = () => checkLocalReferences(action) && options.isCurrent?.() !== false && currentCandidate(action, candidate);
  const existing = validCurrent();
  if (!existing) { const message = options.isCurrent?.() === false ? "Conversation changed. Review again; no change saved." : "That record changed or is no longer available. Search again or use Records."; options.onMessage?.(message); toast(message); return null; }
  if (action.kind === "cancel_transaction") {
    const m = modal({ title: "Cancel this transaction?", danger: true, body: `<p>${escapeCandidate(existing)}</p>${field("Reason", sel("reason", ["refund", "error", "cancelled"], p.reason || "error"))}`, onSubmit: async (f) => {
      await commitAction(() => { if (!validCurrent()) throw new Error(options.isCurrent?.() === false ? "Conversation changed. Review again; no change saved." : "This record changed. Search again before cancelling."); options.onBeforeCommit?.(); return T.cancel(existing.id, f.get("reason")); });
      options.onDone?.("Cancelled (struck through).");
    } });
    return showChangePreview(m, {State:"Recorded",Reason:"—"}, f=>({State:"Cancelled (struck through)",Reason:f.get("reason")}));
  }
  if (action.kind === "set_category") {
    const cats = C.list(existing.kind);
    const categoryId=localReference(action,"category_name");
    const requested = p.category_name ? cats.filter((c) => categoryId ? c.id===categoryId : C.label(c).toLowerCase() === p.category_name.toLowerCase()) : [];
    if (p.category_name && requested.length !== 1) { toast("That category is missing or unclear. Choose it in the form."); }
    const m = modal({ title: "Change category", body: `<p>${escapeCandidate(existing)}</p>${field("Category", sel("category_id", [{ id: "", name: "— pick a category" }, ...cats], requested[0]?.id || "", (c) => c.name || C.label(c), (c) => c.id))}`, onSubmit: async (f) => {
      const category = C.get(f.get("category_id"));
      if (!category || category.kind !== existing.kind) throw new Error("Choose a compatible category.");
      await commitAction(() => { if (!validCurrent()) throw new Error(options.isCurrent?.() === false ? "Conversation changed. Review again; no change saved." : "This record changed. Search again before saving."); options.onBeforeCommit?.(); return T.update(existing.id, { category_id: category.id }); });
      options.onDone?.("Category changed.");
    } });
    return showChangePreview(m, {Category:C.labelId(existing.category_id)}, f=>({Category:C.labelId(f.get("category_id"))}));
  }
  const kind = existing.kind;
  const accountId=localReference(action,"account_name");
  const requestedAccount = p.account_name ? A.active().filter((a) => accountId ? a.id===accountId : a.name.toLowerCase() === p.account_name.toLowerCase()) : [];
  const categoryId=localReference(action,"category_name");
  const requestedCategory = p.category_name ? C.list(kind).filter((c) => categoryId ? c.id===categoryId : C.label(c).toLowerCase() === p.category_name.toLowerCase()) : [];
  if (p.account_name && requestedAccount.length !== 1) { options.onMessage?.("That account is missing or unclear. Nothing was changed; choose the account in Records or try again."); return null; }
  if (p.category_name && requestedCategory.length !== 1) { options.onMessage?.("That category is missing or unclear. Nothing was changed; choose it in the form or try again."); return null; }
  const suppliedAmount = Object.hasOwn(p, "amount_text");
  const amountCurrency = p.currency || existing.entered_money?.currency || existing.money.currency;
  const moneyInputValue = suppliedAmount ? textAmount(p.amount_text, amountCurrency) : (existing.entered_money || existing.money);
  if (suppliedAmount && !moneyInputValue) { options.onMessage?.("That amount could not be read safely. Nothing was changed; correct it in the transaction form."); return null; }
  const initialDate = p.date || existing.date;
  const initialRate = p.rate_text == null ? null : String(p.rate_text);
  const initialBaseRate = p.base_rate_text == null ? null : String(p.base_rate_text);
  try {
    if (initialRate !== null) fx.validateRate(initialRate);
    if (initialBaseRate !== null) fx.validateRate(initialBaseRate);
  } catch (error) {
    options.onMessage?.(`${error.message} Nothing was changed; correct it in the transaction form.`);
    return null;
  }
  const modalArgs = {
    title: "Edit transaction", existing,
    suppressCategoryAI: true,
    beforeCommit: () => { if (!validCurrent()) throw new Error(options.isCurrent?.() === false ? "Conversation changed. Review again; no change saved." : "This record changed or is no longer eligible. Search again; no change was saved."); options.onBeforeCommit?.(); },
    work: options.work,
    initialRate,
    initialBaseRate,
    onDone: (row) => options.onDone?.(row),
  };
  // The owning transaction form provides amount/currency/date/account/category/note and its normal FX controls.
  const dialog = T.confirmModal({ ...existing,
    account_id: p.account_name ? requestedAccount[0]?.id : existing.account_id,
    category_id: p.category_name ? requestedCategory[0]?.id : existing.category_id,
    date: initialDate,
    money: moneyInputValue || existing.money,
    entered_money: suppliedAmount ? moneyInputValue : existing.entered_money,
    entered_fx: amountCurrency === (existing.entered_money || existing.money).currency && initialDate === existing.date && (!p.account_name || requestedAccount[0]?.id === existing.account_id) ? existing.entered_fx : null,
    merchant: p.merchant === undefined ? existing.merchant : p.merchant,
    note: p.note === undefined ? existing.note : p.note,
    source: "assistant",
  }, modalArgs);
  const originalMoney=existing.entered_money||existing.money;
  return showChangePreview(dialog, {
    Kind:existing.kind,Account:A.get(existing.account_id)?.name||"Unavailable",Amount:`${toDecimalString(originalMoney)} ${originalMoney.currency}`,Date:existing.date,Category:C.labelId(existing.category_id),Merchant:existing.merchant||"—",Note:existing.note||"—",Rate:existing.entered_fx?.rate||"Saved/manual rate rules",'Base rate':existing.fx?.rate||"Saved/manual rate rules",
  }, f=>({Kind:f.get("kind"),Account:A.get(f.get("account_id"))?.name||"Unavailable",Amount:`${f.get("amount")} ${f.get("currency")}`,Date:f.get("date"),Category:C.labelId(f.get("category_id")),Merchant:f.get("merchant")||"—",Note:f.get("note")||"—",Rate:f.get("rate")||"Saved/manual rate rules",'Base rate':f.get("base_rate")||"Saved/manual rate rules"}));
}
function openNormalDraft(action, options) {
  const p = cleanParams(action.kind, action.params || {});
  const generation=store.generation(),owner=ownerId(),revision=accessRevision();
  const guard=()=>{if(!checkLocalReferences(action)||generation!==store.generation()||owner!==ownerId()||revision!==accessRevision()||options.isCurrent?.()===false)throw new Error("Access, reference or conversation changed. Reopen the normal form.");options.onBeforeCommit?.();};
  const named=(rows,label,name,param)=>{if(!name)return null;const id=localReference(action,param);if(id){const chosen=rows.find(r=>r.id===id);if(!chosen||label(chosen).toLowerCase()!==String(name).toLowerCase())throw new Error("The selected record is no longer eligible. Choose it in the normal screen.");return chosen;}const matches=rows.filter(r=>label(r).toLowerCase()===String(name).toLowerCase());if(matches.length!==1)throw new Error("The named record is missing or matches more than one item. Choose it in the normal screen.");return matches[0];}
  const amount=(text,currency)=>{if(text==null)return null;const m=textAmount(text,currency);if(!m)throw new Error("That amount could not be read safely. Correct it in the normal form.");return m;};
  const guardRow=(table,row)=>{const before=JSON.stringify(row);return ()=>{guard();if(!row||JSON.stringify(store.get(table,row.id))!==before)throw new Error("That record changed. Review it again before saving.");};};
  if(action.kind==="set_budget"){const category=named(C.list("expense"),C.label,p.category_name,"category_name");return B.catModal(null,{categoryId:category?.id,limit:amount(p.amount_text,base()),onDone:options.onDone,beforeCommit:category?guardRow("categories",category):guard});}
  if(action.kind==="set_savings_target"){
    const original=JSON.stringify(B.savings().budget);
    const beforeCommit=()=>{if(JSON.stringify(B.savings().budget)!==original)throw new Error("The savings target changed. Review the current target before saving.");guard();};
    return B.savingsModal(B.savings(),{amountText:p.amount_text,percentText:p.percent_text,allowRemove:false,onDone:options.onDone,beforeCommit});
  }
  if(action.kind==="create_goal"){const account=named(A.active(),a=>a.name,p.account_name,"account_name");return G.newGoalModal({name:p.name,target:amount(p.amount_text,base()),targetDate:p.date,accountId:account?.id,onDone:options.onDone,beforeCommit:account?guardRow("accounts",account):guard});}
  if(action.kind==="contribute_goal"){const goal=named(G.list("active"),g=>g.name,p.goal_name,"goal_name");if(!goal)throw new Error("Choose a goal in Goals, then log the contribution.");return G.contributionModal(goal.id,{amount:amount(p.amount_text,base()),date:p.date,onDone:options.onDone,beforeCommit:guardRow("goals",goal)});}
  if(action.kind==="snapshot_now")return modal({title:"Take a net worth snapshot?",body:"<p>The normal snapshot calculation is saved to history only after you confirm.</p>",onSubmit:()=>{guard();return NW.takeSnapshot("manual");},onSuccess:options.onDone});
  if(action.kind==="log_investment_value"){const holding=named(H.list("active"),h=>h.name,p.holding_name,"holding_name");if(!holding)throw new Error("Choose the investment in Investments, then Set value.");return H.valueModal(holding.id,{value:amount(p.amount_text,holding.currency),date:p.date,onDone:options.onDone,beforeCommit:guardRow("holdings",holding)});}
  if(action.kind==="create_recurring"){const account=named(A.active(),a=>a.name,p.account_name,"account_name"),kind=p.kind||"expense",category=named(C.list(kind),C.label,p.category_name,"category_name");return T.ruleModal({name:p.name,template:{kind,account_id:account?.id,money:amount(p.amount_text,account?.currency||base()),merchant:p.merchant,category_id:category?.id},schedule:{freq:p.freq||"monthly",interval:p.interval||1,start:p.start_date||today(),end:p.end_date||null}},null,{onDone:options.onDone,beforeCommit:guard});}
  if (action.kind === "log_transaction") {
    const accountId=localReference(action,"account_name");
    const accounts = p.account_name ? A.active().filter((a) => accountId ? a.id===accountId : a.name.toLowerCase() === p.account_name.toLowerCase()) : [];
    const categoryId=localReference(action,"category_name");
    const cats = p.category_name ? C.list(p.kind || "expense").filter((c) => categoryId ? c.id===categoryId : C.label(c).toLowerCase() === p.category_name.toLowerCase()) : [];
    const unresolvedFields = {};
    if (p.account_name && accounts.length !== 1) unresolvedFields.account_id = "Choose an account for this transaction.";
    if (p.category_name && cats.length !== 1) unresolvedFields.category_id = "Choose a category for this transaction.";
    const currency = p.currency || (accounts.length === 1 ? accounts[0].currency : null) || base();
    const parsed = Object.hasOwn(p,"amount_text") ? textAmount(String(p.amount_text),currency) : null;
    if(Object.hasOwn(p,"amount_text")&&!parsed){options.onMessage?.("That amount could not be read safely; nothing was saved.");return null;}
    const draft = { kind: p.kind || "expense", money: parsed || undefined, currency, account_id: accounts.length === 1 ? accounts[0].id : undefined, category_id: cats.length === 1 ? cats[0].id : undefined, date: p.date || today(), merchant: p.merchant, note: p.note, source: "assistant" };
    const initialRate = p.rate_text == null ? null : String(p.rate_text);
    const initialBaseRate = p.base_rate_text == null ? null : String(p.base_rate_text);
    try {
      if (initialRate !== null) fx.validateRate(initialRate);
      if (initialBaseRate !== null) fx.validateRate(initialBaseRate);
    } catch (error) {
      options.onMessage?.(`${error.message} Nothing was saved.`);
      return null;
    }
    return T.confirmModal(draft, { title: "Review transaction", suppressCategoryAI: true, work: options.work, beforeCommit:guard, initialRate, initialBaseRate, onDone: options.onDone, ...(Object.keys(unresolvedFields).length ? { unresolvedFields } : {}) });
  }
  if (action.kind === "add_account") {
    const currency = p.currency || base(), amount = Object.hasOwn(p, "amount_text") ? textAmount(String(p.amount_text), currency) : null;
    if (Object.hasOwn(p, "amount_text") && !amount) { options.onMessage?.("That opening amount could not be read safely; nothing was saved."); return null; }
    const creditLimit = p.credit_limit_text == null ? null : textAmount(String(p.credit_limit_text), currency);
    if (p.credit_limit_text != null && !creditLimit) { options.onMessage?.("That credit limit could not be read safely; nothing was saved."); return null; }
    return A.newAccountModal((row) => options.onDone?.(row), { name: p.name, type: p.account_type, currency, opening: amount ? toDecimalString(amount) : "", opened_on: p.opening_date, credit_limit: creditLimit ? toDecimalString(creditLimit) : "", statement_day: p.statement_day ?? "", beforeCommit: guard });
  }
  if (action.kind === "transfer") {
    const fromId=localReference(action,"from_account"),toId=localReference(action,"to_account");
    const from = p.from_account ? A.active().filter((a) => fromId ? a.id===fromId : a.name.toLowerCase() === p.from_account.toLowerCase()) : [];
    const to = p.to_account ? A.active().filter((a) => toId ? a.id===toId : a.name.toLowerCase() === p.to_account.toLowerCase()) : [];
    if (from.length !== 1 || to.length !== 1) { options.onMessage?.("Choose the exact sending and receiving accounts in the transfer form."); return null; }
    const out = textAmount(String(p.amount_text || ""), from[0].currency); let incoming = p.counter_amount_text ? textAmount(String(p.counter_amount_text), to[0].currency) : null;
    if(out&&!incoming&&(p.counter_amount_text==null||p.counter_amount_text==="")&&p.rate_text!=null&&from[0].currency!==to[0].currency){try{fx.validateRate(String(p.rate_text));incoming=moneyConvert(out,to[0].currency,String(p.rate_text));}catch(error){options.onMessage?.(`${error.message} Correct the rate in the transfer form; nothing was saved.`);return null;}}
    if (!out || p.counter_amount_text && !incoming) { options.onMessage?.("A transfer amount could not be read safely; nothing was saved."); return null; }
    return A.transferModal({ fromId: from[0].id, toId: to[0].id, out: toDecimalString(out), in: incoming ? toDecimalString(incoming) : "", date: p.date || today(), note: p.note || "", beforeCommit:guard, onDone: options.onDone });
  }
  options.onMessage?.(`The ${action.kind} normal form is not available through the current owning form API; nothing was saved.`);
  return null;
}
function activate(action, options, _candidates, candidate) {
  const valid = checkLocalReferences(action) && options.isCurrent?.() !== false && currentCandidate(action, candidate);
  if (!valid) { const message = options.isCurrent?.() === false ? "Conversation changed. Review again; no change saved." : "That selection is unavailable or stale. Search again or use Records."; options.onMessage?.(message); toast(message); return; }
  reviewSelected(action, options, candidate);
}
export function openDraft(action, { work = null, onDone = null, onMessage = null, selected = null, isCurrent = null, onBeforeCommit = null } = {}) {
  if (!action || typeof action !== "object") return null;
  if(!checkLocalReferences(action)){onMessage?.("Saved information changed. Ask again or use Records; no change was saved.");return null;}
  try { cleanParams(action.kind, action.params || {}); } catch (error) { onMessage?.(error.message); return null; }
  if (["edit_transaction", "cancel_transaction", "set_category"].includes(action.kind)) {
    const offeredSet = prepareCandidates(action);
    const candidates = offeredSet.candidates;
    if (selected) { activate(action, { work, onDone, onMessage, isCurrent, onBeforeCommit }, candidates, selected); return offeredSet; }
    if (!candidates.length) { onMessage?.("No matching record. Nothing was changed; try another search or use Records."); return offeredSet; }
    let pageStart = 0;
    const choosePage = () => {
    const page = candidates.slice(pageStart, pageStart + 5);
    const labels = page.map((candidate, i) => [`${pageStart + i + 1}. ${candidate.description}`, `${i}`]);
    const picker = modal({ title: "Choose the record", cancelLabel: "Back", body: `${page.map((x) => `<p>${esc(x.description)}</p>`).join("")}<p>Select the exact record to review. This does not save a change.</p>${field("Record", sel("candidate", labels, undefined, (x) => x[0], (x) => x[1]))}<div class="actions">${pageStart ? '<button type="button" data-previous>Previous</button>' : ''}${pageStart + 5 < candidates.length ? '<button type="button" data-more>Show more</button>' : ''}<a href="#/transactions" class="btn">Open Records</a></div>`, onSubmit: (form) => {
      const choice = page[Number(form.get("candidate"))];
      picker.close("submit");
      activate(action, { work, onDone, onMessage, isCurrent, onBeforeCommit }, candidates, choice);
    } });
    picker.form.querySelector('[data-more]')?.addEventListener('click',()=>{picker.close('more');pageStart+=5;choosePage();});
    picker.form.querySelector('[data-previous]')?.addEventListener('click',()=>{picker.close('previous');pageStart-=5;choosePage();});
    return picker;
    };
    return { candidates, picker: choosePage() };
  }
  return openNormalDraft(action, { work, onDone, onMessage, isCurrent, onBeforeCommit });
}

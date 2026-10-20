// Domain validation: disposable in-memory profiles, no browser, provider or real records.
import assert from 'node:assert/strict';
Object.defineProperty(globalThis, 'navigator', { value: { storage: null }, configurable: true });
globalThis.location = { hash: '#/accounts' }; globalThis.window = { scrollTo() {} };
globalThis.document = { getElementById: () => ({ innerHTML: '' }), querySelector: () => null, querySelectorAll: () => [], body: {} };
let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('No network in account validation'); };
const P = new URL('../public/js/', import.meta.url).href, M = p => import(P + p);
const {store} = await M('lib/store.js'), {money,parseMoney} = await M('lib/money.js');
const A = await M('features/accounts.js'), PFL = await M('features/profile.js');
PFL.createProfile({base_currency:'SGD',timezone:'UTC',self_description:'working',ai_provider:false});
const today = PFL.today(), failures = [];
const check = (value, message) => {console.log(`${value?'PASS':'FAIL'} ${message}`);if(!value) failures.push(message);};
const bank = A.create({name:'Bank',type:'bank',currency:'SGD',openingBalance:money(10000,'SGD'),openedOn:'2026-01-01'});
const other = A.create({name:'Other',type:'bank',currency:'SGD',openingBalance:money(0,'SGD'),openedOn:'2026-01-01'});
const usd = A.create({name:'USD',type:'wallet',currency:'USD',openingBalance:money(0,'USD'),openedOn:'2026-01-01'});
const card = A.create({name:'Card',type:'credit',currency:'SGD',openingBalance:money(-5000,'SGD'),openedOn:'2026-01-01'});
const defaults = A.create({name:'API defaults',type:'cash',currency:'SGD'});
check(defaults.opening_balance.amount===0 && defaults.opened_on===today, 'existing omitted API opening/date defaults remain explicit constructor defaults');
check(parseMoney('1.239','SGD').amount===123 && parseMoney('1.9','JPY').amount===1,'existing parser retains its SGD and JPY decimal-input behavior without extra precision rules');
check(A.balance(card.id).amount===-5000 && A.available(card)===null, 'negative credit opening balance and absent limit remain supported');
const reject = (fn, field, label) => {
 const before=store.snapshot();let error;
 try {fn();} catch(e) {error=e;}
 check(!!error?.fields?.[field] && JSON.stringify(store.snapshot())===JSON.stringify(before), `${label}: named ${field} issue before any write`);
 store.open(before,null,'account-validation-test');
};
const create = patch => A.create({name:'New',type:'bank',currency:'SGD',openingBalance:money(0,'SGD'),openedOn:today,...patch});
for(const [patch,field,label] of [
 [{name:'   '},'name','blank name'],[{type:'unsupported'},'type','unsupported type'],[{currency:'XYZ'},'currency','unsupported currency'],
 [{openingBalance:null},'opening','explicit missing opening'],[{openingBalance:{amount:NaN,currency:'SGD'}},'opening','invalid opening'],
 [{openingBalance:money(1,'USD')},'opening','wrong opening currency'],[{openedOn:''},'opened_on','typed blank opening date'],
 [{openedOn:'2026-02-30'},'opened_on','impossible opening date'],
 [{type:'credit',creditLimit:money(100,'USD')},'limit','wrong limit currency'],
 [{type:'credit',statementDay:0},'statement_day','day zero'],[{type:'credit',statementDay:32},'statement_day','day 32'],
 [{type:'credit',statementDay:1.5},'statement_day','fractional day'],
]) reject(()=>create(patch),field,label);
for(const [patch,field] of [[{name:' '},'name'],[{credit_limit:money(1,'USD')},'limit'],[{statement_day:32},'statement_day']]) reject(()=>A.update(card.id,patch),field,'invalid account edit');
reject(()=>A.update(defaults.id,{currency:'USD'}),'opening','currency edit with opening Money still in old currency');
const adjustableCard=A.create({name:'Adjustable card',type:'credit',currency:'SGD',openingBalance:money(-100,'SGD'),openedOn:today,creditLimit:money(1000,'SGD')});
reject(()=>A.update(adjustableCard.id,{currency:'USD',opening_balance:money(-10000,'USD')}),'limit','currency edit with credit limit still in old currency');
const adjusted=A.update(defaults.id,{currency:'USD',opening_balance:money(0,'USD')});
check(adjusted.currency==='USD'&&adjusted.opening_balance.currency==='USD','consistent pre-transaction API currency and opening Money change remains supported');
const transfer = patch => A.transfer({fromId:bank.id,toId:other.id,moneyOut:money(100,'SGD'),date:today,...patch});
for(const [patch,field,label] of [
 [{fromId:'missing'},'from','missing sender'],[{toId:bank.id},'to','same endpoints'],[{moneyOut:money(0,'SGD')},'out','zero transfer'],
 [{moneyOut:money(100,'USD')},'out','wrong outgoing currency'],[{date:undefined},'date','missing transfer date'],
 [{date:'2026-02-30'},'date','impossible transfer date'],[{date:'2099-01-01'},'date','future transfer'],[{date:'2025-12-31'},'date','before opening'],
 [{toId:usd.id,moneyIn:null},'in','missing actual foreign receipt'],[{toId:usd.id,moneyIn:money(100,'SGD')},'in','wrong incoming currency'],
]) reject(()=>transfer(patch),field,label);
reject(()=>A.reconcileCheck('missing',today,null),'account','missing balance-check account');
reject(()=>A.reconcileCheck(bank.id,'2026-02-30',null),'date','invalid balance-check date');
reject(()=>A.reconcileCheck(bank.id,today,money(100,'USD')),'bank','wrong statement currency');
reject(()=>A.saveReconciliation(bank.id,'2026-02-30',null,money(10000,'SGD'),null),'date','invalid reconciliation save');
reject(()=>A.saveReconciliation(bank.id,today,money(1,'USD'),money(10000,'SGD'),money(-9999,'SGD')),'bank','wrong reconciliation statement currency');
reject(()=>A.saveReconciliation(bank.id,today,null,money(10000,'SGD'),money(0,'SGD')),'bank','gap without statement balance');
reject(()=>A.saveReconciliation(bank.id,today,money(1,'SGD'),money(10000,'USD'),money(-9999,'SGD')),'computed','wrong computed balance currency');
reject(()=>A.saveReconciliation(bank.id,today,money(1,'SGD'),money(9999,'SGD'),money(-9998,'SGD')),'computed','unverified computed balance amount');
reject(()=>A.update(bank.id,{currency:'XYZ'}),'currency','unsupported account edit currency');
const tx=transfer({});check(tx.money.amount===100 && tx.counter_money.amount===100 && A.balance(bank.id).amount===9900 && A.balance(other.id).amount===100,'valid same-currency transfer remains one row moving both balances');
reject(()=>A.update(bank.id,{currency:'USD'}),'currency','account currency edit with transactions');
const absent=A.reconcileCheck(bank.id,today,null);check(absent.gap===null && absent.computed.amount===9900,'absent statement balance remains absent, not zero');
const absentSaved=A.saveReconciliation(bank.id,today,null,absent.computed,null);check(absentSaved.statement_balance===null && absentSaved.gap===null,'saved absent statement and gap remain absent');
store.softDelete('transactions',tx.id);
reject(()=>A.update(other.id,{currency:'USD'}),'currency','account currency edit with retained deleted transfer history');
check(requests===0,'account validation and calculations never call AI');
assert.deepEqual(failures,[],failures.join('\n'));
console.log('PASS account domain validation and unchanged valid/default/absent behavior');

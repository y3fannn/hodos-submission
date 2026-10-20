// Cooperative demo recipe: scheduling/cancellation and exact synchronous/stepped equivalence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runDemoSteps } from '../public/js/lib/demo-loading.js';
import { seedDemo, seedDemoSteps } from '../public/js/features/seed.js';
import { store } from '../public/js/lib/store.js';
import { createProfile, DEMO_PROFILE } from '../public/js/features/profile.js';
let checks=0;
const ok=(v,n)=>{assert.ok(v,n);checks++;};
let clock=0, pauses=0, work=0;
function* slow(){for(let i=0;i<10;i++){work++;clock+=4;yield;}}
await runDemoSteps(slow(),{now:()=>clock,yieldControl:async()=>{pauses++;}});
ok(work===10 && pauses>=4,'long setup yields in short groups');
pauses=0;
await runDemoSteps([1,2,3].values(),{now:()=>0,yieldControl:async()=>{pauses++;}});
ok(pauses===0,'fast setup has no artificial pause');
let cancelled=false; work=0; clock=0;
await assert.rejects(runDemoSteps(slow(),{now:()=>clock,cancelled:()=>cancelled,yieldControl:async()=>{cancelled=true;}}),e=>e.name==='AbortError');
ok(work<10,'cancellation stops before remaining records');
let closed=false;
function* failure(){try{yield;throw new Error('fixture');}finally{closed=true;}}
await assert.rejects(runDemoSteps(failure()),/fixture/);
ok(closed,'errors unwind recipe');

// Fixed test clock/IDs compare every stored field, not just row counts or rounded totals.
const RealDate=globalThis.Date, cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
let id=0;
class Clock extends RealDate {constructor(...args){super(...(args.length?args:['2026-10-05T12:00:00Z']));} static now(){return new RealDate('2026-10-05T12:00:00Z').getTime();}}
try {
 globalThis.Date=Clock;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues(a){a.fill(0);new DataView(a.buffer,a.byteOffset,a.byteLength).setUint32(12,++id);return a;}}});
 store.open(null);createProfile(DEMO_PROFILE());id=100;
 seedDemo(); const expected=store.snapshot();
 // Preserve the complete deployed finance fixture, excluding the intentional ownership change.
 // Rebuild only the old metadata order/label; no financial field or value is discarded.
 const baseline = { ...expected, tables: Object.fromEntries(Object.entries(expected.tables).map(([table, rows]) => [table, rows.map(row => {
  const {id, user_id: _owner, created_at, updated_at, deleted_at, ...fields} = row;
  return {id, user_id:'local-user', created_at, updated_at, deleted_at, ...fields};
 })])) };
 ok(createHash('sha256').update(JSON.stringify(baseline)).digest('hex')==='afb843fa38d3e0dc5adbaa3434d4f7612ea7b7eae496fa5f029f357a65ccd7ad','all sample financial fields/math match deployed baseline; ownership is intentionally separate');
 store.close();id=0;store.open(null);createProfile(DEMO_PROFILE());id=100;
 await runDemoSteps(seedDemoSteps(),{now:()=>0});
 assert.deepEqual(store.snapshot(),expected); checks++;
 ok(store.counts().transactions>1000 && store.counts().holdings===6,'full sample history remains');
} finally {store.close();globalThis.Date=RealDate;Object.defineProperty(globalThis,'crypto',cryptoDescriptor);}
console.log(`${checks} demo-loading checks passed`);

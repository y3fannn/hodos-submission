// One combined prototype journey, reused by local and published-page checks.
import assert from 'node:assert/strict';
export async function checkScrollPreview({cmd,js,waitFor,baseUrl,shot}) {
  // Control only the test page's frame clock for exact elapsed-time assertions. The
  // shipped controller has no test hooks. Native-clock gestures are checked too.
  const clockScript=await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=requestAnimationFrame.bind(window),cancel=cancelAnimationFrame.bind(window),now=performance.now.bind(performance);
    window.__previewNativeRAF=native;
    const c=window.__fadeClock={active:true,time:0,next:100000,queue:new Map(),tick(ms){this.time+=ms;const q=[...this.queue.values()];this.queue.clear();for(const f of q)f(this.time)},release(){this.active=false}};
    window.requestAnimationFrame=f=>{if(!c.active)return native(f);const id=c.next++;c.queue.set(id,f);return id};
    window.cancelAnimationFrame=id=>{if(c.queue.has(id))c.queue.delete(id);else cancel(id)};
    Object.defineProperty(performance,'now',{configurable:true,value:()=>c.active?c.time:now()});
  })()`});
  const frames=()=>js('new Promise(done=>{const f=window.__previewNativeRAF||requestAnimationFrame;f(()=>f(done))})');
  const tick=ms=>js(`window.__fadeClock.tick(${ms})`);
  const resize=async(width,height)=>{await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await frames();};
  const measure=()=>js(`(()=>{const e=document.querySelector('.scroll-story'),s=e.querySelector('.story-stage');return {start:e.getBoundingClientRect().top+scrollY-document.querySelector('header').getBoundingClientRect().height,travel:e.offsetHeight-s.offsetHeight}})()`);
  const sample=()=>js(`(()=>{const p=document.querySelector('.shared-phone'),c=[...document.querySelectorAll('.scene-list .scene-copy')],a=[...p.children].map(e=>Number(getComputedStyle(e).opacity)),w=a.map((n,i)=>n*a.slice(i+1).reduce((v,x)=>v*(1-x),1)),r=p.getBoundingClientRect(),s=document.querySelector('.scroll-story');return {weights:w,words:c.map(e=>Number(getComputedStyle(e).opacity)),anchor:[r.x,r.y,c[0].getBoundingClientRect().top],focus:document.activeElement.id,target:Number(s.dataset.scene),moving:s.dataset.animating==='true',duration:s.dataset.fadeDuration}})()`);
  const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<.0001,`${label}: ${actual} vs ${expected}`);
  let geometry;
  const go=async(fraction,settled=false)=>{await js(`scrollTo(0,${geometry.start+geometry.travel*fraction})`);await frames();await tick(0);if(settled)await tick(600);};
  await cmd('Emulation.setScriptExecutionDisabled',{value:false});
  await cmd('Emulation.setEmulatedMedia',{features:[]});
  await resize(1440,1000);
  const url=new URL('scroll-preview.html',baseUrl).href;
  await cmd('Page.navigate',{url});
  await waitFor(`!!document.querySelector('.scroll-story.is-pinned')&&[...document.images].every(e=>e.complete&&e.naturalWidth>0)`);
  assert.equal(await js(`!!document.querySelector('details,summary,[role=tablist]')`),false);
  assert.equal(await js(`document.querySelector('.chapter-label').textContent`),'Chapter 3 of 5');
  assert.equal(await js(`[...document.querySelectorAll('.phone')].every(e=>!e.textContent.trim())`),true);
  assert.equal(await js(`[...document.images].filter(e=>e.src.includes('/assets/scroll-')).every(e=>e.naturalWidth===1680&&e.naturalHeight===3120)`),true);
  assert.equal(await js(`getComputedStyle(document.querySelector('.shared-phone')).transform`),'none');
  await js(`document.getElementById('main').focus({preventScroll:true})`);
  let profiles=0;
  for(const [width,height] of [[1440,1000],[1280,800]]) {
    await resize(width,height);geometry=await measure();
    let anchor;
    for(const reverse of [false,true]) for(const index of [0,1,2]) for(const slow of [false,true]) {
      const from=reverse?index+1:index,to=reverse?index:index+1;
      await go((from+.1)/4,true);
      await go((index+(reverse?.60:.80))/4);
      let elapsed=0;
      for(const at of [0,120,300,480,600]) {
        if(slow&&at)await go((index+(reverse?.60-at/600*.1:.80+at/600*.18))/4);
        await tick(at-elapsed);elapsed=at;
        const s=await sample(),p=at/600;
        assert.equal(s.duration,'600');assert.equal(s.target,to);assert.equal(s.focus,'main');
        near(s.weights.reduce((a,b)=>a+b,0),1,'No compositing dip');
        for(let i=0;i<4;i++) {
          near(s.weights[i],i===from?1-p:i===to?p:0,'600ms screen weights, independent of scroll speed');
          near(s.words[i],i===from?Math.max(0,1-2*p):i===to?Math.max(0,2*p-1):0,'Sequential timed words');
        }
        assert.ok(s.words.filter(n=>n>.001).length<=1,'No overlapping readable sentences');
        anchor ||= s.anchor;s.anchor.forEach((n,i)=>assert.ok(Math.abs(n-anchor[i])<1.5,'Fixed phone/copy anchors'));
        assert.equal(s.moving,at<600);
        if(width===1440&&!reverse&&index===0&&!slow&&[120,300,480].includes(at))await shot?.('scroll-fade-'+Math.round(p*100));
        profiles++;
      }
      await tick(1200);assert.equal((await sample()).moving,false,'No autonomous scene progression');
      assert.equal(await js(`window.__fadeClock.queue.size`),0,'No idle animation loop');
    }
  }
  await resize(1440,1000);geometry=await measure();
  // Interrupt a real rendered mixture: retarget directly, without opacity jumps or a queue.
  await go(.1/4,true);await go(.8/4);await tick(200);
  const before=await sample();await go(.9);const after=await sample();
  before.weights.forEach((n,i)=>near(after.weights[i],n,'Retarget preserves visible mixture'));
  before.words.forEach((n,i)=>near(after.words[i],n,'Retarget preserves word opacity'));
  assert.equal(after.target,3);await tick(600);near((await sample()).weights[3],1,'Latest target wins, no intermediate parade');
  await tick(1200);assert.equal((await sample()).target,3);
  for(const index of [0,1,2,3,1,0]) {
    await go((index+.1)/4,true);const s=await sample();near(s.weights[index],1,'Settled native screen');near(s.words[index],1,'Settled words');
    if(index===2)await shot?.('scroll-bills');
  }
  await go(0,true);await shot?.('scroll-desktop');
  // Release clock control and measure actual browser elapsed time for a fast jump and
  // a slower gesture that keeps moving within the same destination during its fade.
  await js(`window.__fadeClock.release()`);
  const durations=[];
  for(const slow of [false,true]) {
    await js(`scrollTo(0,${geometry.start})`);await frames();
    await waitFor(`document.querySelector('.scroll-story').dataset.scene==='0'&&document.querySelector('.scroll-story').dataset.animating==='false'`);
    durations.push(await js(`new Promise((resolve,reject)=>{const s=document.querySelector('.scroll-story');let began;const timers=[];const done=(error,value)=>{o.disconnect();timers.forEach(clearTimeout);error?reject(error):resolve(value)};const o=new MutationObserver(()=>{if(s.dataset.animating==='true'&&began===undefined)began=performance.now();if(s.dataset.animating==='false'&&began!==undefined)done(null,performance.now()-began)});o.observe(s,{attributes:true,attributeFilter:['data-animating']});timers.push(setTimeout(()=>done(new Error('Timed fade did not finish')),2000));scrollTo(0,${geometry.start+geometry.travel*(slow?.8/4:.9)});${slow?`timers.push(setTimeout(()=>scrollTo(0,${geometry.start+geometry.travel*.9/4}),150),setTimeout(()=>scrollTo(0,${geometry.start+geometry.travel*.98/4}),300));`:''}})`));
  }
  durations.forEach(ms=>assert.ok(ms>=560&&ms<800,`Actual600msbrowser fade: ${ms}`));
  assert.ok(Math.abs(durations[0]-durations[1])<120,'Fast/slow gesture timing matches');
  await js(`dispatchEvent(new PageTransitionEvent('pagehide'))`);assert.equal((await sample()).moving,false);
  await js(`dispatchEvent(new PageTransitionEvent('pageshow'))`);await frames();
  const resources=await js(`performance.getEntriesByType('resource').map(e=>({url:e.name,type:e.initiatorType}))`);
  assert.ok(resources.every(e=>new URL(e.url).origin===new URL(url).origin&&!['fetch','xmlhttprequest','beacon'].includes(e.type)));
  assert.deepEqual(await js(`window.previewViolations||[]`),[]);assert.equal(await js(`localStorage.length+sessionStorage.length`),0);
  await cmd('Page.removeScriptToEvaluateOnNewDocument',{identifier:clockScript.result.identifier});
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await frames();
  await waitFor(`!document.querySelector('.scroll-story').classList.contains('is-pinned')`);
  assert.equal(await js(`[...document.querySelectorAll('.scene .phone')].every(e=>e.getBoundingClientRect().height>0)`),true);
  await cmd('Emulation.setEmulatedMedia',{features:[]});await resize(390,844);
  assert.equal(await js(`document.querySelector('.scroll-story').classList.contains('is-pinned')`),false);
  assert.ok(await js(`document.documentElement.scrollWidth<=390`));
  assert.equal(await js(`[...document.querySelectorAll('.scene .phone')].every(e=>e.getBoundingClientRect().width>=350)`),true);
  await js(`scrollTo(0,0)`);await shot?.('scroll-mobile');
  await resize(1024,500);assert.equal(await js(`document.querySelector('.scroll-story').classList.contains('is-pinned')`),false);
  await cmd('Emulation.setScriptExecutionDisabled',{value:true});await cmd('Page.navigate',{url});
  await waitFor(`document.querySelectorAll('[data-scene]').length===4`);
  assert.equal(await js(`[...document.querySelectorAll('.scene-copy,.scene .phone')].every(e=>e.getBoundingClientRect().height>0)`),true);
  assert.equal(await js(`!!document.querySelector('.shared-phone')`),false);
  await cmd('Emulation.setScriptExecutionDisabled',{value:false});
  return 'PASS scroll prototype: fixed600msfade independent of scroll speed; '+profiles+' controlled-time profiles/all3changes/both directions/2desktop sizes/fast+slow; actual fast+slow durations '+durations.map(n=>n.toFixed(1)).join('/')+'ms; continuous latest-target retarget/no queue, opaque image blend/sequential words/fixed anchors/no focus steal; no idle autoplay; lifecycle/reduced/narrow/short/no-JS/privacy/4xnative guards';
}

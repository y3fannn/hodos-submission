// Shared full-site journey used by the two existing local/package/public checks.
import assert from 'node:assert/strict';
import {previewFiles} from '../package.mjs';
export async function checkFullSite({cmd,js,waitFor,baseUrl,shot}) {
  const results=[];
  const frames=()=>js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const resize=async(width,height=1000)=>{await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});await frames();};
  const settled=()=>waitFor(`[...document.querySelectorAll('.scroll-story.is-pinned')].every(e=>e.dataset.animating==='false')`);
  await cmd('Emulation.setScriptExecutionDisabled',{value:false});await cmd('Emulation.setEmulatedMedia',{features:[]});
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`window.previewViolations=[];for(const name of ['fetch','XMLHttpRequest','WebSocket','EventSource'])window[name]=function(){previewViolations.push(name);throw new Error('Preview attempted '+name)};Storage.prototype.setItem=function(){previewViolations.push('storage');throw new Error('Preview attempted storage')};`});
  await resize(1440);await cmd('Page.navigate',{url:baseUrl});
  await waitFor(`!!document.querySelector('.site-header.has-js')&&document.querySelector('.hero-visual img').naturalWidth>0`);
  await js(`document.querySelectorAll('img').forEach(e=>e.loading='eager')`);
  await waitFor(`[...document.images].every(e=>e.complete&&e.naturalWidth>0)`);await settled();
  assert.equal(await js(`document.title`),'Hodos — One Assistant for every dollar');
  assert.match(await js(`document.querySelector('meta[name=robots]').content`),/noindex/);
  assert.equal(await js(`document.querySelector('h1').textContent`),'One Assistant for every dollar');
  assert.equal(await js(`document.querySelector('h1').nextElementSibling.textContent`),'Encrypted on your device');
  assert.equal(await js(`getComputedStyle(document.querySelector('.hero-visual')).transform`),'none');
  assert.equal(await js(`[...document.querySelectorAll('.brand>span')].every(e=>e.textContent==='Hodos')`),true);
  assert.equal(await js(`[...document.querySelectorAll('.button-primary')].every(e=>e.href==='https://app.hodos.consulting/#/signup'&&e.textContent==='Sign up')`),true);
  assert.equal(await js(`[...document.querySelectorAll('a')].filter(e=>e.textContent==='Explore demo').length`),3);
  assert.equal(await js(`[...document.querySelectorAll('a')].filter(e=>e.textContent==='Explore demo').every(e=>e.href==='https://app.hodos.consulting/#/demo')`),true);
  assert.equal(await js(`!!document.querySelector('details,summary,.menu-toggle,#evidence,.evidence-section,dialog,[role=tablist],[data-image],a[href$=".png"],.hero-lede,.chapter-number,.method-why,.ownership,.attack-example,.sample-note')`),false);
  assert.deepEqual(await js(`[...document.querySelectorAll('#site-nav a')].map(e=>e.textContent)`),['All features','Privacy']);
  assert.equal(await js(`document.querySelector('.hero-visual img').getAttribute('src')`),'assets/alex-home.png');
  assert.equal(/\.(?=\s|$)/.test(await js(`document.body.innerText`)),false,'No sentence full stops, monetary decimals preserved');
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-chapter]')].map(e=>e.dataset.chapter)`),['1','2','3','4','5']);
  assert.equal(await js(`document.querySelectorAll('.scroll-story.is-pinned[data-step-lock]').length`),6);
  assert.equal(await js(`[...document.querySelectorAll('.scroll-story')].every(e=>e.dataset.fadeDuration==='600')`),true);
  assert.equal(await js(`document.querySelectorAll('.scene-list > .scene').length`),17);
  assert.equal(await js(`[...document.querySelectorAll('.scene-copy,.visual-copy')].every(e=>e.querySelectorAll('h3').length===1&&e.querySelectorAll('p').length<=1&&e.children.length===1+e.querySelectorAll('p').length)`),true);
  assert.equal(await js(`[...document.querySelectorAll('.scroll-story')].every(e=>{const a=[...e.querySelectorAll('.scene-list .scene-copy')],b=[...e.querySelectorAll('.sr-only .scene-copy')];return a.length===b.length&&a.every((n,i)=>n.textContent===b[i].textContent)})`),true,'Complete static screen-reader equivalent');
  const features=await js(`[...document.querySelectorAll('[data-feature]')].map(e=>e.dataset.feature)`);
  for(const name of 'home accounts records add categories reconcile recurring budgets goals debts insurance investments networth assistant alerts settings'.split(' '))assert.ok(features.includes(name),name);
  assert.equal(features.length,20);
  assert.equal(await js(`new Set([...document.querySelectorAll('[id]')].map(e=>e.id)).size===document.querySelectorAll('[id]').length`),true,'Unique anchors after transcript cloning');
  assert.equal(await js(`document.querySelector('#story > .section-intro')`),null,'No Alex journey introduction');
  assert.equal(await js(`document.querySelector('#story').firstElementChild.id`),'records-story','Start directly with the first question');
  assert.match(await js(`document.querySelector('#regular-story').textContent`),/Autodetect regular spending patterns/);
  assert.match(await js(`document.querySelector('#budget-story').textContent`),/Factor in upcoming bills before spending/);
  assert.match(await js(`document.querySelector('#privacy').textContent`),/Know and control what is shared/);
  assert.equal(await js(`document.querySelector('#privacy .scene-list .sharing-mark img').getAttribute('src')`),'assets/native-ai-badge.png');
  assert.equal(await js(`document.querySelectorAll('.scene-list .native-visual picture').length`),3);
  assert.equal(await js(`document.querySelectorAll('.visual-row,.sharing-panel').length`),0,'All narrative visuals belong to scroll sequences');
  assert.equal(await js(`[...document.querySelectorAll('[data-media-layout="left"]')].every(e=>e.classList.contains('is-pinned')&&e.querySelector('.shared-media').getBoundingClientRect().right<e.querySelector('.scene-list').getBoundingClientRect().left)`),true,'Native charts/badge on left, words on right');
  assert.equal(await js(`[...document.querySelectorAll('.feature-gallery > figure')].every(e=>parseFloat(getComputedStyle(e).borderTopWidth)>=1&&parseFloat(getComputedStyle(e).paddingTop)>=24&&e.querySelector('.phone-frame').getBoundingClientRect().width<=300)`),true,'Distinct spaced feature cards with smaller desktop phones');
  assert.equal(await js(`document.querySelectorAll('figcaption').length`),20);
  assert.equal(await js(`[...document.querySelectorAll('[data-feature]')].every(e=>e.children.length===2&&e.lastElementChild.matches('figcaption')&&e.lastElementChild.children.length===1&&e.lastElementChild.firstElementChild.matches('strong')&&parseInt(getComputedStyle(e.querySelector('strong')).fontWeight)>=700)`),true,'Bold labels below each screen, no descriptions');
  const views=await js(`[...document.images].filter(e=>e.getAttribute('src').endsWith('.png')).map(e=>({src:e.getAttribute('src'),width:e.naturalWidth,height:e.naturalHeight,scale:e.getAttribute('src').startsWith('assets/scroll-')?4:3}))`);
  assert.ok(views.every(e=>previewFiles.includes(e.src)&&!e.src.includes('empty')&&e.width>0&&e.height>0));
  assert.ok(views.filter(e=>!e.src.startsWith('assets/native-')).every(e=>e.width===420*e.scale&&e.height===780*e.scale));
  results.push('PASS exact concise hero/CTAs, five questions,17scroll scenes/six sequences,20distinct bold-label feature cards, left-side native graphs/figures and sharing badge; populated native phones/filled forms, no marketing testing/technical narration');
  for(const width of [320,390,768,1024,1440]) {
    await resize(width,width<700?844:1000);await settled();
    if(width<900) {
      assert.equal(await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`),false);
      assert.ok(await js(`document.documentElement.scrollHeight>innerHeight`),'Mobile retains native page scrolling');
      await js(`document.querySelector('.feature-gallery > figure').scrollIntoView({block:'center'})`);
      await waitFor(`document.querySelector('.feature-gallery > figure.motion-entered')`);
      assert.equal(await js(`getComputedStyle(document.querySelector('.feature-gallery > figure')).animationDuration`),'0.52s','Mobile reveal uses a gentle one-time animation');
    }
    assert.ok(await js(`document.documentElement.scrollWidth<=${width}&&innerWidth<=${width}`),`Reflow${width}`);
    assert.equal(await js(`[...document.querySelectorAll('#site-nav a')].every(e=>e.getBoundingClientRect().height>=44)`),true,'Always-visible navigation');
    const small=await js(`(()=>{const bad=[],w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){const e=w.currentNode.parentElement;if(!w.currentNode.textContent.trim()||e.closest('script,style')||!e.getClientRects().length)continue;if(parseFloat(getComputedStyle(e).fontSize)<16)bad.push(w.currentNode.textContent)}return bad})()`);
    assert.deepEqual(small,[],`${width}px >=16copy`);
    assert.equal(await js(`[...document.querySelectorAll('a,button')].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=43)`),true,'Comfortable controls');
    const widths=await js(`[...document.querySelectorAll('.scroll-story .phone')].filter(e=>!e.closest('.sr-only')&&e.getBoundingClientRect().width>0).map(e=>e.querySelector('img').getBoundingClientRect().width)`);
    assert.ok(widths.length&&widths.every(n=>n>=Math.min(330,width-34)),`Readable phones${width}: ${widths}`);
  }
  await resize(1440);await js(`document.querySelector('#site-nav a').focus()`);await resize(390,844);
  assert.equal(await js(`document.activeElement.getAttribute('href')`),'#product','Resize never hides/blurs navigation');
  await js(`document.querySelector('#site-nav a[href="#product"]').click()`);
  assert.equal(await js(`location.hash`),'#product');assert.equal(await js(`document.activeElement.closest('#product')!==null`),true);
  await resize(1440);await js(`document.getElementById('main').focus({preventScroll:true})`);
  for(const id of ['records-story','regular-story','budget-story','picture-story','privacy','product','budget-story','records-story']) {
    await js(`document.getElementById('${id}').scrollIntoView({block:'start'})`);await frames();
    assert.equal(await js(`document.activeElement.id`),'main');
    assert.ok(await js(`(()=>{const r=document.getElementById('${id}').querySelector('h2').getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()`),id+' static chapter anchor');
  }
  await js(`document.querySelector('.site-footer a[href="#ai-sharing"]').click()`);
  assert.equal(await js(`document.activeElement.closest('#ai-sharing')!==null`),true);
  assert.equal(await js(`[...document.querySelectorAll('a[href^="#"]')].every(e=>!e.hash||!!document.getElementById(e.hash.slice(1)))`),true);
  // Enter from outside: coasting cannot pin either records or Keep debt in view.
  for(const name of ['records','picture']) {
    const wheel=deltaY=>cmd('Input.dispatchMouseEvent',{type:'mouseWheel',x:500,y:500,deltaX:0,deltaY});
    const at=scene=>waitFor(`document.querySelector('[data-story="${name}"]').dataset.scene==='${scene}'&&document.querySelector('[data-story="${name}"]').dataset.animating==='false'`);
    const start=await js(`(()=>{const e=document.querySelector('[data-story="${name}"]');return e.getBoundingClientRect().top+scrollY-document.querySelector('header').getBoundingClientRect().height})()`);
    await js(`scrollTo(0,${start-30})`);await frames();await settled();
    await wheel(40);
    for(let i=0;i<16;i++){await new Promise(resolve=>setTimeout(resolve,60));await wheel(.5);}
    assert.equal(await js(`document.querySelector('[data-story="${name}"]').dataset.scene`),'0','Entry momentum cannot skip the first panel');
    for(const delta of [1,2,3,4,5,6,7,8]){await new Promise(resolve=>setTimeout(resolve,16));await wheel(delta);}
    // Continued acceleration/plateau beyond the fade is still the same gesture.
    for(let i=0;i<12;i++){await new Promise(resolve=>setTimeout(resolve,60));await wheel(8+i);}
    await at(1);
    for(const delta of [16,12,8,4,2,1,.5,1,.5,1,.5]){await new Promise(resolve=>setTimeout(resolve,60));await wheel(delta);}
    assert.equal(await js(`document.querySelector('[data-story="${name}"]').dataset.scene`),'1','Decaying and tiny jittering tails cannot skip panels');
    const heldY=await js('scrollY');
    await wheel(8);
    if(name==='records') {
      await at(2);await wheel(-8);await at(1);
      for(const scene of [2,3]) {await wheel(8);await at(scene);}
      const lastPanelY=await js('scrollY');await wheel(8);await frames();
      assert.ok(await js('scrollY')>lastPanelY,'Fresh input exits the last records panel');
    } else {
      await frames();assert.ok(await js('scrollY')>heldY,'Fresh input exits the final debt/cover panel');
    }
  }
  // Native wheel bursts must advance only one adjacent panel in each enhanced sequence.
  for(const name of ['records','regular','budget','picture','wealth','privacy']) {
    const start=await js(`(()=>{const e=document.querySelector('[data-story="${name}"]');return e.getBoundingClientRect().top+scrollY-document.querySelector('header').getBoundingClientRect().height})()`);
    await js(`scrollTo(0,${start+2})`);await frames();await settled();
    await cmd('Input.dispatchMouseEvent',{type:'mouseWheel',x:500,y:500,deltaX:0,deltaY:9000});
    await waitFor(`document.querySelector('[data-story="${name}"]').dataset.animating==='true'`);
    const held=await js('scrollY');
    await cmd('Input.dispatchMouseEvent',{type:'mouseWheel',x:500,y:500,deltaX:0,deltaY:9000});
    assert.equal(await js('scrollY'),held,'Hold during600ms');await settled();
    assert.equal(await js(`document.querySelector('[data-story="${name}"]').dataset.scene`),'1','No fast-scroll panel skipping');
  }
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});await frames();
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38,autoRepeat:true});await settled();
  assert.equal(await js(`document.querySelector('[data-story="privacy"]').dataset.scene`),'0','Reverse key is adjacent, held key does not skip');
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  const released=await js('scrollY');
  await cmd('Input.dispatchMouseEvent',{type:'mouseWheel',x:500,y:500,deltaX:0,deltaY:300});await frames();
  assert.ok(await js('scrollY')>released,'Escape releases section pacing');
  await js(`document.querySelector('#site-nav a[href="#product"]').click()`);await frames();
  assert.equal(await js('location.hash'),'#product','Explicit navigation escapes paced sections');
  // Keep representative partial/settled opaque-blend and fixed-anchor checks.
  await js(`document.getElementById('main').focus({preventScroll:true})`);
  for(const [name,index] of [['records',2],['budget',0]]) {
    const g=await js(`(()=>{const e=document.querySelector('[data-story="${name}"]');return {start:e.getBoundingClientRect().top+scrollY-document.querySelector('header').getBoundingClientRect().height,travel:e.offsetHeight-e.querySelector('.story-stage').offsetHeight,count:e.querySelectorAll('.scene-list > .scene').length}})()`);
    await js(`scrollTo(0,${g.start+g.travel*(index+.1)/g.count})`);await frames();await settled();
    const before=await js(`(()=>{const r=document.querySelector('[data-story="${name}"] .shared-phone').getBoundingClientRect();return [r.x,r.y]})()`);
    await js(`scrollTo(0,${g.start+g.travel*(index+.8)/g.count})`);await frames();
    await waitFor(`document.querySelector('[data-story="${name}"]').dataset.animating==='true'`);
    await js(`new Promise(done=>setTimeout(done,200))`);
    const partial=await js(`(()=>{const e=document.querySelector('[data-story="${name}"]'),p=e.querySelector('.shared-phone'),a=[...p.children].map(n=>Number(n.style.opacity)),w=a.map((n,i)=>n*a.slice(i+1).reduce((v,x)=>v*(1-x),1)),r=p.getBoundingClientRect();return {weights:w,anchor:[r.x,r.y],words:[...e.querySelectorAll('.scene-list .scene-copy')].map(n=>Number(n.style.opacity))}})()`);
    assert.ok(partial.weights[index]>.1&&partial.weights[index]<.9&&partial.weights[index+1]>.1);
    assert.ok(Math.abs(partial.weights.reduce((a,b)=>a+b,0)-1)<.0001,'No brightness dip');
    assert.ok(partial.words.filter(n=>n>.01).length<=1);partial.anchor.forEach((n,i)=>assert.ok(Math.abs(n-before[i])<1.5));
    assert.equal(await js(`document.activeElement.id`),'main');await shot?.('full-'+name+'-fade');await settled();
    assert.equal(await js(`document.querySelector('[data-story="${name}"]').dataset.scene`),String(index+1));
    await shot?.('full-'+name+'-settled');
  }
  results.push('PASS 320/390/768/1024/1440reflow/16pxcopy/44pxtargets/readable native frames; visible navigation/skip/focus/static chapter anchors;600msmultiple-instance partial+settled fades/opaque blend/no passive focus changes');
  await resize(900,700);await frames();
  assert.equal(await js(`[...document.querySelectorAll('.scroll-story.is-pinned')].every(e=>Math.max(...[...e.querySelectorAll('.scene-list .scene-copy')].map(c=>c.getBoundingClientRect().height))<=innerHeight-document.querySelector('header').getBoundingClientRect().height-47)`),true,'No clipped enhanced copy; fit fallback');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await frames();
  assert.equal(await js(`document.querySelectorAll('.scroll-story.is-pinned').length`),0);
  assert.equal(await js(`getComputedStyle(document.querySelector('.button')).transitionDuration`),'0s');
  assert.equal(await js(`[...document.querySelectorAll('.scene-copy,.scene > figure,.feature-gallery > figure')].every(e=>getComputedStyle(e).animationName==='none'&&getComputedStyle(e).opacity==='1')`),true,'Reduced motion leaves every mobile scene static and visible');
  const ratios=await js(`(()=>{const rgb=v=>v.slice(v.indexOf('(')+1,-1).split(',').map(Number),lum=a=>a.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);return ['.hero-description','.no-account','.button-primary','.hero-actions .button-secondary','.scene-copy > p','.chapter-intro h2','.feature-gallery figcaption','#privacy .scene-copy h3','.footer-heading','.site-nav a','.site-footer a'].map(selector=>{let e=document.querySelector(selector),p=e,bg;while(p){const c=rgb(getComputedStyle(p).backgroundColor);if(c.length<4||c[3]===1){bg=c;break}p=p.parentElement}const a=lum(rgb(getComputedStyle(e).color)),b=lum(bg||[7,12,32]);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}})})()`);
  ratios.forEach(e=>assert.ok(e.ratio>=4.5,e.selector+' contrast '+e.ratio));
  await resize(720,500);await js(`document.querySelector('.hero-description').style.fontSize='40px'`);
  assert.ok(await js(`document.documentElement.scrollWidth<=720`));await js(`document.querySelector('.hero-description').removeAttribute('style')`);
  await cmd('Emulation.setEmulatedMedia',{features:[]});await resize(1440);await cmd('Page.navigate',{url:baseUrl});
  await waitFor(`!!document.querySelector('.site-header.has-js')`);
  // Reload restores lazy loading; preload the complete inventory again for the visual review.
  await js(`document.querySelectorAll('img').forEach(e=>e.loading='eager')`);
  await waitFor(`[...document.images].every(e=>e.complete&&e.naturalWidth>0)`);
  for(const type of ['keyDown','keyUp'])await cmd('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await js(`document.activeElement.className`),'skip-link');
  for(const type of ['keyDown','keyUp'])await cmd('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await js(`document.activeElement.id`),'main');
  assert.deepEqual(await js(`window.previewViolations||[]`),[]);assert.equal(await js(`localStorage.length+sessionStorage.length`),0);
  assert.ok(await js(`performance.getEntriesByType('resource').every(e=>e.name.startsWith(${JSON.stringify(baseUrl)})&&!['fetch','xmlhttprequest','beacon'].includes(e.initiatorType))`));
  await js(`scrollTo(0,0)`);await shot?.('desktop');await resize(390,844);await js(`scrollTo(0,0)`);await shot?.('mobile');
  await js(`document.getElementById('product').scrollIntoView()`);await shot?.('mobile-walkthrough');
  for(const id of ['budget-story','picture-story','privacy']) {
    await js(`document.getElementById('${id}').scrollIntoView()`);await waitFor(`[...document.images].every(e=>e.complete&&e.naturalWidth>0)`);await shot?.('mobile-'+id);
  }
  assert.equal(await js(`[...document.querySelectorAll('.native-visual img')].every(e=>e.currentSrc.includes('-mobile.png')&&e.naturalWidth===1260)`),true,'Native mobile crops, not tiny desktop charts');
  await resize(1440);await settled();
  for(const name of ['budget','wealth','privacy']) {
    await js(`(()=>{const e=document.querySelector('[data-story="${name}"]');scrollTo(0,e.getBoundingClientRect().top+scrollY-document.querySelector('header').getBoundingClientRect().height+2)})()`);await settled();await waitFor(`[...document.images].every(e=>e.complete&&e.naturalWidth>0)`);await shot?.('review-'+name+'-left');
  }
  await js(`document.querySelector('#product').scrollIntoView()`);await shot?.('review-product');
  await resize(390,844);
  const noObserver=await cmd('Page.addScriptToEvaluateOnNewDocument',{source:'delete window.IntersectionObserver'});
  await cmd('Page.navigate',{url:baseUrl});await waitFor(`!!document.querySelector('.site-header.has-js')`);
  assert.equal(await js(`[...document.querySelectorAll('.scene-copy,.scene > figure,.feature-gallery > figure')].every(e=>getComputedStyle(e).opacity==='1'&&getComputedStyle(e).animationName==='none')`),true,'Unsupported observation leaves all content visible');
  await cmd('Page.removeScriptToEvaluateOnNewDocument',{identifier:noObserver.result.identifier});
  await cmd('Emulation.setScriptExecutionDisabled',{value:true});await cmd('Page.navigate',{url:baseUrl});await waitFor(`document.querySelectorAll('[data-feature]').length===20`);
  assert.equal(await js(`!!document.querySelector('.shared-phone')`),false);
  assert.equal(await js(`[...document.querySelectorAll('.scene-copy,.scene .phone,#site-nav a')].every(e=>e.getBoundingClientRect().height>0)`),true);
  await cmd('Emulation.setScriptExecutionDisabled',{value:false});
  results.push('PASS adjacent wheel pacing across all six sequences, trackpad entry/coasting/gradual1–8px+abrupt8pxrenewal/continuing-acceleration+jitter-no-skip/reversal/section exit in records+debt; keyboard reverse/repeat/escape and direct navigation; mobile entry motion/native scrolling,11contrast pairs>=4.5, copy-fit/reduced/short/enlarged/no-JS/unsupported-observer/static equivalents, mobile native chart crops, local-only/no API/storage/telemetry');
  return results.join('\n');
}

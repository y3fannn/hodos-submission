// One real Add journey with fictional PDF/text and a fake provider. No live secrets/data.
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { startChrome, startServer } from './browser-kit.mjs';
const started=new Date().toISOString(),server=await startServer({AUTH:'off'});let browser;
try {
 browser=await startChrome({width:420,height:900});const {js,cmd,waitFor}=browser;
 const pdf=await PDFDocument.create();pdf.addPage();const encoded=Buffer.from(await pdf.save()).toString('base64');
 await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`window.__calls=[];window.__reply={actions:[],text:'Which date is this charge? <b>Not markup</b>',complete:true};const nativeFetch=window.fetch;window.fetch=(url,options={})=>{const u=new URL(url,location.href);if(u.origin!==location.origin)throw Error('External fixture traffic blocked');if(u.pathname==='/api/ai/status')return Promise.resolve(new Response(JSON.stringify({configured:true,sign_in_required:false}),{headers:{'Content-Type':'application/json'}}));if(u.pathname==='/api/ai'){window.__calls.push(JSON.parse(options.body));return Promise.resolve(new Response(JSON.stringify({output:window.__reply}),{headers:{'Content-Type':'application/json'}}));}return nativeFetch(url,options);};`});
 await cmd('Page.navigate',{url:`${server.url}?demo=1#/add`});await waitFor("!!document.querySelector('form[data-door=upload]')");
 await js(`(async()=>{const A=await import('/js/features/accounts.js'),P=await import('/js/features/profile.js');window.__account=A.create({name:'Fictional MVP statement account',type:'bank',currency:P.base(),openedOn:'2020-01-01'});window.__currency=P.base();window.__before=(await import('/js/features/transactions.js')).all().length;})()`);
 const stage=async(name='fictional.pdf')=>js(`(()=>{const f=document.querySelector('form[data-door=upload]'),d=new DataTransfer();d.items.add(new File([${name.endsWith('.pdf')?`Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0))`:`'Fictional statement'`}],${JSON.stringify(name)}));f.elements.account.value=window.__account.id;f.elements.files.files=d.files;f.elements.files.dispatchEvent(new Event('change'));})()`);
 const start=async()=>{await js("window.__uploadPromise=document.querySelector('form[data-door=upload]').onsubmit({preventDefault(){}});void 0");await waitFor("document.querySelector('[role=dialog] h2')?.textContent==='Send files to AI?'");await js("document.querySelector('[data-modal-form]').onsubmit({preventDefault(){}})");};
 await stage();assert.equal(await js('window.__calls.length'),0,'staging cannot send');
 await js("(()=>{const f=document.querySelector('form[data-door=upload]'),d=new DataTransfer();d.items.add(new File(['second'],'second.txt'));f.elements.files.files=d.files;f.elements.files.dispatchEvent(new Event('change'));})()");
 assert.equal(await js("document.querySelector('[data-upload-error]').textContent.includes('one file')"),true);
 await start();await waitFor("document.querySelector('[role=dialog] h2')?.textContent==='About fictional.pdf'");
 assert.equal(await js("document.querySelector('[data-modal-form]').textContent.includes('Which date is this charge? <b>Not markup</b>')&&!document.querySelector('[data-modal-form] b')"),true,'question escaped and visible');
 await js("document.querySelector('[data-action=modal-cancel]').click();window.__uploadPromise");
 assert.equal(await js("import('/js/features/transactions.js').then(T=>T.all().length===window.__before)"),true);
 await js("window.__reply={actions:[{kind:'log_transaction',params:{kind:'expense',amount_text:'12.34',currency:window.__currency,date:'2026-10-14',merchant:'Fictional MVP cafe',category_name:'Unmatched statement category',account_name:'Do not substitute'}}],text:null,complete:true}");
 await stage();await start();await waitFor("!!document.querySelector('[data-modal-form] [name=amount]')");
 assert.equal(await js("document.querySelector('[data-modal-form]').elements.account_id.value===window.__account.id&&document.querySelector('[data-modal-form]').elements.category_id.value===''"),true,'exact account and unresolved category');
 await js("document.querySelector('[data-action=modal-cancel]').click();window.__uploadPromise");
 assert.equal(await js("import('/js/features/transactions.js').then(T=>T.all().length===window.__before)"),true,'cancel writes nothing');
 await stage();await start();await waitFor("!!document.querySelector('[data-modal-form] [name=amount]')");
 await js("(()=>{const f=document.querySelector('[data-modal-form]');f.elements.amount.value='13.45';f.elements.category_id.value=[...f.elements.category_id.options].find(o=>o.value)?.value||'';f.elements.category_id.dispatchEvent(new Event('change',{bubbles:true}));window.__oldSubmit=f.onsubmit;})()");
 await js("window.__oldSubmit({preventDefault(){}})");await js('window.__uploadPromise');
 assert.equal(await js("import('/js/features/transactions.js').then(T=>T.all().filter(t=>t.merchant==='Fictional MVP cafe').length===1&&T.all().find(t=>t.merchant==='Fictional MVP cafe').money.amount===1345)"),true,'corrected confirmation saves once');
 await js("window.__oldSubmit({preventDefault(){}})");
 await cmd('Page.reload');await waitFor("!!document.querySelector('form[data-door=upload]')");
 assert.equal(await js("import('/js/features/transactions.js').then(T=>T.all().filter(t=>t.merchant==='Fictional MVP cafe').length===1&&T.all().find(t=>t.merchant==='Fictional MVP cafe').money.amount===1345)"),true,'saved entry survives actual reload without duplicate');
 const adapter=await js(`(async()=>{const {prepareFiles}=await import('/js/features/assistant-files.js');let rejected=false;try{await prepareFiles([new File(['a'],'a.txt'),new File(['b'],'b.txt')],{callAI:()=>{throw Error('Provider must not run')}});}catch(e){rejected=e.message.includes('one file');}return rejected;})()`);assert.equal(adapter,true);
 assert.deepEqual(browser.problems(),[]);console.log(JSON.stringify({started,ended:new Date().toISOString(),singleFile:true,pdfClarification:true,escapedText:true,reviewCorrection:true,exactAccount:true,cancelNoWrite:true,confirmedOnce:true,reloaded:true}));
} finally {browser?.close();server.stop();}

// Assemble the existing Pages app unchanged, plus an allowlisted sample-only review page.
import { cp, mkdir, readdir, readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit owned-image inventory; never discover/copy arbitrary source or private material.
export const alexViews = Object.freeze([
  'home', 'records', 'record-before', 'correction-review', 'record-after', 'add-filled', 'assistant-records', 'salary-review', 'accounts',
  'account-detail', 'recurring', 'budgets', 'budget-safe', 'goals', 'debts',
  'debt-detail', 'insurance', 'investments', 'investment-detail', 'networth',
  'categories', 'alerts', 'settings', 'reconcile', 'fx', 'assistant'
]);
export const scrollViews = Object.freeze(['goals', 'budgets', 'budget-safe', 'assistant']);
export const nativeVisuals = Object.freeze(['goals','investments','networth','ai-badge','goals-mobile','investments-mobile','networth-mobile']);
export const previewFiles = Object.freeze([
  'index.html', 'styles.css', 'main.js', 'assets/hodos.svg', 'assets/guilloche.svg',
  ...alexViews.map(name => `assets/alex-${name}.png`),
  'scroll-preview.html', 'scroll-preview.css', 'scroll-preview.js', 'scroll-story.css',
  ...scrollViews.map(name => `assets/scroll-${name}.png`),
  ...nativeVisuals.map(name => `assets/native-${name}.png`)
]);
const productionExtras=['404.html','503.html','errors.css','robots.txt','sitemap.xml'];
export const landingFiles=Object.freeze([...previewFiles.filter(f=>!['scroll-preview.html','scroll-preview.css'].includes(f)),...productionExtras]);
const app = resolve(fileURLToPath(new URL('../webapp/public/', import.meta.url)));
const source = resolve(fileURLToPath(new URL('./', import.meta.url)));

export async function assemblePages(destination) {
  const output = resolve(destination);
  if ([app, source].some(directory => output === directory || output.startsWith(directory + sep))) {
    throw new Error('Pages output must be outside application and preview source directories');
  }
  // Never remove/overwrite an existing output directory, particularly a source checkout.
  await mkdir(output);
  for (const entry of await readdir(app)) {
    await cp(resolve(app, entry), resolve(output, entry), { recursive: true, errorOnExist: true, force: false });
  }
  for (const file of previewFiles) {
    const target = resolve(output, 'hodos-preview', file);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(new URL(file, import.meta.url), target, { errorOnExist: true, force: false });
  }
  await writeFile(resolve(output, '.nojekyll'), '');
  return output;
}

export async function assembleLanding(destination) {
  const output=resolve(destination), sourceReal=await realpath(source), appReal=await realpath(app);
  const parent=await realpath(dirname(output));
  if(output===sourceReal||output.startsWith(sourceReal+sep)||output===appReal||output.startsWith(appReal+sep)||parent===sourceReal||parent.startsWith(sourceReal+sep)||parent===appReal||parent.startsWith(appReal+sep)) throw new Error('Landing output must be outside source directories');
  await mkdir(output);
  try {
    for(const file of landingFiles){
      const src=resolve(source,file); const stat=await lstat(src); if(stat.isSymbolicLink()) throw new Error(`Source symlink rejected: ${file}`);
      const target=resolve(output,file); await mkdir(dirname(target),{recursive:true});
      if(file==='index.html'){
        let html=await readFile(src,'utf8');
        const old='<meta name="robots" content="noindex,nofollow">';
        if(html.split(old).length!==2||html.split('</head>').length!==2) throw new Error('Expected unique source index head');
        const head=html.slice(0,html.indexOf('</head>'));
        if(head.includes('rel="canonical"')) throw new Error('Unexpected source canonical');
        html=html.replace(old,'<meta name="robots" content="index,follow">').replace('</head>','<link rel="canonical" href="https://hodos.consulting/"></head>');
        await writeFile(target,html,{flag:'wx'});
      } else await cp(src,target,{errorOnExist:true,force:false});
    }
  } catch(error){ throw error; }
  return output;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2]==='--landing') { if(!process.argv[3]) throw new Error('Provide a new output directory'); await assembleLanding(process.argv[3]); }
  else { if (!process.argv[2]) throw new Error('Provide a new output directory'); await assemblePages(process.argv[2]); }
}

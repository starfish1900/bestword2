import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const source=dirname(fileURLToPath(import.meta.url));
const task=resolve(source,'../../../..');
const work=process.env.BESTWORD_TUTORIAL_WORK||join(task,'work/tutorial');
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const timeline=await json(join(work,'timeline.json'));
const examples=await json(join(source,'content/examples.json'));
const {assets}=await json(join(work,'capture/assets.json'));
const dest=join(work,'inspection');await mkdir(dest,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1080}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:4179',{waitUntil:'networkidle'});
await page.waitForFunction(()=>window.tutorialReady);
const records=[];
try {
 for(const scene of timeline.scenes){
  const asset=assets.find(a=>a.id===scene.asset);
  const visualAsset=asset?{...asset,type:'video',duration:asset.durationSeconds,url:'/@fs/'+resolve(work,'capture',asset.file||asset.path).replace(/\\/g,'/')}:undefined;
  for(const fraction of (scene.kind==='score'||scene.kind==='input'?[.08,.38,.82]:[.65])) {
   const t=scene.duration*fraction;
   await page.evaluate(async input=>window.renderFrame(input),{scene,example:examples.find(e=>e.id===scene.example),t,duration:scene.duration,progress:(scene.start+t)/timeline.duration,asset:visualAsset});
   const file=join(dest,`${scene.id}-${Math.round(fraction*100)}.png`);
   await page.screenshot({path:file});
   const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,text:document.body.innerText,overflows:Array.from(document.querySelectorAll('h1,h2,h3,p,.formula,.score-total')).filter(e=>e.scrollWidth>e.clientWidth+3||e.getBoundingClientRect().bottom>939).map(e=>({text:e.textContent,scroll:e.scrollWidth,width:e.clientWidth,bottom:e.getBoundingClientRect().bottom}))}));
   records.push({scene:scene.id,fraction,file,...layout});
  }
 }
} finally { await browser.close(); }
await writeFile(join(dest,'inspection.json'),JSON.stringify({errors,records},null,2));
console.log(JSON.stringify({frames:records.length,errors,overflow:records.filter(r=>r.overflows.length).map(r=>({id:r.scene,items:r.overflows}))},null,2));

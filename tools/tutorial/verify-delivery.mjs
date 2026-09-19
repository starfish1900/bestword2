/** Verify the offline player and regenerate captions from an extracted source package. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,symlink,stat} from 'node:fs/promises';
import {resolve,dirname,join,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const source=dirname(fileURLToPath(import.meta.url)),project=resolve(source,'../..'),task=resolve(project,'../..');
const work=process.env.BESTWORD_TUTORIAL_WORK||join(task,'work/tutorial');
const output=process.env.BESTWORD_TUTORIAL_OUTPUT||join(task,'outputs/bestword-tutorial');
const ffmpeg=process.env.FFMPEG_PATH||join(task,'work/tools/ffmpeg-9.0.1/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe');
const ffprobe=process.env.FFPROBE_PATH||join(dirname(ffmpeg),'ffprobe.exe');
const mode=process.argv[2]||'all';
assert(['viewer','portability','all'].includes(mode),'Choose viewer, portability or all.');
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const hash=data=>createHash('sha256').update(data).digest('hex');
const save=async(path,data)=>writeFile(path,JSON.stringify(data,null,2)+'\n');
const manifest=await json(join(output,'Scene-manifest.json'));
const evidenceDirectory=join(work,'delivery-check');await mkdir(evidenceDirectory,{recursive:true});

function run(command,args,{cwd=project,env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(Error(`${basename(command)} exited ${code}: ${stderr.slice(-6000)}`)));
  });
}

async function verifyViewer(){
  const errors=[],networkRequests=[],checks={};
  const report={createdAt:new Date().toISOString(),timelineCreatedAt:manifest.createdAt,kind:'Offline viewer check in owned headless Chromium',status:'running',humanAudioAudition:false,checks,errors,networkRequests};
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(!/^(file|data|blob):/.test(request.url()))networkRequests.push(request.url());});
    await page.goto(pathToFileURL(join(output,'Watch-BestWord.html')).href,{waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,{},{timeout:30000});
    const video=()=>page.evaluate(()=>{const video=document.querySelector('video');return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,paused:video.paused,currentTime:video.currentTime,currentSrc:video.currentSrc,autoplay:video.autoplay,readyState:video.readyState,error:video.error?{code:video.error.code,message:video.error.message}:null};});
    checks.initialMetadata=await video();
    assert.equal(checks.initialMetadata.error,null);assert.equal(checks.initialMetadata.width,1920);assert.equal(checks.initialMetadata.height,1080);
    assert(Math.abs(checks.initialMetadata.duration-manifest.duration)<.08,'Viewer video duration must match the current manifest.');
    await page.waitForTimeout(350);const idle=await video();
    checks.noAutoplay=idle.paused&&idle.currentTime===0&&!idle.autoplay;assert(checks.noAutoplay,'Viewer must not autoplay.');

    const linkUrls=await page.locator('a[href],source[src],video[poster]').evaluateAll(nodes=>nodes.flatMap(node=>[node.getAttribute('href'),node.getAttribute('src'),node.getAttribute('poster')].filter(Boolean)));
    checks.localLinks=[];
    for(const href of [...new Set(linkUrls)]){
      if(href.startsWith('#'))continue;
      const url=new URL(href,page.url());assert.equal(url.protocol,'file:','Viewer links must work locally.');
      const path=fileURLToPath(url),exists=await stat(path).then(s=>s.isFile(),()=>false);checks.localLinks.push({file:basename(path),exists});
      assert(exists,`Missing viewer resource: ${path}`);
    }
    const expectedChapters=manifest.scenes.filter((scene,index,scenes)=>scenes.findIndex(item=>item.chapter===scene.chapter)===index);
    const buttons=await page.locator('.chapter').evaluateAll(nodes=>nodes.map(node=>({time:Number(node.dataset.time),label:node.textContent.trim(),tag:node.tagName,tabIndex:node.tabIndex,disabled:node.disabled})));
    assert.deepEqual(buttons.map(button=>button.time),expectedChapters.map(scene=>scene.start));
    assert(buttons.every(button=>button.label&&button.tag==='BUTTON'&&button.tabIndex>=0&&!button.disabled));
    checks.accessibleChapterButtons=true;checks.chapters=[];
    for(let index=0;index<buttons.length;index++){
      if(index===1)await page.locator('video').evaluate(video=>video.play());
      await page.locator('.chapter').nth(index).click();
      await page.waitForFunction(time=>{const video=document.querySelector('video');return video.paused&&Math.abs(video.currentTime-time)<.1;},buttons[index].time);
      await page.waitForFunction(index=>document.querySelectorAll('.chapter')[index].getAttribute('aria-current')==='true',index);
      const selected=await video();checks.chapters.push({label:buttons[index].label,expected:buttons[index].time,time:selected.currentTime,paused:selected.paused});
    }
    await page.locator('.chapter').first().focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('video').currentTime<.1&&document.querySelector('video').paused);
    checks.keyboardChapterActivation=true;
    const scoring=expectedChapters.find(scene=>scene.chapter==='scoring');assert(scoring);
    await page.locator(`.chapter[data-time="${scoring.start}"]`).click();
    const savedTime=(await video()).currentTime;
    await page.getByRole('button',{name:'Without captions',exact:true}).click();
    await page.waitForFunction(time=>{const video=document.querySelector('video');return video.currentSrc.endsWith('BestWord-Tutorial-Clean.mp4')&&video.readyState>=2&&video.paused&&Math.abs(video.currentTime-time)<.1;},savedTime,{timeout:30000});
    checks.cleanVersion=await video();
    assert(Math.abs(checks.cleanVersion.duration-manifest.duration)<.08);
    assert.equal(await page.getByRole('button',{name:'Without captions',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'With captions',exact:true}).click();
    await page.waitForFunction(time=>{const video=document.querySelector('video');return video.currentSrc.endsWith('BestWord-Tutorial.mp4')&&video.readyState>=2&&video.paused&&Math.abs(video.currentTime-time)<.1;},savedTime,{timeout:30000});
    checks.returnedCaptionedVersion=await video();checks.pausedVersionSwitchRetainsPosition=true;
    await page.waitForFunction(time=>document.querySelector(`.chapter[data-time="${time}"]`).getAttribute('aria-current')==='true',scoring.start);
    checks.responsiveLayout=[];
    for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:640}]){
      await page.setViewportSize(viewport);await page.evaluate(()=>scrollTo(0,0));
      const layout=await page.evaluate(()=>{const video=document.querySelector('video').getBoundingClientRect();const buttons=[...document.querySelectorAll('button')].map(button=>{const rect=button.getBoundingClientRect();return {label:button.textContent.trim(),left:rect.left,right:rect.right,width:rect.width,height:rect.height};});return {viewportWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,videoWidth:video.width,videoHeight:video.height,buttons};});
      assert(layout.scrollWidth<=viewport.width+1,'Viewer must not scroll horizontally.');
      assert(layout.videoWidth>0&&layout.videoWidth<=viewport.width&&Math.abs(layout.videoWidth/layout.videoHeight-16/9)<.01);
      assert(layout.buttons.every(button=>button.height>=44&&button.left>=-1&&button.right<=viewport.width+1),'Buttons must fit and retain usable touch targets.');
      await page.screenshot({path:join(evidenceDirectory,`viewer-${viewport.width}.png`),fullPage:true});checks.responsiveLayout.push(layout);
    }
    assert.equal(errors.length,0);assert.equal(networkRequests.length,0);report.status='passed';
  }catch(error){errors.push(error.message);report.status='failed';throw error;}
  finally{await browser.close();await save(join(output,'Viewer-verification.json'),report);}
  console.log(JSON.stringify({viewer:'passed',duration:checks.initialMetadata.duration,chapters:checks.chapters.length,layouts:checks.responsiveLayout.length}));
}

async function verifyPortability(){
  const archive=join(output,'BestWord-Tutorial-Source.zip');
  const extracted=await mkdtemp(join(work,'portable-verify-'));
  const extractionScript=String.raw`
from pathlib import Path
import hashlib, json, stat, sys, zipfile
archive, destination = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None, 'ZIP integrity failed'
    entries = bundle.infolist()
    for item in entries:
        target = (destination / item.filename).resolve()
        assert target == destination or destination in target.parents, 'Archive path escapes destination'
        assert not stat.S_ISLNK(item.external_attr >> 16), 'Archive contains a symlink'
    manifest = json.loads(bundle.read('Source-package-manifest.json'))
    for item in manifest['files']:
        data = bundle.read(item['file'])
        assert len(data) == item['bytes'], 'Manifest byte count differs'
        assert hashlib.sha256(data).hexdigest() == item['sha256'], 'Manifest hash differs'
    bundle.extractall(destination)
print(json.dumps({'files':len(entries),'manifestFiles':len(manifest['files']),'zipIntegrity':'passed','manifestHashes':'passed'}))
`;
  const extractedChecks=JSON.parse(await run(process.env.PYTHON_PATH||'python',['-c',extractionScript,archive,extracted]));
  const extractedProject=join(extracted,'bestword'),extractedWork=join(extracted,'work/tutorial'),extractedOutput=join(extracted,'exports');
  const required=['package-lock.json','apps/web/src/AnimatedScore.tsx','apps/web/src/scoreCounter.ts','apps/web/src/scoreCounter.test.ts','apps/web/src/Game.tsx','apps/web/src/components.tsx','apps/web/src/styles.css','packages/engine/src/index.ts','tools/tutorial/verify-delivery.mjs','tools/tutorial/content/scenes.json','tools/tutorial/content/viewer.template.html'];
  const sourceFiles=[];
  for(const file of required){
    const actual=await readFile(join(extractedProject,file)),original=await readFile(join(project,file));
    assert(actual.equals(original),`Packaged application source differs: ${file}`);sourceFiles.push({file,sha256:hash(actual),identical:true});
  }
  await symlink(join(project,'node_modules'),join(extractedProject,'node_modules'),process.platform==='win32'?'junction':'dir');
  const preparation=await run(process.execPath,[join(extractedProject,'tools/tutorial/pipeline.mjs'),'prepare'],{cwd:extractedProject,env:{...process.env,BESTWORD_TUTORIAL_WORK:extractedWork,BESTWORD_TUTORIAL_OUTPUT:extractedOutput,FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe}});
  const regenerated=await json(join(extractedOutput,'Scene-manifest.json'));
  const canonical=({createdAt,...rest})=>rest;
  assert.deepEqual(canonical(regenerated),canonical(manifest),'Regenerated timeline must match every scene, cue and caption.');
  const captions=[];
  for(const file of ['BestWord-Tutorial.srt','BestWord-Tutorial.vtt']){
    const actual=await readFile(join(extractedOutput,file)),original=await readFile(join(output,file));
    assert(actual.equals(original),`Regenerated ${file} is not byte-identical.`);captions.push({file,sha256:hash(actual),identical:true});
  }
  const packageManifest=await json(join(extracted,'Source-package-manifest.json'));
  const inputManifest=packageManifest.files.filter(item=>item.file.startsWith('bestword/')||item.file.startsWith('work/tutorial/audio/'));
  const report={checkedAt:new Date().toISOString(),timelineCreatedAt:manifest.createdAt,status:'passed',method:'Extracted source archive into a fresh directory; verified every archived manifest hash and current application additions; regenerated timeline and captions using the existing installed locked dependency runtime.',duration:regenerated.duration,spokenWords:regenerated.wordCount,sceneCount:regenerated.scenes.length,captionCount:regenerated.captions.length,captions,timelineExactExceptCreationTime:true,requiredSourceFiles:sourceFiles,sourceInputsSha256:hash(JSON.stringify(inputManifest)),archiveTestedSha256:hash(await readFile(archive)),archiveEvidenceNote:'The archive may be repackaged to include this report. The sourceInputsSha256 identifies the exact application and narration inputs verified independently of report-only repackaging.',extractedDirectory:extracted,dependencies:{method:'Local node_modules junction; package-lock.json is byte-identical.',node:process.version,path:join(project,'node_modules')},extraction:extractedChecks,prepareOutput:preparation.trim()};
  await save(join(output,'Portability-verification.json'),report);
  console.log(JSON.stringify({portability:'passed',duration:report.duration,spokenWords:report.spokenWords,captions:report.captionCount,requiredSourceFiles:sourceFiles.length,extracted}));
}

if(mode==='viewer'||mode==='all')await verifyViewer();
if(mode==='portability'||mode==='all'){
  try{await verifyPortability();}
  catch(error){await save(join(output,'Portability-verification.json'),{checkedAt:new Date().toISOString(),timelineCreatedAt:manifest.createdAt,status:'failed',error:error.message});throw error;}
}

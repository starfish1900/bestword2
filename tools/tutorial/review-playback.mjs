import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const source=dirname(fileURLToPath(import.meta.url)),task=resolve(source,'../../../..');
const work=process.env.BESTWORD_TUTORIAL_WORK||join(task,'work/tutorial');
const output=process.env.BESTWORD_TUTORIAL_OUTPUT||join(task,'outputs/bestword-tutorial');
const timeline=JSON.parse(await readFile(join(work,'timeline.json'),'utf8'));
const directory=join(work,'final-review');await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1920,height:1080}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const url='http://127.0.0.1:4179/@fs/'+join(output,'BestWord-Tutorial.mp4').replace(/\\/g,'/');
await page.goto('http://127.0.0.1:4179');
await page.setContent('<html><style>html,body{margin:0;background:#142b3b}video{display:block;width:1920px;height:1080px;object-fit:contain}</style><video preload="auto" playsinline></video></html>');
await page.evaluate(async url=>{
  const video=document.querySelector('video');window.reviewEvents=[];
  for(const type of ['loadedmetadata','canplay','playing','waiting','stalled','seeking','seeked','error','ended'])video.addEventListener(type,()=>window.reviewEvents.push({type,at:video.currentTime,wall:performance.now()}));
  video.src=url;video.playbackRate=1;video.muted=false;video.volume=1;await video.play();
},url);
const started=Date.now(),frames=[],captured=new Set();
const targets=timeline.scenes.flatMap(scene=>(scene.kind==='score'?[.12,.45,.8]:[.7]).map(f=>({id:scene.id,at:scene.start+scene.duration*f,fraction:f})));
let completed=false,lastChapter='';
try{
 while(Date.now()-started<(timeline.duration+45)*1000){
  const state=await page.evaluate(()=>{const v=document.querySelector('video');const q=v.getVideoPlaybackQuality();return{time:v.currentTime,duration:v.duration,paused:v.paused,ended:v.ended,rate:v.playbackRate,error:v.error?{code:v.error.code,message:v.error.message}:null,ready:v.readyState,decodedAudioBytes:v.webkitAudioDecodedByteCount,totalFrames:q.totalVideoFrames,droppedFrames:q.droppedVideoFrames};});
  if(state.error)throw Error(JSON.stringify(state.error));
  if(state.rate!==1||errors.length)throw Error('Playback rate changed or a browser error occurred.');
  const chapter=timeline.scenes.find(s=>state.time>=s.start&&state.time<s.start+s.duration)?.chapter;
  if(chapter&&chapter!==lastChapter){console.log(`Normal-speed playback: ${chapter} at ${state.time.toFixed(1)}s`);lastChapter=chapter;}
  for(let i=0;i<targets.length;i++)if(!captured.has(i)&&state.time>=targets[i].at){
   const path=join(directory,`${targets[i].id}-${Math.round(targets[i].fraction*100)}.png`);
   await page.screenshot({path});frames.push({...targets[i],capturedAt:state.time,file:path});captured.add(i);
  }
  if(state.ended){completed=true;const result={checkedAt:new Date().toISOString(),method:'Entire captioned export played in Chromium at 1x without seeking; audio stream decoded; scene frames retained for visual review.',subjectiveAudioListening:'Not performed: this agent has no audio-listening input channel. Pronunciation remains available for human review.',wallSeconds:(Date.now()-started)/1000,...state,errors,events:await page.evaluate(()=>window.reviewEvents),frames};await writeFile(join(output,'Browser-playback-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({completed,seconds:state.time,frames:state.totalFrames,dropped:state.droppedFrames,reviewFrames:frames.length}));break;}
  await page.waitForTimeout(250);
 }
 if(!completed)throw Error('Normal-speed playback did not finish within timeout.');
}finally{await browser.close();}

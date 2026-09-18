import { readFile, writeFile, mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const source=dirname(fileURLToPath(import.meta.url));
const project=resolve(source,'../..');
const task=resolve(project,'../..');
const work=process.env.BESTWORD_TUTORIAL_WORK||join(task,'work/tutorial');
const output=process.env.BESTWORD_TUTORIAL_OUTPUT||join(task,'outputs/bestword-tutorial');
const ffmpeg=process.env.FFMPEG_PATH||join(task,'work/tools/ffmpeg-9.0.1/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe');
const ffprobe=process.env.FFPROBE_PATH||join(dirname(ffmpeg),'ffprobe.exe');
const fps=30;
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');};
function run(command,args,{cwd=project,quiet=true}={}) {
  return new Promise((res,rej)=>{
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',b=>{stdout+=b;if(!quiet)process.stdout.write(b);});
    child.stderr.on('data',b=>{stderr+=b;if(!quiet)process.stderr.write(b);});
    child.on('error',rej);child.on('close',code=>code===0?res({stdout,stderr}):rej(Error(`${basename(command)} exited ${code}: ${stderr.slice(-5000)}`)));
  });
}
async function probe(file){return JSON.parse((await run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file])).stdout);}
const assTime=value=>{const n=Math.round(value*100),cs=n%100,s=Math.floor(n/100)%60,m=Math.floor(n/6000)%60,h=Math.floor(n/360000);return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;};
const subtitleTime=value=>{const n=Math.round(value*1000),ms=n%1000,s=Math.floor(n/1000)%60,m=Math.floor(n/60000)%60,h=Math.floor(n/3600000);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;};
function wrap(text){
  const words=text.trim().split(/\s+/);let left='',right='';
  const half=Math.ceil(text.length/2);
  for(const word of words){if((left+' '+word).trim().length<=Math.max(half,38)&&!right)left=(left+' '+word).trim();else right=(right+' '+word).trim();}
  return right?`${left}\n${right}`:left;
}
function captionChunks(record,audioDuration){
  const words=record.words;const chunks=[];let start=0;
  while(start<words.length){
    let end=start;
    while(end+1<words.length){
      const text=record.text.slice(words[start].character,words[end+1].character+words[end+1].length);
      if(text.length>78||((words[end+1].atMs-words[start].atMs)>5400&&end>start+3))break;
      end++;
      const nextChar=end+1<words.length?words[end+1].character:record.text.length;
      if(/[.!?][\s]*$/.test(record.text.slice(words[end].character,nextChar))&&end-start>=3)break;
    }
    const endChar=end+1<words.length?words[end+1].character:record.text.length;
    const text=record.text.slice(words[start].character,endChar).trim();
    chunks.push({start:words[start].atMs/1000,end:end+1<words.length?words[end+1].atMs/1000-.02:audioDuration-.08,text:wrap(text)});
    start=end+1;
  }
  return chunks;
}

function visualCues(scene,record,lead,duration){
  const at=(phrase,offset=0)=>{
    const index=record.text.toLowerCase().indexOf(phrase.toLowerCase());
    if(index<0)throw Error(`Missing cue phrase ${scene.id}: ${phrase}`);
    const word=record.words.find(w=>w.character+w.length>index);
    if(!word)throw Error(`Missing cue word ${scene.id}: ${phrase}`);
    return lead+word.atMs/1000+offset;
  };
  const cues=(placedAt,pillarsAt,spansAt,calculationsAt,focusAt,totalAt)=>({placedAt,pillarsAt,spansAt,calculationsAt,focusAt,totalAt});
  switch(scene.id){
    case 'score-boomerangs':return {visualCues:cues(at('into'),at('existing letters'),at('no spans'),[at('Thirty-one times')],[0],at('one hundred'))};
    case 'score-bridge-definition':return {visualCues:cues(at('One or more'),at('first and last'),at('Each previously'),[duration+1],[0],duration+1)};
    case 'score-roommate':return {visualCues:cues(.8,at('B2'),at('B3'),[at('Twenty-one')],[0],at('one hundred'))};
    case 'score-boomerang':return {visualCues:cues(at('adding'),at('two spans'),at('two spans'),[at('Twenty-nine'),at('Double')],[0,at('The E')],at('Total'))};
    case 'score-sos':return {visualCues:cues(.8,at('None'),at('None'),[at('five times'),at('seventeen'),at('fifteen')],[0,at('seventeen'),at('fifteen')],at('Together'))};
    case 'score-anopias':return {visualCues:cues(at('place'),at('only one'),at('no spans'),[at('Seventeen'),duration+1,duration+1,duration+1,duration+1,duration+1,duration+1],[0,at('But all')],duration+1)};
    case 'score-anopias-detail':{
      const names=['HAY','ING,','ZOA','GIO','NAP','ASH'];const times=names.map(name=>at(name));
      return {visualCues:cues(0,0,0,[0,...times],[0,...times],at('one hundred seventy-one'))};
    }
    case 'masterpiece':return {inputCues:{clickAt:at('Click'),typeEAt:at('E and'),typeRAt:at('R.'),submitAt:at('submitting')}};
    default:return {};
  }
}

async function prepare(){
  await mkdir(output,{recursive:true});await mkdir(join(work,'render'),{recursive:true});
  const scenes=await json(join(source,'content/scenes.json'));let cursor=0;const captions=[];
  const timeline=[];
  for(const scene of scenes){
    const audioFile=join(work,'audio',scene.id+'.wav'),record=await json(join(work,'audio',scene.id+'.json'));
    if(record.text!==scene.narration)throw Error(`Narration stale for ${scene.id}`);
    const audio=await probe(audioFile),audioDuration=Number(audio.format.duration);
    const lead=.6,hold=scene.kind==='score'?1.5:.7;
    const duration=Math.ceil(Math.max(scene.minDuration||0,audioDuration+lead+hold)*fps)/fps;
    const footageOverrides={join:'onboarding',replay:'review'};
    const item={...scene,...(footageOverrides[scene.id]?{asset:footageOverrides[scene.id]}:{}),...visualCues(scene,record,lead,duration),start:cursor,duration,audioDuration,audioLead:lead,audioFile,frames:Math.round(duration*fps)};
    timeline.push(item);
    for(const caption of captionChunks(record,audioDuration))captions.push({...caption,start:cursor+lead+caption.start,end:cursor+lead+caption.end,scene:scene.id});
    cursor+=duration;
  }
  if(cursor>480)throw Error(`Narration and scenes take ${cursor.toFixed(2)}s, over the 480s maximum. Revise pace or script.`);
  if(cursor<420){
    // Retain deliberate reading time on diagrams and the reference chart, not empty title padding.
    const holds=timeline.filter(s=>s.kind==='score'||s.id==='letter-reference');
    const each=Math.ceil((420-cursor)/holds.length*fps)/fps;
    let offset=0;
    for(const scene of timeline){
      scene.start+=offset;
      for(const caption of captions.filter(c=>c.scene===scene.id)){caption.start+=offset;caption.end+=offset;}
      if(holds.includes(scene)){scene.duration+=each;scene.frames=Math.round(scene.duration*fps);offset+=each;}
    }
    cursor+=offset;
  }
  const manifest={title:'BestWord — Learn to play',createdAt:new Date().toISOString(),voice:'Microsoft Zira Desktop',fps,width:1920,height:1080,duration:cursor,wordCount:scenes.reduce((n,s)=>n+s.narration.trim().split(/\s+/).length,0),scenes:timeline,captions};
  await save(join(work,'timeline.json'),manifest);
  const srt=captions.map((c,i)=>`${i+1}\n${subtitleTime(c.start)} --> ${subtitleTime(c.end)}\n${c.text}\n`).join('\n');
  const vtt='WEBVTT\n\n'+captions.map(c=>`${subtitleTime(c.start).replace(',','.')} --> ${subtitleTime(c.end).replace(',','.')}\n${c.text}\n`).join('\n');
  await writeFile(join(output,'BestWord-Tutorial.srt'),srt);
  await writeFile(join(output,'BestWord-Tutorial.vtt'),vtt);
  const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Segoe UI,40,&H003B2B14,&H003B2B14,&H00E6F0F4,&H90000000,0,0,0,0,100,100,0,0,1,0.6,0,2,130,130,38,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`+captions.map(c=>`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\n/g,'\\N').replace(/[{}]/g,'')}`).join('\n')+'\n';
  await writeFile(join(work,'render/captions.ass'),ass);
  const chapters=[];for(const scene of timeline)if(!chapters.some(c=>c.id===scene.chapter))chapters.push({id:scene.chapter,at:scene.start,title:({starting:'Welcome',setup:'Starting a game',letters:'Letters and automatic draws',legality:'Legal words',input:'Entering moves',scoring:'Scoring and bridges',actions:'NO WORDS, PASS and finishing',clocks:'Clocks and reconnection',watch:'Spectators and replay'})[scene.chapter]||scene.chapter});
  await writeFile(join(output,'Chapters.txt'),chapters.map(c=>`${subtitleTime(c.at).slice(3,8)} ${c.title}`).join('\n')+'\n');
  await save(join(output,'Scene-manifest.json'),{...manifest,scenes:timeline.map(({audioFile,...s})=>({...s,audioFile:`narration/${s.id}.wav`}))});
  console.log(JSON.stringify({duration:cursor,scenes:timeline.length,captions:captions.length,words:manifest.wordCount}));
}

async function render(){
  const manifest=await json(join(work,'timeline.json')),examples=await json(join(source,'content/examples.json'));
  const assetFile=join(work,'capture/assets.json');let assetData=await json(assetFile);const assets=Array.isArray(assetData)?assetData:assetData.assets;
  const selected=(process.env.SCENES||'').split(',').filter(Boolean);const scenes=manifest.scenes.filter(s=>!selected.length||selected.includes(s.id));
  const visualSource=await Promise.all(['main.tsx','style.css','types.ts'].map(name=>readFile(join(source,'visual',name))));
  const browser=await chromium.launch({headless:true});
  let index=0,done=0;
  const errors=[];
  async function worker(){
    const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(process.env.TUTORIAL_RENDER_URL||'http://127.0.0.1:4179',{waitUntil:'networkidle'});
    await page.waitForFunction(()=>typeof window.renderFrame==='function');
    while(index<scenes.length){
      const scene=scenes[index++];
      const asset=scene.asset?assets.find(a=>a.id===scene.asset):null;
      if(scene.asset&&!asset)throw Error(`Missing footage ${scene.asset}`);
      const visualAsset=asset?{...asset,url:`/@fs/${resolve(work,'capture',asset.file||asset.path).replace(/\\/g,'/')}`,type:'video',duration:asset.durationSeconds??asset.duration}:undefined;
      const example=examples.find(e=>e.id===scene.example);
      const destination=join(work,'render',scene.id+'.mp4');
      const digest=createHash('sha256');for(const code of visualSource)digest.update(code);
      digest.update(JSON.stringify({scene,example,visualAsset}));
      if(asset)digest.update(await readFile(resolve(work,'capture',asset.file||asset.path)));
      const fingerprint=digest.digest('hex');
      let previous;try{previous=await json(join(work,'render',scene.id+'.render.json'));}catch{}
      if(previous?.fingerprint===fingerprint&&(await stat(destination)).size===previous.bytes){console.log(`${++done}/${scenes.length}: ${scene.id}, verified checkpoint reused`);continue;}
      const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-r',String(fps),'-threads','2','-movflags','+faststart',destination],{windowsHide:true,stdio:['pipe','ignore','pipe']});
      let stderr='';encoder.stderr.on('data',b=>stderr+=b);
      const finished=new Promise((res,rej)=>{encoder.on('error',rej);encoder.on('close',code=>code===0?res():rej(Error(`${scene.id} encoder ${code}: ${stderr}`)));});
      const started=Date.now();
      for(let frame=0;frame<scene.frames;frame++){
        const t=frame/fps;
        await page.evaluate(async payload=>{await window.renderFrame(payload);},{scene,example,t,duration:scene.duration,progress:(scene.start+t)/manifest.duration,asset:visualAsset});
        const buffer=await page.screenshot({type:'jpeg',quality:92,animations:'disabled',timeout:30000});
        if(!encoder.stdin.write(buffer))await new Promise(res=>encoder.stdin.once('drain',res));
        if(frame===Math.min(Math.round(scene.frames*.72),scene.frames-1))await page.screenshot({path:join(work,'render',scene.id+'.png')});
      }
      encoder.stdin.end();await finished;
      if(errors.length)throw Error(errors.join('\n'));
      const info=await probe(destination);const stream=info.streams.find(s=>s.codec_type==='video');
      if(Number(stream.nb_frames)!==scene.frames)throw Error(`Frame count mismatch: ${scene.id}`);
      console.log(`${++done}/${scenes.length}: ${scene.id}, ${scene.frames} frames, rendered in ${((Date.now()-started)/1000).toFixed(1)}s`);
      await save(join(work,'render',scene.id+'.render.json'),{id:scene.id,fingerprint,frames:scene.frames,duration:scene.duration,bytes:(await stat(destination)).size,createdAt:new Date().toISOString(),errors:[]});
    }
    await page.close();
  }
  try{await Promise.all(Array.from({length:Number(process.env.RENDER_WORKERS||2)},()=>worker()));}finally{await browser.close();}
}

async function assemble(){
  const timeline=await json(join(work,'timeline.json')),renderDir=join(work,'render');
  const videoList=[],audioList=[];
  for(const scene of timeline.scenes){
    const video=join(renderDir,scene.id+'.mp4');await stat(video);
    const padded=join(renderDir,scene.id+'.wav');
    await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',scene.audioFile,'-af',`adelay=${Math.round(scene.audioLead*1000)},apad`,'-t',scene.duration.toFixed(6),'-ar','48000','-ac','1','-c:a','pcm_s16le',padded]);
    videoList.push(`file '${video.replace(/\\/g,'/').replace(/'/g,"'\\''")}'\nduration ${scene.duration.toFixed(9)}`);
    audioList.push(`file '${padded.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`);
  }
  await writeFile(join(renderDir,'video.txt'),videoList.join('\n'));
  await writeFile(join(renderDir,'audio.txt'),audioList.join('\n'));
  const analysis=await run(ffmpeg,['-hide_banner','-f','concat','-safe','0','-i','audio.txt','-af','loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json','-f','null','-'],{cwd:renderDir});
  const match=analysis.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);if(!match)throw Error('Loudness measurement absent');
  const loudness=JSON.parse(match[0]);await save(join(output,'Audio-normalization.json'),{...loudness,postNormalizationGainDb:-.25,reason:'Additional AAC encoding headroom keeps final true peaks below -1.5 dBTP.'});
  const filter=`loudnorm=I=-16:TP=-1.5:LRA=7:measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}:measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}:offset=${loudness.target_offset}:linear=true:print_format=json`;
  await run(ffmpeg,['-hide_banner','-y','-f','concat','-safe','0','-i','audio.txt','-af',filter,'-ar','48000','-ac','1','-c:a','pcm_s16le','narration.wav'],{cwd:renderDir});
  const clean=join(output,'BestWord-Tutorial-Clean.mp4');
  // Browser screenshots carry full-range JPEG color. Normalize the delivered
  // stream explicitly to standard limited-range yuv420p and an exact CFR clock.
  await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i','video.txt','-i','narration.wav','-map','0:v:0','-map','1:a:0','-vf','scale=in_range=pc:out_range=tv,format=yuv420p,fps=30,setpts=N/(30*TB)','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-color_range','tv','-r','30','-af','volume=-0.25dB','-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart','-shortest',clean],{cwd:renderDir});
  console.log('Clean MP4 assembled. Burning captions.');
  await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',clean,'-vf','ass=captions.ass','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-color_range','tv','-r','30','-c:a','copy','-movflags','+faststart',join(output,'BestWord-Tutorial.mp4')],{cwd:renderDir});
  await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss','2.8','-i',clean,'-frames:v','1',join(output,'BestWord-Poster.png')]);
  await copyFile(join(source,'content/rules-reference.md'),join(output,'Rules-reference.md'));
  await copyFile(join(source,'content/script.md'),join(output,'Transcript.md'));
  console.log('Both final video exports and reference files created.');
}

async function sample(){
  const timeline=await json(join(work,'timeline.json'));
  const scenes=['welcome','score-roommate'].map(id=>timeline.scenes.find(s=>s.id===id));
  const args=['-hide_banner','-loglevel','error','-y'];
  const filter=[];let cursor=0;const captions=[];
  for(const [index,scene] of scenes.entries()){
    args.push('-i',join(work,'render',scene.id+'.mp4'),'-i',scene.audioFile);
    filter.push(`[${index*2}:v]setpts=PTS-STARTPTS[v${index}]`);
    filter.push(`[${index*2+1}:a]adelay=600,apad,atrim=duration=${scene.duration},asetpts=PTS-STARTPTS[a${index}]`);
    captions.push(...timeline.captions.filter(c=>c.scene===scene.id).map(c=>({...c,start:c.start-scene.start+cursor,end:c.end-scene.start+cursor})));
    cursor+=scene.duration;
  }
  const original=await readFile(join(work,'render/captions.ass'),'utf8');
  const sampleAss=original.slice(0,original.indexOf('Dialogue:'))+captions.map(c=>`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\n/g,'\\N')}`).join('\n');
  await writeFile(join(work,'render/sample.ass'),sampleAss);
  filter.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]','[v]ass=sample.ass[out]');
  args.push('-filter_complex',filter.join(';'),'-map','[out]','-map','[a]','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-r','30','-c:a','aac','-ar','48000','-movflags','+faststart',join(work,'sample.mp4'));
  await run(ffmpeg,args,{cwd:join(work,'render')});
  console.log(`Internal narrated app/bridge sample created: ${cursor.toFixed(2)}s`);
}

async function verify(){
  const timeline=await json(join(work,'timeline.json'));const files=[];
  for(const name of ['BestWord-Tutorial.mp4','BestWord-Tutorial-Clean.mp4']){
    const path=join(output,name),info=await probe(path),video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
    if(video.width!==1920||video.height!==1080||video.avg_frame_rate!=='30/1'||video.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||audio.codec_name!=='aac'||audio.sample_rate!=='48000')throw Error(`Invalid media format: ${name}`);
    if(Number(info.format.duration)>480||Math.abs(Number(info.format.duration)-timeline.duration)>.15)throw Error(`Invalid duration: ${name}`);
    const decoded=await run(ffmpeg,['-v','error','-i',path,'-f','null','-']);
    if(decoded.stderr.trim())throw Error(`Decode errors: ${name}: ${decoded.stderr}`);
    if(Number(video.nb_frames)!==Math.round(timeline.duration*fps))throw Error(`Final frame count mismatch: ${name}`);
    const audioHash=(await run(ffmpeg,['-v','error','-i',path,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
    const content=await readFile(path),sha256=createHash('sha256').update(content).digest('hex');
    files.push({name,bytes:content.length,sha256,duration:Number(info.format.duration),width:video.width,height:video.height,fps:video.avg_frame_rate,frames:Number(video.nb_frames),pixelFormat:video.pix_fmt,videoCodec:video.codec_name,audioCodec:audio.codec_name,sampleRate:audio.sample_rate,audioHash,fullDecodeErrors:0});
  }
  const levels=await run(ffmpeg,['-hide_banner','-i',join(output,'BestWord-Tutorial.mp4'),'-af','loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json','-vn','-f','null','-']);
  const levelsMatch=levels.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);const measured=levelsMatch?JSON.parse(levelsMatch[0]):null;
  if(!measured||Math.abs(Number(measured.input_i)+16)>1||Number(measured.input_tp)>-1.5)throw Error('Final narration levels outside tolerance');
  for(const caption of timeline.captions)if(caption.text.split('\n').length>2||caption.start<0||caption.end<=caption.start||caption.end>timeline.duration)throw Error('Invalid caption timing/layout');
  if(files[0].audioHash!==files[1].audioHash)throw Error('The two exports have different audio');
  const blackScan=await run(ffmpeg,['-hide_banner','-i',join(output,'BestWord-Tutorial.mp4'),'-an','-vf','blackdetect=d=0.03:pix_th=0.04:pic_th=0.98','-f','null','-']);
  const blackIntervals=blackScan.stderr.match(/black_start:[^\r\n]*/g)||[];
  if(blackIntervals.length)throw Error(`Unexpected black frames: ${blackIntervals.join('; ')}`);
  await save(join(output,'Verification.json'),{verifiedAt:new Date().toISOString(),files,voice:'Microsoft Zira Desktop',spokenWords:timeline.wordCount,scenes:timeline.scenes.length,captions:timeline.captions.length,captionTimeRangeValid:true,identicalAudio:true,blackIntervals,finalLoudness:measured,scoreEvidence:await json(join(source,'content/verification.json'))});
  console.log(JSON.stringify({files:files.map(f=>({name:f.name,duration:f.duration,MB:(f.bytes/1e6).toFixed(1)})),loudness:measured}));
}

const action=process.argv[2];
if(action==='prepare')await prepare();else if(action==='render')await render();else if(action==='sample')await sample();else if(action==='assemble')await assemble();else if(action==='verify')await verify();else throw Error('Usage: node tools/tutorial/pipeline.mjs prepare|render|sample|assemble|verify');


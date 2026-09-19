/** Purpose-built, frame-exact editorial sequences of genuine application footage. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
const output=resolve(process.env.BESTWORD_TUTORIAL_CAPTURE_OUTPUT??'../../work/tutorial/capture');
const ffmpeg=process.env.BESTWORD_TUTORIAL_FFMPEG??resolve('../../work/tools/ffmpeg-9.0.1/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe');
const ffprobe=join(dirname(ffmpeg),process.platform==='win32'?'ffprobe.exe':'ffprobe');
const manifest=JSON.parse(await readFile(join(output,'assets.json'),'utf8'));
function run(command,args){return new Promise((resolvePromise,reject)=>{let stdout='',stderr='';const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('exit',code=>code===0?resolvePromise(stdout):reject(Error(`${command} exited ${code}: ${stderr}`)));});}
const fps=30;
const composites=[
  {id:'onboarding',description:'Genuine account form, sign-in submission, lobby time controls and table creation, then joining and countdown.',posterSeconds:5,parts:[
    {id:'account',startFrame:6,endFrame:42},
    {id:'sign-in',startFrame:96,endFrame:168},
    {id:'lobby',startFrame:0,endFrame:138},
    {id:'setup',startFrame:30,endFrame:47},
    {id:'setup',startFrame:52,endFrame:133},
  ]},
  {id:'review',description:'Actual move-history scoring breakdown followed by manual replay of the opening and accepted moves.',posterSeconds:1.5,parts:[
    {id:'history',startFrame:24,endFrame:124},
    {id:'replay',startFrame:18,endFrame:282},
  ]},
];
for(const composite of composites){
  const frames=composite.parts.reduce((sum,part)=>sum+part.endFrame-part.startFrame,0),path=join(output,'clips',`${composite.id}.mp4`);
  const inputs=composite.parts.map(part=>{const asset=manifest.assets.find(asset=>asset.id===part.id);if(!asset)throw Error(`Missing ${part.id}`);return resolve(output,asset.file||asset.path);});
  const trims=composite.parts.map((part,index)=>`[${index}:v]trim=start_frame=${part.startFrame}:end_frame=${part.endFrame},setpts=PTS-STARTPTS[v${index}]`).join(';');
  const filter=`${trims};${composite.parts.map((_,index)=>`[v${index}]`).join('')}concat=n=${composite.parts.length}:v=1:a=0,format=yuv420p[out]`;
  await run(ffmpeg,['-hide_banner','-loglevel','error','-y',...inputs.flatMap(file=>['-i',file]),'-filter_complex',filter,'-map','[out]','-an','-r',String(fps),'-frames:v',String(frames),'-c:v','libx264','-threads','2','-preset','fast','-crf','19','-movflags','+faststart',path]);
  const probe=JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',path]));const video=probe.streams.find(item=>item.codec_type==='video');
  if(video.width!==1280||video.height!==720||video.r_frame_rate!=='30/1'||Number(video.nb_frames)!==frames)throw Error(`Composite format/frame count mismatch: ${composite.id}`);
  const posterPath=join(output,`${composite.id}.png`);await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(composite.posterSeconds),'-i',path,'-frames:v','1',posterPath]);
  const asset={id:composite.id,file:`clips/${composite.id}.mp4`,path,width:1280,height:720,durationSeconds:Number(probe.format.duration),frames,posterPath,description:composite.description,sourceParts:composite.parts.map((part,index)=>({...part,sourceFile:inputs[index],startSeconds:part.startFrame/fps,endSeconds:part.endFrame/fps})),playbackSpeed:1};
  manifest.assets=manifest.assets.filter(asset=>asset.id!==composite.id);manifest.assets.push(asset);
  console.log(`${composite.id}: ${frames}frames, ${asset.durationSeconds}s`);
}
await writeFile(join(output,'assets.json'),JSON.stringify(manifest,null,2)+'\n');


/** Trim genuine application recordings. No app state is modified. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
const output=resolve(process.env.BESTWORD_TUTORIAL_CAPTURE_OUTPUT??'../../work/tutorial/capture');
const ffmpeg=process.env.BESTWORD_TUTORIAL_FFMPEG??resolve('../../work/tools/ffmpeg-9.0.1/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe');
const ffprobe=join(dirname(ffmpeg),process.platform==='win32'?'ffprobe.exe':'ffprobe');
const manifest=JSON.parse(await readFile(join(output,'capture-manifest.json'),'utf8'));
if(manifest.status!=='completed')throw Error('A completed real capture is required.');
function run(command,args){return new Promise((resolvePromise,reject)=>{let stdout='',stderr='';const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('exit',code=>code===0?resolvePromise(stdout):reject(Error(`${command} exited ${code}: ${stderr}`)));});}
const assets=[];await mkdir(join(output,'clips'),{recursive:true});
for(const clip of manifest.clips){
  const recording=manifest.recordings.find(item=>item.id===clip.recorder);if(!recording)throw Error(`Missing recording ${clip.recorder}`);
  // Include 0.20s of pre-roll to retain pointer approach and tolerate recorder initialization.
  const recorderOffsetSeconds=recording.timingOffsetSeconds??0;
  const sourceStartSeconds=Math.max(.6,clip.startSeconds-.2-recorderOffsetSeconds),duration=clip.endSeconds-recorderOffsetSeconds-sourceStartSeconds;
  const path=join(output,'clips',`${clip.id}.mp4`),sourceFile=join(output,recording.file);
  await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(sourceStartSeconds),'-i',sourceFile,'-t',String(duration),'-an','-vf','fps=30,format=yuv420p','-c:v','libx264','-threads','2','-preset','fast','-crf','19','-movflags','+faststart',path]);
  const probe=JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',path]));const video=probe.streams.find(item=>item.codec_type==='video');
  if(video.width!==recording.width||video.height!==recording.height||video.r_frame_rate!=='30/1'||video.codec_name!=='h264')throw Error(`Unexpected video format for ${clip.id}`);
  assets.push({id:clip.id,file:`clips/${clip.id}.mp4`,path,width:video.width,height:video.height,durationSeconds:Number(probe.format.duration),posterPath:join(output,clip.poster),sourceFile,sourceStartSeconds,recorderOffsetSeconds,description:clip.description});
  console.log(`Prepared ${clip.id}: ${Number(probe.format.duration).toFixed(2)}s`);
}
await writeFile(join(output,'assets.json'),JSON.stringify({version:1,source:'Genuine local BestWord browser footage',assets},null,2)+'\n');

/** Independent caption/content integrity review. Does not change narration or media. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const content=dirname(fileURLToPath(import.meta.url));
const task=resolve(content,'../../../../..');
const timelinePath=process.argv[2]||resolve(task,'work/tutorial/timeline.json');
const load=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const timeline=await load(timelinePath),scenes=await load(resolve(content,'scenes.json'));
const normalize=text=>text.replace(/\s+/g,' ').trim();
const findings=[];
for(const scene of scenes){
  const item=timeline.scenes.find(s=>s.id===scene.id),captions=timeline.captions.filter(c=>c.scene===scene.id);
  if(!item){findings.push({scene:scene.id,type:'missing-scene'});continue;}
  if(item.narration!==scene.narration)findings.push({scene:scene.id,type:'stale-narration'});
  if(normalize(captions.map(c=>c.text).join(' '))!==normalize(scene.narration))findings.push({scene:scene.id,type:'caption-text-mismatch'});
  if(item.audioLead+item.audioDuration>item.duration+.002)findings.push({scene:scene.id,type:'audio-truncated'});
  for(const [index,caption]of captions.entries()){
    if(!(caption.start<caption.end))findings.push({scene:scene.id,type:'nonpositive-duration',index,start:caption.start,end:caption.end});
    if(caption.start<item.start-.002 || caption.end>item.start+item.duration+.002 || caption.start>item.start+item.duration+.002)findings.push({scene:scene.id,type:'outside-scene',index});
    if(caption.text.split('\n').length>2)findings.push({scene:scene.id,type:'more-than-two-lines',index});
    if(index && captions[index-1].end>caption.start+.002)findings.push({scene:scene.id,type:'overlapping-caption',index});
  }
}
const types=Object.fromEntries([...new Set(findings.map(f=>f.type))].map(type=>[type,findings.filter(f=>f.type===type).length]));
const report={checkedAt:new Date().toISOString(),timelineCreatedAt:timeline.createdAt,timelinePath,duration:timeline.duration,sceneCount:timeline.scenes.length,captionCount:timeline.captions.length,spokenWords:scenes.reduce((n,s)=>n+s.narration.split(/\s+/).length,0),captionTextExact:!findings.some(f=>f.type==='caption-text-mismatch'),maxCaptionLines:Math.max(...timeline.captions.map(c=>c.text.split('\n').length)),maxCaptionLineCharacters:Math.max(...timeline.captions.flatMap(c=>c.text.split('\n').map(line=>line.length))),status:findings.length?'needs-correction':'passed',findingsByType:types,findings};
await writeFile(resolve(content,'caption-qa.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,findings:undefined},null,2));
if(findings.length)process.exitCode=1;

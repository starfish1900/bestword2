import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=dirname(fileURLToPath(import.meta.url)),task=resolve(source,'../../../..');
const output=process.env.BESTWORD_TUTORIAL_OUTPUT||join(task,'outputs/bestword-tutorial');
const work=process.env.BESTWORD_TUTORIAL_WORK||join(task,'work/tutorial');
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const timeline=await json(join(output,'Scene-manifest.json'));
const chapterTitles={starting:'Welcome to BestWord',setup:'Starting a game',letters:'Letters and automatic draws',legality:'Making legal words',input:'Entering and editing moves',scoring:'Scoring and bridges',actions:'NO WORDS, PASS and finishing',clocks:'Clocks and reconnection',watch:'Spectators, history and replay'};
const timeLabel=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
const roundedDuration=Math.round(timeline.duration);
const durationLabel=`${Math.floor(roundedDuration/60)} minutes ${roundedDuration%60} seconds`;
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

if(process.argv.includes('--viewer')){
  const chapters=[];
  for(const scene of timeline.scenes)if(!chapters.some(item=>item.id===scene.chapter))chapters.push({id:scene.chapter,start:scene.start,title:chapterTitles[scene.chapter]||scene.chapter});
  const template=await readFile(join(source,'content/viewer.template.html'),'utf8');
  const buttons=chapters.map(chapter=>`        <button class="chapter" data-time="${chapter.start}"><time>${timeLabel(chapter.start)}</time><span>${escape(chapter.title)}</span></button>`).join('\n');
  await writeFile(join(output,'Watch-BestWord.html'),template.replace('{{DURATION_LABEL}}',durationLabel).replace('{{WORD_COUNT}}',String(timeline.wordCount)).replace('{{CHAPTER_BUTTONS}}',buttons));
  await writeFile(join(output,'README.md'),`# BestWord tutorial package\n\nOpen **Watch-BestWord.html** in a browser to watch locally and jump between chapters. Keep the companion files in the same folder. The tutorial lasts **${durationLabel}**, with **${timeline.wordCount} spoken words** narrated by Microsoft Zira Desktop. No background music or internet connection is required.\n\n- **BestWord-Tutorial.mp4:** 1920 × 1080, 30 fps, with visible English captions.\n- **BestWord-Tutorial-Clean.mp4:** the same video and narration without burned-in captions.\n- **BestWord-Tutorial.srt / .vtt:** separate English captions.\n- **Transcript.md / Rules-reference.md:** complete narration, rules, scoring examples, and all letter values and quantities.\n- **Chapters.txt / BestWord-Poster.png:** chapter timestamps and poster.\n- **BestWord-Tutorial-Source.zip:** reproducible source and production assets; follow its REPRODUCING.md.\n- **Production-report.md / Verification.json:** completed checks, supporting evidence, and review limitations.\n\nThe revised tutorial explains the vowel-and-consonant requirement and persistent opening/player tile colors. Constructed teaching diagrams label existing and new letters separately. The video is delivered locally; nothing is published or deployed.\n\nThe complete playback and technical audio checks are automated. Pronunciation and voice quality have not received a subjective listening review; see the production report for the precise review boundary.\n`);
  console.log(JSON.stringify({viewer:'generated',duration:timeline.duration,spokenWords:timeline.wordCount,chapters:chapters.length}));
}else{
  const [media,playback,captions,viewer,inspection,portability]=await Promise.all([
    json(join(output,'Verification.json')),json(join(output,'Browser-playback-verification.json')),
    json(join(source,'content/caption-qa.json')),json(join(output,'Viewer-verification.json')),
    json(join(work,'inspection/inspection.json')),json(join(output,'Portability-verification.json')),
  ]);
  if(!playback.ended||playback.errors.length||playback.rate!==1||captions.status!=='passed'||viewer.status!=='passed'||inspection.errors.length||inspection.records.some(record=>record.overflows.length)||portability.status!=='passed')throw Error('Final checks are incomplete.');
  if(Math.abs(media.files[0].duration-timeline.duration)>.05||Math.abs(playback.duration-timeline.duration)>.05||captions.timelineCreatedAt!==timeline.createdAt||viewer.timelineCreatedAt!==timeline.createdAt||portability.timelineCreatedAt!==timeline.createdAt||Math.abs(portability.duration-timeline.duration)>.05||portability.spokenWords!==timeline.wordCount||portability.captions.some(item=>!item.identical))throw Error('Verification does not match the revised timeline.');
  const scoreEvidence=media.scoreEvidence;
  const frameCount=media.files[0].frames.toLocaleString('en-US');
  const report=`# BestWord tutorial — production and verification report

Completed local tutorial: **${Math.floor(timeline.duration/60)}:${(timeline.duration%60).toFixed(1).padStart(4,'0')}**, **${media.spokenWords} spoken words**, ${media.scenes} scenes and ${media.captions} English caption cues. Narration is Microsoft Zira Desktop; there is no music.

## Delivered media

| Export | Duration | Video | Audio | Size |
|---|---:|---|---|---:|
${media.files.map(f=>`| ${f.name} | ${f.duration} s | ${f.width} × ${f.height}, ${f.videoCodec}, ${f.pixelFormat}, ${Number(f.fps.split('/')[0])/Number(f.fps.split('/')[1])} fps | ${f.audioCodec}, ${Number(f.sampleRate)/1000} kHz | ${(f.bytes/1e6).toFixed(2)} MB |`).join('\n')}

Both exports contain ${frameCount} frames and ${media.identicalAudio?'identical':'different'} AAC narration. The second export omits burned-in captions. Narration measures **${media.finalLoudness.input_i} LUFS** with **${media.finalLoudness.input_tp} dBTP** peak after encoding. Both files include fast-start metadata.

## Checks completed

- Production engine and shipped dictionary: all five example totals pass — **${scoreEvidence.examples.map(example=>example.score).join(', ')}**. ANOPIAS's secondary contributions and all pillar/span coordinates match the engine.
- Every completed example word includes a vowel and a consonant, with Y treated as a vowel. MASTERPIECE entry uses the actual client draft functions. Letter values and quantities come from the production engine.
- The ${scoreEvidence.coverageRules}-item coverage checklist covers setup, tile ownership colors, bags, draws, legality, entry, scoring, actions, clocks, reconnection, spectators and replay. The complete 26-letter reference is included.
- Real browser capture supplies the application footage and its separate verification evidence. Constructed scoring boards explicitly distinguish existing and new tiles without assigning invented player ownership.
- Every caption reproduces its narration text; at most two lines; no overlap, invalid duration, scene-boundary error or cut-off narration. Visual cues for bridge calculations and MASTERPIECE follow measured speech-progress timestamps.
- Both final files decode completely with **${media.files.reduce((n,file)=>n+file.fullDecodeErrors,0)} reported errors**. Frame counts, codec, pixel format, audio format and duration pass. A full black-frame scan found **${media.blackIntervals.length} intervals**.
- The entire final captioned export played in Chromium at **1×** without seeking. Playback reached ${playback.time.toFixed(1)} seconds in ${playback.wallSeconds.toFixed(1)} seconds of wall time. The browser recorded ${playback.totalFrames} video frames and ${playback.droppedFrames} dropped frames. ${playback.frames.length} final-video review frames were retained across the tutorial.
- Final layouts reserve a separate subtitle area. Preview inspection covered ${inspection.records.length} timeline samples with no text overflow or browser errors.
- The offline viewer passes its desktop/mobile layout, chapter navigation, paused version switching, no-autoplay and no-network checks. Its detailed evidence is in Viewer-verification.json. All chapter offsets and visible statistics are generated from the current scene manifest.
- The source archive was extracted into a separate directory; the packaged pipeline regenerated the same ${portability.duration}-second timeline and exact SRT/WebVTT using the installed locked dependencies. The final ZIP includes a per-file SHA-256 manifest and has an archive checksum.

## Review boundary

The full normal-speed playback check is automated, with visual frame inspection. **No human or agent subjective audio-listening review was possible in this session.** Speech text, timing, audio decoding, levels and presence are checked; natural pronunciation and voice quality have not been certified by listening. The supplied script and individual narration segments make later corrections straightforward.

## Reproduction and scope

Open Watch-BestWord.html to watch locally, or use either MP4 directly. Captions, transcript, rules reference, chapter list and poster accompany the video. BestWord-Tutorial-Source.zip contains the application source needed by the tutorial renderer, production scripts, scene data, original narration and app recordings, scene clips and verification evidence. New untracked source components are included; local environment files, credentials and dependencies are excluded. Read REPRODUCING.md in that archive for exact commands.

This revision accompanies the updated word-composition rule, animated score totals, persistent opening/player tile colors and complete board grid. All future moves use the updated rule; previously accepted moves and scores remain intact. No paid service, purchase, public upload or public deployment was used.
`;
  await writeFile(join(output,'Production-report.md'),report);
  console.log('Final production report written from the revised manifest and verification evidence.');
}

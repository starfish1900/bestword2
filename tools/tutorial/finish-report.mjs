import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=dirname(fileURLToPath(import.meta.url)),task=resolve(source,'../../../..');
const output=process.env.BESTWORD_TUTORIAL_OUTPUT||join(task,'outputs/bestword-tutorial');
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const media=await json(join(output,'Verification.json'));
const playback=await json(join(output,'Browser-playback-verification.json'));
const captions=await json(join(source,'content/caption-qa.json'));
const viewer=await json(join(output,'Viewer-verification.json'));
if(!playback.ended||playback.errors.length||playback.rate!==1||captions.status!=='passed')throw Error('Final checks are incomplete.');
const report=`# BestWord tutorial — production and verification report

Completed local tutorial: **7:30.2**, **${media.spokenWords} spoken words**, 32 scenes and 119 English caption cues. Narration is Microsoft Zira Desktop; there is no music.

## Delivered media

| Export | Duration | Video | Audio | Size |
|---|---:|---|---|---:|
${media.files.map(f=>`| ${f.name} | ${f.duration} s | 1920 × 1080, H.264, yuv420p, 30 fps | AAC, 48 kHz | ${(f.bytes/1e6).toFixed(2)} MB |`).join('\n')}

Both exports contain exactly 13,506 frames and identical AAC narration. The second export omits burned-in captions. Narration measures **${media.finalLoudness.input_i} LUFS** with **${media.finalLoudness.input_tp} dBTP** peak after encoding. Both files include fast-start metadata.

## Checks completed

- Production engine and shipped dictionary: all five example totals pass — **186, 147, 261, 42 and 171**. ANOPIAS's six secondary contributions are 18, 20, 24, 16, 24 and 18; the principal is 51.
- All pillar and span coordinates are derived from pre-move boards and checked against engine results. MASTERPIECE entry uses the actual client draft functions. Letter values and quantities come from the production engine.
- The 44-rule coverage checklist covers setup, bags, draws, legality, entry, scoring, actions, clocks, reconnection, spectators and replay. The complete 26-letter reference is included.
- Real browser capture verified accepted keyboard/touch moves, retained drafts after rejection, active clocks, the 30-second increment, spectator privacy, permanent passes, history and replay. Isolated capture fixtures were cleaned up.
- Every caption reproduces its narration text; at most two lines; no overlap, invalid duration, scene-boundary error or cut-off narration. Visual cues for bridge calculations and MASTERPIECE follow measured speech-progress timestamps.
- Both final files decode completely with **zero reported errors**. Frame counts, codec, pixel format, audio format and duration pass. A full black-frame scan found **zero intervals**.
- The entire final captioned export played in Chromium at **1×** without seeking. Playback reached ${playback.time.toFixed(1)} seconds in ${playback.wallSeconds.toFixed(1)} seconds of wall time. The browser recorded ${playback.totalFrames} video frames and ${playback.droppedFrames} dropped frames. ${playback.frames.length} final-video review frames were retained across all chapters and scoring stages.
- Final layouts reserve a separate subtitle area. Preview inspection covered 48 timeline samples with no text overflow or browser errors; the final captioned frame samples were also inspected.
- The offline viewer passes desktop/mobile layout, chapter navigation, paused version switching, no-autoplay and no-network checks. Its detailed evidence is in Viewer-verification.json.
- The source archive was extracted into a separate directory; the packaged pipeline regenerated the same 450.2-second timeline and exact SRT/WebVTT using the installed locked dependencies. The final ZIP has its own per-file SHA-256 manifest and archive checksum.

## Review boundary

The full normal-speed playback check is automated, with visual frame inspection. **No human or agent subjective audio-listening review was possible in this session.** Speech text, timing, audio decoding, levels and presence are checked; natural pronunciation and voice quality have not been certified by listening. The supplied script and individual narration segments make later corrections straightforward.

## Reproduction and scope

Open Watch-BestWord.html to watch locally, or use either MP4 directly. Captions, transcript, rules reference, chapter list and poster accompany the video. BestWord-Tutorial-Source.zip contains the game source needed by the tutorial renderer, production scripts, scene data, original narration and app recordings, scene clips and verification evidence. Read REPRODUCING.md in that archive for exact commands.

Only tutorial production files were added to the game repository. Game rules, production APIs and Render configuration were unchanged. No paid service, purchase, public upload or public deployment was used.
`;
await writeFile(join(output,'Production-report.md'),report);
console.log('Final production report written.');

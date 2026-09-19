# Reproducing the BestWord tutorial

The tutorial is generated locally from the actual BestWord client recordings, the included script (word count is checked against the 900–1,000-word target), Microsoft Zira narration, and deterministic React/SVG diagrams. It uses no paid service, public upload or Render deployment. Reusing the included narration and clips requires no running game server or database.

## Package and prerequisites

The source package uses this layout:

```text
<bundle>/
  bestword/                         application source, dictionary, npm lockfile
    tools/tutorial/                 script, examples, capture, renderer, pipeline
  work/tutorial/
    audio/                          one WAV and speech-progress JSON per scene
    capture/
      clips/                        genuine application clips and two montages
      assets.json                   clip paths, dimensions and provenance
      capture-manifest.json         actual server/UI checks
    timeline.json                   production timeline; regenerate after moving
    render/                         generated scene videos, if retained
```

The WAV files, capture clips and manifests are reusable production inputs. Rendered scene clips are intermediates and can all be recreated; an archive without them must run the full `render` step before assembly. `node_modules`, browser installations, FFmpeg binaries and local database data are not required source-package contents.

Use Windows, **Node.js 24**, and the project's npm lockfile. The production tools use **TypeScript 5.9.3, React 19, Vite and Playwright** from the existing dependencies. Chromium and **Segoe UI** fonts are needed for matching frame layout. Regenerating narration additionally requires Windows PowerShell, .NET `System.Speech`, and the installed **Microsoft Zira Desktop** voice (US English). The supplied WAV files can be reused without that voice installed.

Install FFmpeg and FFprobe from the **FFmpeg 9.0.1 Gyan essentials build** used for production, or provide compatible executables with H.264/libx264, AAC, libass subtitles and loudnorm support. The downloaded build ZIP was verified against its published SHA-256:

```text
fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9
```

This checksum identifies the ZIP, not the extracted executable. Obtain Windows builds through the [FFmpeg download page](https://ffmpeg.org/download.html) and [Gyan build archive](https://www.gyan.dev/ffmpeg/builds/). Tool provenance is recorded in `PROGRESS.md`.

## Set up an extracted package

Run these PowerShell commands after replacing the two example paths. Explicit directory variables are important: the original workspace defaults assume the application is inside an `outputs` directory, whereas this portable package uses a sibling `bestword` and `work` layout.

```powershell
Set-Location 'C:\path\to\bundle\bestword'
$tutorialBundle = Split-Path -Parent (Get-Location).Path
$env:BESTWORD_TUTORIAL_WORK = Join-Path $tutorialBundle 'work\tutorial'
$env:BESTWORD_TUTORIAL_OUTPUT = Join-Path $tutorialBundle 'exports'
$env:FFMPEG_PATH = 'C:\path\to\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe'
$env:FFPROBE_PATH = Join-Path (Split-Path -Parent $env:FFMPEG_PATH) 'ffprobe.exe'
$env:TUTORIAL_RENDER_URL = 'http://127.0.0.1:4179'
$env:RENDER_WORKERS = '2'

npm ci
npm run build:packages
npx playwright install chromium
node --import tsx tools/tutorial/content/verify.ts
```

The content audit regenerates examples and references using the **production scoring engine and exact shipped GADDAG**. It verifies scores 186, 147, 261, 42 and 171, every visual span coordinate, all six ANOPIAS secondary bridges, the original tile inventory and MASTERPIECE inference through the real input functions.

Capture assets are resolved from `work/tutorial/capture` using their relative `file` entries. Run `prepare` after extraction to replace historical absolute audio paths with paths for the new location. Preserve the narration JSON records together with their matching WAV files.

## Narration, rendering and export

**Reuse the included audio unless editing narration.** To regenerate all narration, use Windows PowerShell from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/tutorial/audio/synthesize.ps1 `
  -Scenes tools/tutorial/content/scenes.json `
  -OutputDirectory "$env:BESTWORD_TUTORIAL_WORK\audio" -Rate 1
```

The final voice setting is **Zira, Rate 1**, synthesized as **16 kHz, 16-bit mono WAV**. Native 16 kHz keeps `SpeakProgress` word timestamps aligned with the WAV. Changing synthesis to 24 kHz previously produced incorrect caption timings; resampling is instead done during final assembly to 48 kHz. Use `-SceneId score-roommate`, for example, to regenerate one changed scene. The script's default rate is not the production setting, so pass `-Rate 1` explicitly.

Start the visual renderer in a second terminal, from the same `bestword` directory, and leave it running:

```powershell
npx vite --config tools/tutorial/visual/vite.config.ts
```

Then run the pipeline in the first terminal, where the environment variables were set:

```powershell
node tools/tutorial/pipeline.mjs prepare
node tools/tutorial/content/qa-captions.mjs "$env:BESTWORD_TUTORIAL_WORK\timeline.json"
node tools/tutorial/pipeline.mjs render
node tools/tutorial/pipeline.mjs assemble
node tools/tutorial/pipeline.mjs verify
node tools/tutorial/finish-report.mjs --viewer
```

`finish-report.mjs --viewer` generates the offline viewer and delivery guide from the current scene manifest. Chapter positions, duration and spoken-word totals are never manually copied from a previous export. After normal-speed playback, layout, viewer and portability checks have been refreshed, run `node tools/tutorial/finish-report.mjs` to write the final evidence-based report.

The delivery checks are reproducible too. After exporting and generating the viewer, run `node tools/tutorial/verify-delivery.mjs viewer`. It opens the local HTML through `file://`, checks every chapter against the scene manifest, verifies paused navigation and version switching, and checks desktop and phone layouts without external requests. Package the source with `python tools/tutorial/package.py`, then run `node tools/tutorial/verify-delivery.mjs portability`. This extracts the archive into a fresh work directory, verifies its file hashes and current application additions, and regenerates byte-identical captions with the installed locked dependencies. Python 3 is required for archive checks; set `PYTHON_PATH` if it is not available as `python`.

After finishing the production report, package once more to include the fresh evidence. The portability report records a separate hash of application and narration inputs so report-only repackaging does not obscure which inputs were verified. Fresh extraction directories are retained for inspection; no existing directory is overwritten or removed.

The stages do the following:

| Stage | Result |
|---|---|
| `prepare` | Checks audio/script correspondence; computes scene timings and speech-driven visual cues; writes timeline, SRT, WebVTT, ASS captions and chapter markers. Rejects a duration over eight minutes. |
| `qa-captions` | Independently verifies exact narration text, positive caption durations, scene boundaries, non-overlap, two-line maximum and untruncated narration. |
| `render` | Captures deterministic 1920 × 1080 Chromium frames at 30 fps; encodes and saves each scene separately; verifies scene frame counts. |
| `assemble` | Pads narration to scene boundaries, applies two-pass loudness normalization, concatenates scenes, and writes clean and captioned H.264/AAC MP4s, poster, transcript and rules reference. |
| `verify` | Checks both exports' codecs, resolution, rate, duration, caption timing and loudness; decodes the entire media files and writes hashes and verification evidence. |

The final format is H.264 `yuv420p`, 1920 × 1080, 30 fps; AAC narration at 48 kHz; fast-start MP4. Video uses CRF 20. Audio targets approximately −16 LUFS and −1.5 dB true peak. The measured duration, scene count and caption count are recorded in the generated Scene-manifest.json and Verification.json; regenerate them after revisions.

For a scene correction, set `SCENES` to comma-separated IDs before rendering. This replaces only selected scene intermediates; assembly still requires every scene.

```powershell
$env:SCENES = 'score-roommate,score-anopias-detail'
node tools/tutorial/pipeline.mjs render
Remove-Item Env:SCENES
node tools/tutorial/pipeline.mjs assemble
node tools/tutorial/pipeline.mjs verify
node tools/tutorial/finish-report.mjs --viewer
```

`RENDER_WORKERS` controls concurrent browser encoders (default 2). `TUTORIAL_RENDER_URL` selects the renderer URL; use `BESTWORD_TUTORIAL_PORT` in the renderer's terminal to change its listening port. Keep it on loopback. `BESTWORD_TUTORIAL_WORK`, `BESTWORD_TUTORIAL_OUTPUT`, `FFMPEG_PATH` and `FFPROBE_PATH` accept absolute paths. `SCENES` filters rendering only, not preparation or assembly.

## Re-recording application footage

This is optional when the packaged clips are available. See `capture/README.md` for the full local-service setup. Build the application and start the task-local PostgreSQL/Redis services first. The capture expects PostgreSQL at `127.0.0.1:54329`, Redis at `127.0.0.1:6389`, and reserves loopback port 3012 for its temporary game server.

```powershell
npm run build
npm run dev:services
$env:BESTWORD_TUTORIAL_CAPTURE_OUTPUT = Join-Path $env:BESTWORD_TUTORIAL_WORK 'capture'
$env:BESTWORD_TUTORIAL_FFMPEG = $env:FFMPEG_PATH
node --import tsx tools/tutorial/capture/capture.ts
node tools/tutorial/capture/prepare-clips.mjs
node tools/tutorial/capture/compose-footage.mjs
```

Capture registers disposable accounts and plays a real game in a fresh owned PostgreSQL schema and an empty, nonzero Redis logical database. It verifies keyboard/touch moves, clocks, privacy, passing and replay, then removes its fixtures and closes its own server. Random setup means a new recording will show different words. Inspect new footage and retune editorial source ranges as necessary; the supplied montage ranges were selected for the delivered recordings. Re-run preparation, rendering and export after replacing any clip.

## Evidence and dependencies

Content checks are saved under `content/`; capture evidence accompanies the footage; each completed rendered scene has a `.render.json`; final verification is written to the export directory. Machine checks establish specific format, text, scoring and timing properties. They do not substitute for listening to the narration or watching the complete tutorial at normal speed. Review pronunciation, formula timing, visibility, caption placement and the onboarding/history montages after changes.

`npm ci` installs the versions pinned by the application's `package-lock.json`; preserve the packages' own license notices. Browser binaries, Microsoft voices and Windows fonts are separately installed dependencies, not redistributed as tutorial source. FFmpeg's license depends on its build options; retain the downloaded build's license and third-party notices if redistributing that binary. The supplied game dictionary remains the original user-provided data; this guide does not add a new redistribution license for it. No third-party music, paid narration service or remote rendering service is used.


## Updated rule and appearance

Every completed principal and secondary word now needs a vowel and a consonant; Y is a vowel, and existing letters count. This applies to all future moves, with no legacy validation branch. The tutorial distinguishes grey opening tiles from green and orange player contributions in genuine app footage. Constructed diagrams retain their explicit existing/new legend rather than suggesting fabricated player histories.

The current revision changes narration for `setup-board`, `secondary-words` and `score-recap`. Recapture app footage after applying the client changes so ownership colors, complete grid lines and the 900-millisecond score count-up appear in the video. If editing any narration again, regenerate that scene’s WAV and word timestamps before preparing a fresh timeline.

The source packager includes tracked and non-ignored untracked source files, excluding local environment files, secrets, dependencies and build output. Commit state does not determine whether a new application component reaches the reproducible archive.

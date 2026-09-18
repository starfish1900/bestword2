# BestWord tutorial production

The user approved local production of a 7–8 minute, narrated 1080p tutorial, using actual application footage, animated scoring diagrams and the installed Microsoft Zira English voice. No paid speech service, public upload or Render change is authorized or required.

## Milestone 1 — source and tools

- Script and rule coverage completed: 32 scenes, 998 spoken words, 44-rule checklist. All five scores and MASTERPIECE inference verified against production code.
- Genuine UI capture completed under `capture/`, using an isolated local database/schema and Redis logical database. Owned fixtures and capture server were cleaned up. Sixteen edited clips include onboarding and review montages.
- Deterministic React/SVG renderer completed under `visual/`; strict TypeScript checks passed.
- Portable FFmpeg 9.0.1 was downloaded from Gyan's build linked by the FFmpeg project. ZIP SHA-256: `fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`, matched its published checksum.
- Microsoft Zira Desktop and David Desktop were found installed; the selected voice is Zira.

Work products and temporary media are saved outside the game source under the task's `work/tutorial` directory. Final user-facing media will be saved under `outputs/bestword-tutorial`.

## Milestone 2 — sample and synchronization

- Generated all narration with Zira, rate 1. Measured narration and reading holds produce a 450.2-second (7:30.2) timeline.
- Corrected a Windows speech progress-time discrepancy by synthesizing 16 kHz PCM before final resampling to 48 kHz.
- Independent caption audit: 119 cues, exact narration text, at most two lines, no overlap, negative duration, truncation or scene-boundary errors.
- Scoring and MASTERPIECE animation cues are derived from measured spoken-word timestamps.
- Internal 27.63-second sample combines genuine app footage, a bridge diagram, narration and captions. Sample media assembled successfully; captioned score frame visually inspected.
- All 32 scenes inspected at 48 representative timeline points: no browser errors or text overflow. Corrected ANOPIAS spacing, teaching-board label, opening-word length, and zero/one-old-tile span wording.

## Milestone 3 — production render

- Full 1080p/30fps scene render completed; each clip has a source fingerprint, frame-count check, and saved checkpoint.
- Rendering supports selective regeneration and verified checkpoint reuse. Production game files remain unchanged.

## Milestone 4 — final media

- All 32 scene clips rendered: 13,506 frames total. Both final exports are 450.2 seconds, 1920 × 1080, exact 30 fps, H.264/yuv420p with AAC at 48 kHz.
- Explicit full-to-limited color conversion fixed the screenshot encoder's inherited full-range flag. Exact scene durations and a constant-frame-rate pass eliminate concatenation rounding.
- Two-pass loudness normalization plus 0.25 dB encoding headroom yields approximately -16.38 LUFS and -1.61 dBTP in the final AAC stream.
- SRT, WebVTT, transcript, complete rules/tile reference, chapter timings, poster and offline chapter viewer exported.
- Viewer tests passed for metadata, chapter seeking, paused caption-version switching, desktop/mobile layout, no autoplay and no network requests.
- Full normal-speed Chromium playback completed: all 450.2 seconds, 13,506 frames, zero dropped frames, zero browser errors, no seeking. Audio was decoded and 46 final-video review frames were saved.
- Both exports decode without errors, contain identical AAC audio and have no detected black-frame intervals.
- Source package extraction reproduced the same timeline and byte-identical SRT/WebVTT captions in a separate folder. ZIP integrity and required-source/media checks passed.
- Final artifacts and verification reports are delivered under `outputs/bestword-tutorial`. The final production report records all checks and the review boundary below.

Review boundary: the agent can inspect frames and verify audio data, but cannot listen to audio through this session. No subjective pronunciation listening review is claimed.


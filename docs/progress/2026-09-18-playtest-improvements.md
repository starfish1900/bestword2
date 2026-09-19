# Playtest improvements and tutorial refresh

## Agreed behavior

- Every completed principal/secondary word and opening word needs an AEIOUY vowel and a consonant. Applies to all future moves, including existing local games; no version branching or historical revalidation.
- Confirmed score totals count up for 900 ms with cubic ease-out. Reduced motion, reconnects, initial loads and replay jumps settle immediately.
- Opening tiles remain grey; contributions keep stable green/orange seat colors across crossings, viewers and replay. Explicit cell borders replace grid gaps.
- Refresh the local narrated tutorial and every companion artifact. No public deployment or purchases.

## Application checkpoint

- Engine tests: 121 passed, including the five published scoring examples.
- Full unit/real PostgreSQL and Redis integration suite: **190 tests passed in 9 files** (123.82 seconds). Evidence retained in task `work/bestword-update-tests.json`.
- Type checking and production build passed.
- Focused real-browser ownership/grid and score tests passed. Independent review found that `aria-label` on `strong` did not expose the score in Chromium's accessibility tree; replaced it with hidden confirmed-score text and added accessibility-tree assertions.
- A broader browser attempt exhausted registration limits in the shared local test environment. Final checks now use an owned disposable PostgreSQL schema and Redis logical database; application rate limits are unchanged.

## Tutorial checkpoint

- Updated three narrated scenes: setup-board, secondary-words, score-recap.
- Content audit: 999 words, 32 scenes, 46 coverage items; examples remain 186, 147, 261, 42, 171.
- Microsoft Zira narration regenerated for changed scenes at the existing Rate 1/native 16 kHz setting.
- Viewer chapter offsets and production-report statistics now derive from the latest manifests.
- Initial recapture failed in an observation callback because TypeScript's generated helper was unavailable inside the browser. Callback corrected; interrupted capture fixtures were ownership-checked and removed. Recapture is underway.

## Remaining at this checkpoint

Complete consolidated browser checks, record/cut updated footage, regenerate and inspect both video exports, verify source-package reproduction, then record final evidence and commit locally.

## Final application and media build

- All five application improvements are implemented. The composition rule applies to all future moves; no version split, database migration, vocabulary changes or retrospective score changes.
- Final application type check and production build pass. The 190-test unit/database suite passes; the final built assets pass all **8 Chromium browser tests** with no skipped, flaky or failed tests (77.29 seconds). Evidence: `docs/evidence/playtest-unit-integration.json` and `playtest-browser.json`.
- WebKit score/replay checks pass. Additional testing reproduced the reported disappearing lines at fractional display density. Painting borders on the square buttons instead of their parent cells fixes WebKit's rasterization issue. A pixel regression now checks every separator, beyond merely checking CSS properties.
- Final grid browser checks pass in Chromium and WebKit. The **30-case** matrix covers both engines, densities 1/1.25/2, and five layouts. Every horizontal/vertical separator is visible; no page overflow. Canonical evidence: `docs/evidence/playtest-grid.json`.
- At the tutorial's Chromium 1280×720/DPR1 capture size, the border fix changes **zero board pixels**. The newly recorded footage therefore remains visually exact.
- Firefox's installed executable could not launch (`spawn UNKNOWN`); no Firefox pass is claimed. The previously retained capacity/load reports are historical and were not rerun for this UI/rule update.
- Fresh tutorial capture succeeds with no page errors; the actual score display records intermediate values 0,1,2,3,4,5,6,7, ending at 7 after about 908 ms. Owned capture and final browser-test fixtures were removed; the original local preview and shared database services were preserved.
- The tutorial is **454.366667 seconds (7:34.37)**, 13,631 frames, 999 spoken words, 32 scenes and 120 captions. Both 1080p/30fps exports decode completely, share identical narration, and have no detected blank intervals. Final audio: −16.38 LUFS / −1.69 dBTP.
- Forty-eight scene layouts and all five score examples pass independent visual/rules/timing review. The refreshed offline viewer passes chapter, caption-switch, keyboard, local-resource and phone-layout checks.
- Full normal-speed playback and extracted-source reproduction evidence accompany the tutorial in `Browser-playback-verification.json`, `Portability-verification.json` and `Production-report.md`. Subjective audio listening is not claimed.

No purchase, public upload, public deployment, or Render configuration change was made.

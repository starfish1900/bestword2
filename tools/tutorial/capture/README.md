# Genuine application footage

Run these from the BestWord repository root with Node 24 and its installed npm dependencies. The existing application must be built and Playwright Chromium installed. The task-local development services must be running at PostgreSQL port 54329 and Redis port 6389.

```text
node --import tsx tools/tutorial/capture/capture.ts
node tools/tutorial/capture/prepare-clips.mjs
node tools/tutorial/capture/compose-footage.mjs
```

The capture creates a fresh PostgreSQL schema and claims an empty, nonzero Redis logical database with an atomic ownership check. It serves the actual application on loopback port 3012. Two disposable tutorial users are registered through the real UI; another real browser session signs in. All moves and results use the actual server. No production source, game state, rule, authentication, or public service is changed.

The capture includes account creation, sign-in, time controls, matching and countdown, clocks, a rejected move, direction selection, typing, Backspace, Enter, touchscreen rack/vowel input, NO WORDS, permanent passes, anonymous spectating, move history and replay. Page errors and checks are written to `capture-manifest.json`. The tutorial server, browser contexts and owned database fixtures are closed and removed at completion. Shared local database services are left running.

Media defaults to `../../work/tutorial/capture` relative to the repository. Override `BESTWORD_TUTORIAL_CAPTURE_OUTPUT` to change that. Only disposable local credentials are used; their password is randomly generated and is never included in the report.

The preparer expects the workspace FFmpeg 9.0.1 portable build. Override `BESTWORD_TUTORIAL_FFMPEG` with another FFmpeg executable containing H.264 support. It writes silent 30 fps H.264 MP4 excerpts and `assets.json`, with each clip's absolute path, dimensions, duration, source time range and poster path. Source ranges are measured against browser page creation; the preparer retains 0.20 seconds of pre-roll to accommodate video recorder initialization, but removes the first 0.60 seconds of every source recording to exclude blank/loading frames. The current recording was visually checked at that boundary; re-recordings should be checked again. Final asset duration is measured with FFprobe.

The gold circular pointer is a capture-only DOM overlay; it does not intercept clicks or modify the application. Desktop captures use 1280×720 and mobile captures use 390×844. The final tutorial may crop and enlarge regions for legibility.

Recorders are created immediately before their first navigation. An older capture created Sam's blank recorder before Alice's account registration; the resulting first-navigation offset was discovered in a visual audit and recorded as `timingOffsetSeconds: 6.5` on that source recording. The preparer honors audited offsets. The corrected setup and pass clips include the Join/countdown and full pass confirmation, respectively.

`compose-footage.mjs` appends two frame-exact editorial assets to the manifest. `onboarding` contains the account form, sign-in submission, time controls, table creation and actual Join/countdown in 344 frames (11.4667 seconds). `review` contains the history scoring breakdown and genuine replay interaction in 364 frames (12.1333 seconds). These sequences retain normal playback speed; their source frame ranges are included in the asset manifest. Run this step after preparing base clips, since the base preparer deliberately regenerates the manifest.

# Computer opponents, replay access and tutorial client — 2026-09-19

Implemented the approved client work. The lobby offers a person or computer, three difficulty levels and the existing time controls. Computer choices survive the sign-in return journey. The game shows the computer's level and whose turn it is, including a thinking state. Creation uses the real `/api/games/ai` route; admission, seek cancellation and durable game creation stay in the server.

Recent games use 50-item pages. A refresh merges new rows into the retained expanded list without replacing its deepest cursor. Busy refreshes walk intervening pages until they overlap the retained list, so a burst larger than 50 games does not leave a gap. Obsolete refresh responses cannot replace newer results, and a delayed older page can complete across a refresh without rewinding its cursor. Refresh preserves the visible row and keyboard focus.

Guests see the current board, server-supplied tile origins, latest tiles and recent summaries. Full history and replay require a signed-in account. Replay links retain their selected move through sign-in or registration; return destinations are restricted to recognized local app routes. Existing real spectator tests now explicitly sign in before exercising replay. Help opens above the mounted game, retaining its socket and active clock.

All help entry points use the same Rules / Video dialog. Video has native playback controls, English burned-in captions, the delivered poster and nine chapter shortcuts copied from the delivered scene manifest. It has no source before an explicit Play or chapter action. Selecting Video alone downloads no MP4. Switching back to Rules or closing help pauses playback, releases the source and stops further playback. The live player sees a clock reminder.

The public versioned asset is the unchanged delivered MP4: 16,544,578 bytes, SHA256 `9fbe34a89b81a63adf2653614849032775ee1c19a90a555736e5c9af326b78be`. No video was edited, uploaded or externally hosted.

## Verification

- Web TypeScript check passed; all **28 unit tests across 6 files** passed. New tests cover history merges, busy-page gaps, stale refreshes and safe authentication return URLs.
- New Chromium client and real-AI suite: **7 passed**. A real local worker committed an AI word and the browser displayed that exact move in signed-in replay and full history. The consolidated run's example was **VACUUM, 75 points, move 2**.
- Consolidated Chromium browser run: **14 passed, 1 setup failure**. The board test's second test-account registration received HTTP 429 because preceding local runs had consumed the five-per-hour signup allowance. After root verified the disposable Redis fixture's ownership and reset only registration rate keys, the same board test and run ID passed (**1/1**, 9.7 seconds). Production limits were not changed. Existing human play, touch, clocks, score animation, acknowledgement and lobby recovery checks passed in the consolidated run.
- WebKit new client suite: **5 passed, 1 explicit native-codec skip**. It covers replay login return, AI controls, desktop/mobile help layout, history refresh races and media HTTP behavior. Native H.264 playback was verified with installed Chromium; no equivalent WebKit codec claim is made.
- Verified anonymous media HEAD, exact byte-range response, one-year immutable caching, missing-media 404 without HTML fallback, and SHA256 of the complete served MP4.
- Browser tests confirm no video request before explicit play, real playback and chapter seek, playback cleanup on Rules and close, and unchanged live socket connection count while opening/closing help.
- Visually inspected 1280×800, 390×844 and 320×568 screenshots for computer setup and tutorial help, plus the real AI replay. Content remained readable; the help panel scrolls vertically on shorter screens without horizontal overflow.

Structured results: [client evidence](../evidence/ai-client-tests.json). Detailed local browser reports and screenshots are retained in the task workspace under `work/ai-browser-full`, `work/ai-board-rerun`, `work/ai-client-browser` and `work/ai-client-webkit`. Presentation fixtures are explicitly labeled and do not substitute for the parent task's server authorization, AI search or persistence checks.

## Reproduce

Run the ordinary production build and local API. Start a compatible AI worker before running the real AI browser test. Set `BESTWORD_AI_E2E=1`, set `BESTWORD_BASE_URL` to the local application origin, then run `npx playwright test`. The real-AI case is explicitly skipped without that flag. Use one fixed `BESTWORD_E2E_RUN_ID` for repeated checks to reuse test accounts without changing signup protections.

For the focused client tests, run `npx playwright test tools/e2e/client-features.spec.ts tools/e2e/ai-game.spec.ts`. Set `BESTWORD_CROSS_BROWSER=1` and select the installed browser project for cross-browser checks. No public deployment or paid service was used.

## Final consolidated verification

Repeated the complete browser suite against the final production bundle and a fresh isolated API/AI environment on port 3016, using run ID `Final0919A`. The same five accounts were reused between browsers. No registration-limit resets or application source changes were needed in this final run.

- **Chromium: all 15 passed**, including native tutorial playback, real computer and human games, signed-in replay, guest restrictions, list refresh races, clocks, score animation, touch input and screenshot grid checks. See [final Chromium report](../evidence/ai-browser-final.json).
- **WebKit: 13 passed, 2 explicit skips**, with no failures. The skips are the Chromium-only acknowledgement response fault fixture and native H.264 playback. WebKit passed the real AI game, human games, replay, score animation, touch, board raster checks, mobile help layouts and media HTTP tests. See [final WebKit report](../evidence/ai-browser-webkit-final.json).
- **Firefox runtime unavailable**: a fresh headless launch probe failed with `spawn UNKNOWN` before opening any application page. See [runtime evidence](../evidence/ai-browser-firefox-runtime.json). This is an environment limitation, not a passing or failing application test.

Visually inspected the final Chromium mobile tutorial note and real AI replay, and the final WebKit small-phone tutorial and real AI replay. The new written note identifies the current vowel/consonant rule while preserving the video itself unchanged. These clean consolidated runs supersede the earlier local signup-limit setup failure described above.

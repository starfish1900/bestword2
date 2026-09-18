# Final content and caption audit

Reviewed the frozen 998-word, 32-scene script against the approved storyboard, original specifications, agreed clarifications, production rules and capture manifest. No narration changes were made during this audit.

## Rules and example coverage

The script covers setup, random initial crossing words and first player, no bonuses/blanks, clocks and increments, sources of vowels/consonants, mandatory draws and limits, legal placement and secondary words, word-history restrictions, directional keyboard entry and editing, the exact MASTERPIECE inference example, mobile taps, invalid-move behavior, both scoring formulas, all five requested examples, permanent PASS, NO WORDS restrictions, normal finishing, disconnections, infrastructure pauses, spectator privacy, and replay. The complete 26-letter values/quantities chart appears visually and in the reference.

The production-engine/GADDAG audit passed the five exact scores (186, 147, 261, 42 and 171), all pillar/span coordinates, the six ANOPIAS secondary bridges and scores, and the production MASTERPIECE input inference. See `verification.json` and `coverage.json`.

Phrases such as “two new tiles,” “actual consonant drawn this turn,” and “25 seconds from server detection” preserve important edge conditions. The spectator narration correctly says both clocks are visible; only the active player's clock ticks. Parenthesized principal scoring is explained unambiguously in speech. Bridge legality is reinforced visually and in the rules reference.

The longer reference additionally documents exact-deadline equality, simultaneous losses, multi-tab connection behavior, account restrictions and privacy details that are not needed as individual spoken explanations in a compact beginner tutorial.

## Caption integrity findings

The corrected timeline (created **2026-09-18T11:39:56.146Z**) reconstructs all 32 narrations exactly: **no words or punctuation missing**, **119 caption chunks**, at most **two lines**, maximum **44 characters** on one line. The duration is **450.2 seconds (7:30.2)**.

The initial 24 kHz synthesis produced 28 nonpositive caption durations and 50 chunks outside their scene because speech-progress timestamps did not follow the resampled WAV clock. This was caught before release. All 32 audio segments were regenerated at the voice's native 16 kHz format, then captions and timeline were regenerated. **The independent re-audit passes: zero nonpositive durations, zero out-of-scene captions, zero overlaps, zero stale narration, zero truncated speech, and zero caption text mismatches.** Final encoding resamples narration separately to 48 kHz.

Run `node tools/tutorial/content/qa-captions.mjs` from the repository root after regeneration. The resulting `caption-qa.json` is the latest machine-readable result and must report `passed`. This check independently compares every caption's reconstructed text with the frozen source, checks scene boundaries, non-overlap, positive duration, two-line maximum, and verifies that speech is not cut off by its scene.

## Required footage findings

The capture manifest records genuine local account creation and sign-in, all three time choices, matching/countdown, moving and stopped clocks, rejection with retained draft, keyboard toggling/typing/Backspace/Enter, mobile rack/vowel input, anonymous spectators, NO WORDS, PASS, finishing, history and replay. These behaviors were checked against actual server results; captures have a labeled origin and disposable local accounts.

Two planned demonstrations were captured but were not selected by the initial scene-to-asset mapping: sign-in/account footage and move-history footage. The final timeline now selects the verified `onboarding` montage for `join` and the `review` montage for `replay`. Both selections were confirmed in the production frames. The mobile narration was also shortened by one word to avoid implying a fixed screen location for the vowel controls; the final 998-word script and regenerated captions pass the independent data audit.

## Review boundary

This is a script, rules, structured examples, capture-manifest and caption-data audit, with the producer's final montage confirmation above. Final video format, playback and frame checks are recorded separately in the delivered verification reports. It does not claim subjective audio listening. The script contains no identified missing gameplay rule from the agreed tutorial scope.


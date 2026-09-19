# AI and client improvements — implementation record

## Approved scope

Implement exact anchor/cross-check/GADDAG search, restricted Easy/Medium vocabulary, bounded strategic NO WORDS lookahead, durable server AI games with normal clocks, persistent Recent games pagination, authenticated replay, and unchanged tutorial integration through every help link. No paid services or public deployment.

## Initial checkpoint

- Desktop source intersections confirmed: Easy 9,868/9,870, Medium 38,359/38,369; Easy is a subset of Medium.
- Existing full dictionary remains 279,320 entries with original SHA-256 `87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af`.
- Search, server, and client implementation proceed in separate assigned areas; root owns public contracts, replay delivery enforcement, integration and release configuration.
- Public live snapshots now have explicit history access, move count, tile origins, last move tiles and recent summaries. Full history will be delivered only after authentication.
- Task-local PostgreSQL18 and Redis7 started for real integration tests. No public resources created.

## Implementation and validation checkpoint

- Implementation saved locally in commit `2b1d002`; no push, deployment or purchase.
- Easy/Medium graphs are deterministic, nested legal intersections. Full source, supplied frequency lists, graphs and the unchanged tutorial have been verified against committed bytes.
- Exact search and strategy tests pass, including independent exhaustive move comparisons, all five scoring examples, full racks, empty bags, cancellation and strategic waiting.
- Final consolidated suite: **245/245 passed**, zero skips. Real PostgreSQL/Redis tests cover leases, duplicate submissions, worker crashes, shutdown races, clock losses, network failures and replay access. Easy/Medium recovery also pins the full dictionary hash so an incompatible replacement worker cannot resume an old game.
- Final Chromium: **15/15 passed**. WebKit: **13 passed**, two explicit platform/fixture skips. Native tutorial playback passed in Chromium. Firefox cannot launch locally (`spawn UNKNOWN`); Linux CI and Docker execution remain unexecuted because this environment has no usable Docker/WSL runtime.
- Build/typecheck, human load smoke, dependency audit (zero vulnerabilities) and cached official deployment-schema validation pass.
- Local AI probes at 1, 2, 5 and 10 games passed. The final one-hour mixed run uses 10 AI games plus one human game, with the whole AI process pinned to one logical CPU. It is still running; no completed-hour claim is made at this checkpoint.

The Render configuration now includes the dedicated AI worker, one search thread and a maximum of ten AI games within the total admission cap. The indicative base is US$89/month before usage and tax. This local evidence does not establish Render capacity, and historical 5,000-human-game evidence is not a 5,000-AI-game result.

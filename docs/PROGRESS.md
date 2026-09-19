# BestWord progress

## Redeployment fix — 19 September 2026

Fixed a migration deadlock reported during the custom-domain redeployment. Already-applied schema changes are now skipped; deadlock retries are bounded, and checked-out PostgreSQL connection failures are handled. The current consolidated suite passes **252/252 tests in 113.99 seconds**; build, type checking and the compiled pre-deploy command under conflicting table locks also pass. See [the patch record](progress/2026-09-19-migration-redeploy.md). Browser and capacity results below are historical and were not rerun for this patch. No assistant GitHub push or public deployment was performed.

## AI release — 19 September 2026

The current update adds Easy/Medium/Hard server opponents, strategic NO WORDS, durable AI replay, stable Recent games pagination, signed-in replay access and the unchanged tutorial in shared help. The consolidated suite passes **245/245 tests**, Chromium **15/15**, and WebKit **13 with two explicit skips**. See [the current release record](progress/2026-09-19-ai-release.md) and [AI architecture/operation](AI.md). The older results below describe earlier human-only releases; they are not new AI capacity measurements.

The current [one-hour mixed AI test](progress/ai-capacity.md) also passed: ten AI games and one human table, 22,820 AI turns, 557 ms p95 completion, 313 MiB peak AI memory, zero errors or disconnections and every state/receipt/durability gate passed. Runtime hashes remained unchanged throughout. No Render deployment or purchase was performed.

## Rules and vocabulary complete

The original specification and exact dictionary are preserved. [DECISIONS.md](DECISIONS.md) records the implementation contract.

- Pure immutable engine: 112 tests, all five scoring examples and 1,100 randomized property cases pass.
- Rust minimal GADDAG and TypeScript reader: all 279,320 words and 2,544,319 transforms pass exhaustive verification, independent accepted-language/minimality audit, corruption checks and deterministic byte reproduction. Compressed artifact: 5,373,266 bytes.

## Server and browser implemented

Accounts, lobby, two-player games, scoring, clocks, live spectators, permanent PASS, public replay and outage recovery are implemented. Multiple API instances share PostgreSQL authority and Redis-compatible coordination. [ARCHITECTURE.md](ARCHITECTURE.md) describes the implementation.

The final consolidated run passed **175/175 tests in 113.47 seconds**. Its [JSON report](evidence/verification-175.json) includes 14 multi-gateway integration, 12 health and 14 real fault/resource cases. This includes the connection-join race found during the larger capacity setup, reproduced and fixed with a regression. See [server evidence](progress/server.md).

The final release Chromium/WebKit run passed all **11 enabled checks in 88.83 seconds**, with one deliberate WebKit skip for the Chromium-only acknowledgement fixture. It covers real games/replay, touch-only input, compression, lobby recovery, four viewport sizes including 320×568, uncertain acknowledgements and a one-hour page-clock adjustment. See the retained [release browser report](evidence/browser-release.json) and [client notes](progress/client.md).

## Operations and capacity verification

- Actual PostgreSQL 18.4 and Redis 7.2.16 run locally; restart persistence is verified.
- A real isolated logical backup/restore drill passed, preserving application tables, tile invariants, accepted receipts and pending notifications. See [backup evidence](progress/backup.md).
- Strict builds/type checks pass. The last dependency audit reported zero vulnerabilities.
- Render, Docker, Compose and CI configuration is prepared; deployment schemas and references validate. No services have been purchased or publicly deployed.
- The [full strict hour on final code](../tools/load/reports/2026-09-18T05-30-44-454Z-acceptance.json) passed with **1,200 maintained sockets** (100 simultaneous games and 1,000 spectators), **185,805 accepted commands**, **536,126 revision syncs** and **5,183 completed-game cycles**. Every receipt and all 5,283 saved game states verified, as did all 1,200 final viewer pushes and 62,196 retiring-viewer checks. All 59 bursts completed; service p95/p99 was 10.26/45.03 ms. Zero errors or disconnects; all child processes exited cleanly. Earlier runs remain in the capacity history.
- The [strict fifteen-minute scale trial](../tools/load/reports/2026-09-18T06-31-39-890Z-scale.json) passed with **5,000 simultaneous games, 2,500 spectators and 12,500 maintained sockets**. It accepted 226,400 commands (250 baseline/second plus fourteen 100-command bursts), performed 1,395,888 revision syncs and completed 1,964 game cycles. Every receipt and all 6,964 game states verified; durability, privacy and viewer-delivery gates passed. Zero errors or disconnects; all child processes shut down cleanly. See [capacity evidence](progress/capacity.md) for the explicit push/initialization distinction, resource use and exact limits. The [load guide](../tools/load/README.md) explains reproduction and report limitations.

No Render capacity or US$100-for-5,000-games claim has been established. Initial admission remains 100 games and 10 spectators per game.

## Environment limitations

Docker and WSL are unavailable. Local integration uses PostgreSQL and a community Redis Windows build; prepared CI targets PostgreSQL 18 and Valkey 8, but no hosted CI or Linux container run has executed. Chromium/WebKit pass; Firefox cannot launch because of a Windows side-by-side runtime error and remains unverified locally.

Local test subprocesses passed automatic sandbox approval. No user approval is pending. Source and completed local verification evidence are saved here; the environment limitations above remain explicit.



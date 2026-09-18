# BestWord progress

## Rules and vocabulary complete

The original specification and exact dictionary are preserved. [DECISIONS.md](DECISIONS.md) records the implementation contract.

- Pure immutable engine: 112 tests, all five scoring examples and 1,100 randomized property cases pass.
- Rust minimal GADDAG and TypeScript reader: all 279,320 words and 2,544,319 transforms pass exhaustive verification, independent accepted-language/minimality audit, corruption checks and deterministic byte reproduction. Compressed artifact: 5,373,266 bytes.

## Server and browser implemented

Accounts, lobby, two-player games, scoring, clocks, live spectators, permanent PASS, public replay and outage recovery are implemented. Multiple API instances share PostgreSQL authority and Redis-compatible coordination. [ARCHITECTURE.md](ARCHITECTURE.md) describes the implementation.

The final consolidated run passed **175/175 tests in 113.47 seconds**. Its [JSON report](evidence/verification-175.json) includes 14 multi-gateway integration, 12 health and 14 real fault/resource cases. This includes the connection-join race found during the larger capacity setup, reproduced and fixed with a regression. See [server evidence](progress/server.md).

The final combined Chromium/WebKit run passed all **11 enabled checks in 88.36 seconds**, with one deliberate WebKit skip for the Chromium-only acknowledgement fixture. It covers real games/replay, touch-only input, compression, lobby recovery, four viewport sizes including 320×568, uncertain acknowledgements and a one-hour page-clock adjustment. See the retained [combined browser report](evidence/browser-latest.json) and [client notes](progress/client.md).

## Operations and capacity verification

- Actual PostgreSQL 18.4 and Redis 7.2.16 run locally; restart persistence is verified.
- A real isolated logical backup/restore drill passed, preserving application tables, tile invariants, accepted receipts and pending notifications. See [backup evidence](progress/backup.md).
- Strict builds/type checks pass. The last dependency audit reported zero vulnerabilities.
- Render, Docker, Compose and CI configuration is prepared; deployment schemas and references validate. No services have been purchased or publicly deployed.
- The [completed hour-long local load test](../tools/load/reports/2026-09-18T04-14-00-701Z-acceptance.json) maintained **1,200 sockets** (100 simultaneous games and 1,000 spectators) for **3,600.008 seconds**, accepted **185,782 commands**, recorded **zero application errors**, and verified **5,282 snapshots** across successive game cycles. It used the report's recorded earlier compiled code, omitted eight-second periodic revision sync, and predates the stronger per-viewer final-push checks. It is historical local evidence, not a full current-client workload or a Render capacity measurement.
- The [strict five-minute scale trial](../tools/load/reports/2026-09-18T05-24-43-476Z-scale.json) passed with **5,000 simultaneous games, 2,500 spectators and 12,500 maintained sockets**. It accepted 75,400 commands (250 baseline/second plus four 100-command bursts), performed 465,330 revision syncs, verified every receipt and final viewer push, and recorded zero errors or disconnects. Child processes shut down cleanly. See [capacity evidence](progress/capacity.md) for resource use and exact limits.
- A full strict one-hour acceptance on final code is running, followed by a 900-second scale trial to exercise complete game cycles at 12,500 sockets. Outcomes remain pending. The [load guide](../tools/load/README.md) explains current gates and report limitations.

No Render capacity or US$100-for-5,000-games claim has been established. Initial admission remains 100 games and 10 spectators per game.

## Environment limitations

Docker and WSL are unavailable. Local integration uses PostgreSQL and a community Redis Windows build; prepared CI targets PostgreSQL 18 and Valkey 8, but no hosted CI or Linux container run has executed. Chromium/WebKit pass; Firefox cannot launch because of a Windows side-by-side runtime error and remains unverified locally.

Local test subprocesses have passed automatic sandbox approval. No user approval is pending. Source and evidence are saved here; work continues through capacity verification.



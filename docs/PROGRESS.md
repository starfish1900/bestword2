# BestWord progress

## Rules and vocabulary complete

The original specification and exact dictionary are preserved. [DECISIONS.md](DECISIONS.md) records the implementation contract.

- Pure immutable engine: 112 tests, all five scoring examples and 1,100 randomized property cases pass.
- Rust minimal GADDAG and TypeScript reader: all 279,320 words and 2,544,319 transforms pass exhaustive verification, independent accepted-language/minimality audit, corruption checks and deterministic byte reproduction. Compressed artifact: 5,373,266 bytes.

## Server and browser implemented

Accounts, lobby, two-player games, scoring, clocks, live spectators, permanent PASS, public replay and outage recovery are implemented. Multiple API instances share PostgreSQL authority and Redis-compatible coordination. [ARCHITECTURE.md](ARCHITECTURE.md) describes the implementation.

The consolidated run passed **174/174 tests in 113.82 seconds**. Its [JSON report](evidence/verification-174.json) includes 13 multi-gateway integration, 12 health and 14 real fault/resource cases. See [server evidence](progress/server.md).

Eight Chromium/WebKit browser checks passed against the compiled application: real games/replay, touch-only input, compression, lobby recovery and four viewport sizes including 320×568. A separate Chromium acknowledgement fixture verified safe retry and retained pending state after a real committed move. A final local-clock adjustment check is in progress. [Client notes](progress/client.md) record the latest results.

## Operations and capacity verification

- Actual PostgreSQL 18.4 and Redis 7.2.16 run locally; restart persistence is verified.
- A real isolated logical backup/restore drill passed, preserving application tables, tile invariants, accepted receipts and pending notifications. See [backup evidence](progress/backup.md).
- Strict builds/type checks pass. The last dependency audit reported zero vulnerabilities.
- Render, Docker, Compose and CI configuration is prepared; deployment schemas and references validate. No services have been purchased or publicly deployed.
- The one-hour, 1,200-connection load test is running. That run measures commands, presence and broadcasts, excludes periodic revision sync and records exact compiled-code hashes. A sync-inclusive trial and actual 5,000-game scenario remain. Reports are under tools/load/reports.

No Render capacity or US$100-for-5,000-games claim has been established. Initial admission remains 100 games and 10 spectators per game.

## Environment limitations

Docker and WSL are unavailable. Local integration uses PostgreSQL and a community Redis Windows build; prepared CI targets PostgreSQL 18 and Valkey 8, but no hosted CI or Linux container run has executed. Chromium/WebKit pass; Firefox cannot launch because of a Windows side-by-side runtime error and remains unverified locally.

Local test subprocesses have passed automatic sandbox approval. No user approval is pending. Source and evidence are saved here; work continues through capacity verification.


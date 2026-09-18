# BestWord progress

## Milestone 1 — rules and dictionary complete
- The original specification and exact dictionary are preserved. Implementation decisions are in DECISIONS.md.
- Pure immutable engine:112 tests pass, including all five scoring examples and1,100 randomized property cases.
- Rust minimal GADDAG builder and TypeScript reader:279,320 dictionary words and2,544,319 transforms exhaustively verified, independent accepted-language/minimality audit, deterministic binary, corrupted-input checks. Compressed artifact5,373,266bytes.

## Milestone 2 — working server and client
- Strict TypeScript server/client builds pass. npm audit reports0 vulnerabilities (2026-09-18).
- Real portable PostgreSQL18.4 and Redis7.2.16 run locally; restart persistence verified. Production targets managed PostgreSQL18 and Valkey8.
- Nine real multi-gateway HTTP/WebSocket tests pass: account security, competing joins, authoritative valid moves, idempotent retries, concurrent turns, private projections, permanentPASS, clocks, multiple tabs, outbox retries, gateway deployment/recovery.
- Eleven focused health tests pass against real services: commit ambiguity, checkpoint races, lock ordering, monotonic pause time, incident handling, idempotent shutdown.
- Real Chrome end-to-end game passes: two accounts, matching, valid keyboard move, invalid draft correction, NO_WORDS, PASS, spectator view, completed replay. Four viewport checks including320x568 have no page overflow. Client unit tests pass.
- API instances take over deadline processing when the worker stops. Private broadcasts target currently valid session rooms. Command acknowledgements follow database commit; outbox retirement waits for Redis stream writes.

## Milestone 3 — hardening and operational verification in progress
- Real network-failure tests for PostgreSQL/Redis are being added using isolated test proxies.
- Render/Docker/CI/operations artifacts are being prepared. No paid service or public deployment has been created.
- Load driver and capacity measurements remain in progress. No5,000-game capacity claim has been established; a US$100 monthly deployment has not been benchmarked.
- Final cross-browser checks, documentation, load evidence, and a fresh consolidated verification run remain.

## Environment limitations
- Docker and WSL are not installed here. Portable PostgreSQL and a community Redis Windows build are used for local integration; Valkey/container compatibility is also covered by prepared CI, which has not been executed remotely.
- Native build/test subprocesses require automatic sandbox approval; routine requests have succeeded. No user approval is pending.

Detailed evidence and exact commands are saved under progress/ and test output directories. Default tests skip service integration unless BESTWORD_INTEGRATION=1 is supplied.

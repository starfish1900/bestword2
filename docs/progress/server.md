# Server verification checkpoint

18 September 2026: **174/174 tests passed in 113.82 seconds** in the consolidated local run. The retained [JSON report](../evidence/verification-174.json) includes 112 engine, 12 lexicon, 11 client, 13 server integration, 12 health and 14 fault/resource tests. Later client-only additions and capacity checks have separate reports.

Service tests use real PostgreSQL 18.4 and Redis 7.2.16 with multiple gateways. Isolated PostgreSQL schemas and unique game/account IDs protect development data. Fault proxies affect only test-owned connections; process-kill cases terminate only a test-owned API child.

## Verified behavior

- Account hashing/cookies, unique names, rejected origins/inputs, logout and password/session revocation. A controlled login/password-change race rejects old credentials after revocation.
- Competing seek claims, one active playing slot, countdown, actual dictionary-backed placement, conflicting actions, invalid state preservation and original receipt replay after newer revisions.
- Spectator/public privacy, session-specific delivery despite lost revocation notifications, permanent PASS, frozen clocks, released slots, multiple tabs and serialized overlapping game subscriptions.
- Deadline adjudication after positive health evidence, overdue pre-start cancellation, API scheduling without a worker, durable outbox retry and deployment recovery without redrawing.
- PostgreSQL/Redis interruptions with only 1.5 seconds left on the next clock preserve acknowledged board/rack/draw state and resume without a false loss.
- Half-open Redis replies and chained batches reject promptly; oversized batches cannot leave a poisoned partial MULTI connection.
- Half-open PostgreSQL reads and unanswered rollback remain bounded. Uncertain clients are discarded and locks become available. A nine-second traffic blackhole preserves the game and near-zero clock.
- Abrupt API death preserves acknowledged receipts/draws. Fresh terminal requests cannot grow receipts; request-triggered expiry still commits the finished game transition.

Health tests additionally cover ambiguous COMMIT, checkpoint races, consistent lock ordering, monotonic pause time, actual PONG validation, incident handling and idempotent shutdown.

## Reproduction and scope

Set BESTWORD_INTEGRATION=1, DATABASE_URL and REDIS_URL to dedicated local test services, then run:

```sh
npm test -- --reporter=default --reporter=json --outputFile=.local/test-results/consolidated.json
```

Without BESTWORD_INTEGRATION=1 the service cases are deliberately skipped. A default unit-test run is not the complete suite.

PostgreSQL locks each game independently; admission uses a separate short lock. API/worker scheduling uses short SKIP LOCKED claims. Redis leases recover missed disconnect callbacks. Game notifications contain only ID, revision and finished flag; actual stream writes precede outbox retirement. Interested gateways fetch current state and emit local private/public projections, selecting valid sessions before private delivery. Blocking readers and ordinary commands have separate reconnect/timeout behavior.

This establishes local functional and failure-path behavior, not Render capacity, regional recovery or a monthly cost guarantee. See [backup evidence](backup.md), [architecture](../ARCHITECTURE.md) and [load evidence](../../tools/load/README.md).


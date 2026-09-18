# Engine progress

Implemented the pure TypeScript game snapshot, seeded setup and persisted consonant draw order, complete placement validation/scoring, PASS/NO_WORDS, authoritative integer clocks, connection deadlines, service pause/recovery and privacy projections. API coordinated with root before implementation.

Tests cover all five exact examples, 44 draw capacity/exhaustion combinations, setup/move tile conservation, randomized bridge/coordinate properties, word validation, timeout boundaries, disconnect ties, outage recovery and projection privacy. Snapshot transitions and public projections isolate move records and private arrays.

Executed evidence (2026-09-18): `npm exec tsc -- -b packages/engine` passed. `npm exec vitest -- run packages/engine/test/engine.test.ts` passed **112/112 tests**, including 1,100 randomized setup, placement and game-sequence property cases. Latest measured test run:343ms total,110ms test execution. Native test subprocess execution required sandbox escalation; permission was granted. These are rules/unit/property checks, not production throughput or infrastructure recovery evidence.

API addition: `restartRecovery(state, now, reason)` is for a newly identified infrastructure incident during an existing recovery window. It preserves frozen clocks and draws, clears readiness and the recovery deadline, and lets `beginRecovery` start a fresh120seconds once service is healthy. The server deduplicates incident IDs; repeat scans must not repeatedly reset recovery.

No network or filesystem operations occur in the engine. `dueOutcome` only returns an outcome candidate; the server establishes infrastructure health before `adjudicate`. Duplicate-command handling remains the server's responsibility.

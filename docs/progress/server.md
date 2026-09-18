# Server verification checkpoint

2026-09-18: strict server build passes. The9-test integration suite passes against PostgreSQL18.4 and Redis7.2.16 with two Fastify/Socket.IO gateways and no dedicated worker. It creates and removes a unique PostgreSQL schema, uses unique account/game IDs, and never truncates the user's development database. Socket traffic really crosses the Redis Streams adapter.

Verified: secure account hashing/cookies and logout; unique names; rejected origins/inputs; two simultaneous seek claims; one active playing slot; automatic countdown; actual dictionary-backed placement; invalid state preservation; original command receipts after newer revisions; conflicting simultaneous actions; spectator/public history privacy; permanentPASS and frozen clock; near-zero clock adjudication; multiple-tab readiness; committed outbox retry; gateway deployment pause and durable restart without redrawing.

Command: `BESTWORD_INTEGRATION=1 DATABASE_URL=<local test database> REDIS_URL=<local Redis> npm test -- apps/server/src/integration.test.ts` (set environment variables using the syntax for your shell). Result:9 passed,24.97seconds total. Focused health test evidence is maintained separately by the health review.

These tests do not establish Render capacity, whole-region recovery, backup restoration, or a monthly cost guarantee. Real dependency network-failure tests and load measurements are a subsequent milestone.

Implementation notes: PostgreSQL serializes only each game's state, with a separate short admission lock for the account/cap constraints. API processes and the worker share short SKIP LOCKED scheduling claims. Redis leases reconcile lost disconnect callbacks. Session-specific game rooms are selected from current database sessions before each private broadcast. Adapter XADD promises are observed so a swallowed Socket.IO publication error leaves the PostgreSQL outbox available for retry.

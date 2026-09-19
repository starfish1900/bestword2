# Isolated mixed AI load run

Build the app, start the task-local PostgreSQL/Redis services, then run:

```sh
npx tsx tools/ai-load/run.ts 1 120
npx tsx tools/ai-load/run.ts 2 120
npx tsx tools/ai-load/run.ts 5 120
npx tsx tools/ai-load/run.ts 10 120
npx tsx tools/ai-load/run.ts 10 3600
```

Arguments are simultaneous AI games (1–10) and duration in seconds. Select the one-hour concurrency from passing probes. Each run also maintains one human-versus-human game. Hard is used at concurrency one; larger runs rotate Hard, Easy and Medium. Fixture humans play legal moves with a bounded test helper, deliberate NO WORDS turns, and a minimum 1.5-second think time. Finished games are replaced through the real admission endpoint. Search runs in a separate production AI process with one search thread; on Windows that entire process is pinned to one logical CPU before startup. The report confirms whether affinity was applied. The real API maintains sockets, authentication, clocks, jobs and persistence.

This runner only connects to loopback PostgreSQL port 54329 and Redis port 6389. It creates a unique schema and atomically reserves an empty nonzero Redis database. It refuses to clear existing data. Cleanup removes only its own schema and `bw:*` keys after checking its ownership token. Do not kill it forcibly during cleanup. Creating a `STOP` file in the current report directory requests a graceful stop.

Reports and logs are saved under `tools/ai-load/reports/`, updated every 15 seconds. They include job timestamps (queue plus search plus commit), strategy summaries, separate API command latency, process RSS/CPU samples and source artifact hashes. Only actually completed runs establish evidence. Short probes with fewer than 20 accepted AI turns do not pass the sampling gate.

Acceptance: at least 95% of AI turns committed within five seconds, no unfinished turn aged five seconds or more at the end, API command processing p95 below 250 ms and p99 below 750 ms, AI RSS below 70% of 2 GiB, no errors, disconnects or unexpected forfeits, valid engine snapshots, and exact AI job/move/receipt correspondence. All child processes must exit cleanly. Duration is measured before shutdown and excludes verification/cleanup. Failed gates produce a nonzero exit code. Inspect the time series for sustained memory growth. Separate integration tests exercise recovery, lease fencing and duplicate delivery.

The desktop CPU, database, Redis, driver and browser tests share hardware. This is not a constrained Render benchmark or a guarantee that the production plan supports the same concurrency. Repeat measurements on the selected Render sizes before raising production admission.

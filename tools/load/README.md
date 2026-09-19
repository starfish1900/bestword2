# Local multiplayer load driver

This driver exercises real Socket.IO clients, separate API child processes, a worker, PostgreSQL and Redis-compatible transport. It never contacts Render and cannot establish Render capacity. Run it only against the project's local test services; it refuses remote URLs and other service ports.

Build first and start local dependencies:

```sh
npm run build
node tools/dev/services.mjs start
npm run test:load -- --scenario smoke
```

The default smoke run uses 4 games, 8 spectators, 4 commands/second, 4-command bursts and 45 seconds. The normal acceptance preset uses 100 games, 1,000 spectators, 50 commands/second, an extra 100-command burst every minute, two API processes, one worker and one hour. The larger **configured** scenario uses 5,000 games, 2,500 spectators and 250 commands/second; run it only when the test machine has enough capacity. Merely having that scenario is not evidence it passed.

```sh
npm run test:load -- --scenario acceptance
npm run test:load -- --scenario scale
npm run test:load -- --scenario acceptance --duration 120
```

Overrides: `--duration`, `--games`, `--spectators`, `--rate`, `--burst`, `--apis`, `--workers`, `--sync`. Current presets include jittered revision-aware sync every 8 seconds per socket; `--sync 0` disables it. Reduced runs are labeled `fullPreset: false`; they cannot stand in for the full acceptance duration. The `scale` rate is an explicit workload choice, not an estimate of real player behavior. Do not compare runs with different shapes without stating the difference. Reports generated before this option was added, including the hour run started at 04:14 UTC on 18 September, measure commands, presence and broadcasts with no periodic revision-sync traffic.

The default test endpoints are PostgreSQL `127.0.0.1:54329`, database/user `bestword`, and Redis `127.0.0.1:6389`. The driver deliberately ignores ordinary `DATABASE_URL` and `REDIS_URL` so a production `.env` cannot redirect it. Optional `BESTWORD_LOAD_DATABASE_URL` and `BESTWORD_LOAD_REDIS_URL` are subject to the same strict local fixture checks. The portable Windows Redis service has a 128 MB limit shared across its logical databases; Render's proposed Key Value instance has 256 MB. The report records actual dependency versions and memory configuration.

Each run creates a random `bw_load_...` PostgreSQL schema and atomically claims an empty nonzero Redis logical database. It does not flush DB0, truncate the application schema, stop the portable dependencies, alter credentials or open public listening ports. Cleanup removes only its generated schema and the `bw:*` keys in its still-owned reserved database, after its server processes stop. An interrupted/crashed runner can leave that isolated schema/database behind; inspect the report's identifiers and confirm its processes have stopped before cleaning those fixtures. Never use a broad shared-database flush as cleanup.

To stop cleanly, create an empty file named `STOP` in the run's `.local/load/<run>/` directory; the runner checks every second, drains in-flight work, verifies acknowledged data and cleans its fixtures. It also stops if sampled total memory in the shared local Redis server reaches 100 MB, leaving headroom below the portable service's 128 MB limit, or if free host memory falls below 1 GiB during connection setup or a measurement sample. A safety stop produces a partial result, not an acceptance pass.

## What is measured

Before timing, the driver builds deterministic, legal full-game sequences with the real engine and GADDAG. Every template includes actual placed words, NO_WORDS when eligible, and terminal PASS actions. It seeds test accounts, sessions and active starting positions directly, then sends the real commands through authenticated WebSockets. When a game finishes, it creates a fresh game ID for the same participants and moves its spectators. Replacing games contributes database/subscription work during timing; signup/login, lobby admission and the initial countdown are excluded. These paths have separate functional tests.

Players in each game connect to different API processes. The application uses its usual cross-process adapter, durable transactions, presence, health checks and background deadlines. Revision sync tracks the last revision received by each individual socket and runs with staggered timing. Every hundredth accepted command is retried with the same ID to check idempotent acknowledgement. The driver checks public/spectator projections for private fields, tracks disconnects and records wire update counts. At the end it checks every acknowledged durable receipt, exact total snapshot move count, game invariants and absence of unexpected forfeits.

Reports are saved under `tools/load/reports/` every 15 seconds and at completion. Child logs are under `.local/load/<run>/`. The report includes:

- Actual hardware, dependency versions, hashes of the compiled server/shared modules and dependency lockfile, settings and elapsed duration. Hashes are captured before launching server children; later local rebuilds do not replace their already-loaded modules.
- Initial/end socket counts, actual command throughput, action mix, bursts, game cycles and errors.
- End-to-end acknowledgement p50/p95/p99 and separately instrumented `Games.command` duration through commit/publication. Authentication and network overhead are outside that service-duration measurement.
- Separate baseline and burst offered/accepted counts, required burst count, offered-load duration and command/viewer drain times. The baseline throughput gate explicitly allows a 5% shortfall; burst traffic cannot compensate for missing baseline traffic. Socket gates require initial, final and minimum observed/sample counts to meet the target.
- Per-socket `game:update` revisions, independent of command and sync acknowledgements. Before recycling a completed game, every viewer must receive its terminal revision through a push within ten seconds. After commands stop, a ten-second quiescent check requires every current viewer of a game with moves to receive the final database revision through a push. Fresh zero-move fixtures are reported separately as initialization snapshots. The push-latency histogram measures the first received push for each observed move revision against its database acceptance time, using 1 ms bins; it is separate from command timing and does not establish delivery of every intermediate revision when snapshots are coalesced.
- API/worker process RSS, CPU use, database pool waiters, game/outbox samples, overdue maintenance checks and deadlines, and load-client scheduling delay.
- Application-level Engine.IO incoming bytes. This is not a Render-billable bandwidth measurement.
- Individual capacity gates and durable verification. Current runs exit nonzero when an operational gate fails. `fullPreset: false` is descriptive and does not fail a deliberately shortened run. Older reports predate this exit behavior, so always inspect their individual gates.

Current format-version-2 reports include the stronger gates and observations above. Wire checks validate field allowlists, game/player identity and exact private rack letters/order and draw counts against the deterministic engine predictions. Older format-version-1 reports generated before these observation checks were added used only simpler field/seat checks and aggregate fanout counts. In particular, the hour run started at 04:14 UTC did not verify each viewer's final push revision or measure push-delivery latency. Do not infer that evidence from its command acknowledgements.

Current guest spectators receive only the latest three turn summaries, opening-word history, tile contributor colors and last-move tile highlights. The driver verifies those fields against the deterministic sequence and rejects any guest full-move history or private data. `moveCount` identifies the authoritative sequence position even when `moves` is empty; latest public summary timestamps preserve push-delivery latency measurements for guests as well as players. Signed-in players retain complete move history. The human-only workload and its durable/freshness gates are unchanged.

The load clients and local dependencies share the test machine with the servers. Large scheduler lag means the driver itself may be limiting the offered load. A long run with fewer commands or sockets than requested is not a successful capacity test. Use dedicated load-client hardware and repeat against the proposed paid topology before making hosting capacity claims. A separate production-capable remote runner would require explicit authorization and additional safeguards; this tool intentionally has none.

A large Windows run can fail while opening client sockets because of local memory, handle or ephemeral-port limits. The report records the failure phase, attempted/successful connections, peak connected sockets and available transport error codes. A startup failure has no valid steady-state latency measurement; do not label it a server throughput result. The runner drains its bounded setup tasks before cleaning fixtures, and shuts down servers gracefully before removing client connections.

The load-only sources can be checked with `npx tsc -p tools/load/tsconfig.json`. No load fixtures or instrumentation are included in the production Docker image.

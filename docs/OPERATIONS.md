# BestWord operations

This repository contains deployment configuration for review. No Render resources have been created, no public deployment has been performed, and no cloud capacity has been measured. Applying `render.yaml` creates billable resources. Perform the checks below before authorizing a release.

## Runtime and deployment shape

The same Node 24 container runs two roles: the API serves the React application, HTTP endpoints and Socket.IO WebSockets; a continuous worker processes deadlines, presence and durable notification retries. PostgreSQL 18 owns accounts, sessions, game snapshots, events and accepted-command receipts. Render Key Value provides Valkey 8 transport/presence. The compressed GADDAG is built offline and included in the image; startup verifies it once per process.

The image runs as the unprivileged `node` user. Its direct Node entry point receives termination signals. It needs no persistent application disk: PostgreSQL and Key Value own persistence. Keep all services in Virginia so internal connections use Render's private network. A new or reconnected WebSocket can reach any API instance; websocket-only transport and the shared Streams adapter avoid a sticky-session dependency. Deployments and maintenance still disconnect sockets. [Render regions](https://render.com/docs/regions), [WebSockets](https://render.com/docs/websocket), [Docker services](https://render.com/docs/docker).

The API's `APP_ORIGIN` defaults to its Render-provided HTTPS URL. For a custom domain, explicitly set `APP_ORIGIN` to its exact HTTPS origin, without a path or trailing slash, and direct players to that origin. All browser traffic and cookies use that origin. Never put database URLs or metrics credentials in Vite/client environment variables. [Render default environment variables](https://render.com/docs/environment-variables).

## Initial cost and admission settings

Prices checked on 18 September 2026. Recheck the creation preview before provisioning.

| Component | Render plan | Monthly base |
|---|---|---:|
| API, 1 CPU / 2 GB | `1c-2g` | US$25 |
| Worker, fractional CPU / 512 MB | `0.5c-512mb` | US$7 |
| PostgreSQL, fractional CPU / 1 GB | `0.5c-1g` | US$19 |
| PostgreSQL storage, 10 GB | $0.30/GB | US$3 |
| Key Value, 256 MB | `256mb` | US$10 |
| Hobby workspace | Hobby | US$0 |
| **Total before usage and tax** | | **US$64** |

The Blueprint uses one API and one worker, manual deployment, no preview resources, and fixed database storage. A Pro workspace would add $25/month. The $100 target leaves $36 for usage and tax on Hobby; it is not a hard billing ceiling. [Render pricing](https://render.com/pricing), [current compute-plan identifiers](https://render.com/docs/compute-plans).

Hobby currently includes 5 GB outbound bandwidth per month, then charges $0.15/GB. WebSocket messages and downloaded application assets count. A hypothetical 12,500 connected people receiving an average of just 100 bytes/second continuously for 30 days produces about 3.24 TB outbound and approximately $485 excess bandwidth alone, before protocol overhead. Short peaks and sustained concurrency have different costs. [Outbound bandwidth](https://render.com/docs/outbound-bandwidth).

Set the workspace's additional build-pipeline spending limit to zero if avoiding build overages is required; this limit applies to build minutes, not the entire invoice. Review actual usage frequently during launch, including storage growth. The Blueprint disables storage autoscaling to keep the base size explicit; reaching that fixed size can make the database unavailable, so alert before it fills. [Build-pipeline billing](https://render.com/docs/build-pipeline), [PostgreSQL storage](https://render.com/docs/postgresql-creating-connecting).

`MAX_ACTIVE_GAMES=100` and `MAX_SPECTATORS_PER_GAME=10` are conservative admission settings, not measured supported capacity. Do not advertise 5,000 simultaneous games at this price. Raise limits only after the capacity gate below passes on the actual proposed service sizes.

## Local canonical environment

With Docker and Compose already available:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

Open `http://localhost:3000`. Containers use their internal PostgreSQL and Valkey hostnames; host tooling can use `postgresql://bestword:bestword-local@127.0.0.1:54329/bestword` and `redis://127.0.0.1:6389`. These credentials are local fixtures. All published ports bind to loopback.

The one-shot migration container completes before API and worker startup. Named volumes preserve state. PostgreSQL 18's volume mounts `/var/lib/postgresql`, which contains its versioned data directory. Valkey uses append-only persistence. [Official PostgreSQL image](https://github.com/docker-library/docs/tree/master/postgres), [official Valkey container](https://github.com/valkey-io/valkey-container).

```sh
docker compose stop
docker compose start
```

Stop preserves data. Do not remove the named volumes to restart or update the game. For rebuilding, repeat `docker compose up --build -d`.

The Windows portable services use the same host ports. Stop application clients, then run `node tools/dev/services.mjs stop` before starting Compose. Do not run the two database stacks simultaneously on those ports. Portable local validation uses real PostgreSQL 18.4 and **Redis 7.2.16**; it is Redis-compatibility evidence, not evidence that Valkey itself was exercised locally. CI and Compose specify Valkey 8.

## Release procedure

1. Run CI: strict type checking, production build, unit/property tests, real database integration tests, Chromium/Firefox/WebKit tests, lexicon reproduction, and complete container startup. Inspect failures and retained browser traces. A configured job is not evidence of a completed run.
2. Check `data/lexicon-manifest.json` against the intended corpus. The original corpus SHA is `87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af`. Do not rebuild vocabulary during application startup or change it during active games.
3. Validate the Blueprint using `python deployment/validate.py`; Render's authenticated CLI validation may additionally check platform semantics. Inspect the reviewed Blueprint creation preview, region, account plan and prices. Ensure the repository root is this `bestword` directory, which contains `Dockerfile` and `render.yaml`.
4. On the separately authorized first deployment, create the Blueprint. It supplies internal connection strings and generates `METRICS_TOKEN`. Datastores reject public connections through empty `ipAllowList` settings. Preserve private credentials in Render, outside Git.
5. Confirm `/health/ready` reports HTTP 200 and the expected corpus SHA. Create two test accounts, join a game, make an accepted move, reconnect both clients, and verify history. Exercise a controlled API restart with a running game and validate pause/recovery before opening admission to real players.
6. Record the Git revision, image/base versions, lexicon SHA, migration version, service sizes, validation results and release time. Keep the preceding working revision available for rollback.

Manual deployment is the default (`autoDeployTrigger: off`). The API pre-deploy command runs `node apps/server/dist/migrate.js`; both roles also run idempotent migrations on startup under a PostgreSQL advisory transaction lock. New migrations must remain compatible with both old and new processes during overlap. Deploy additive changes first and remove obsolete columns only in a later release after all old processes stop. [Blueprint reference](https://render.com/docs/blueprint-spec).

Deploy the API and worker from the same reviewed revision. The API's readiness endpoint excludes instances that have lost dependency health. The 60-second termination allowance gives processes time to record a deployment incident and close connections; it cannot promise an uninterrupted WebSocket. Existing game recovery is the mechanism for that interruption. A rollback must be compatible with the current schema and saved game format; never automatically reverse a migration or discard accepted moves just to start old code.

## Monitoring and incident response

`GET /health/live` confirms the process responds. `GET /health/ready` also requires recent dependency health and a loaded lexicon. Production `GET /metrics` requires `Authorization: Bearer <METRICS_TOKEN>`; it reports game counts, process RSS, socket count, database-pool waiters and readiness. Keep its token in the monitoring system's secret store. Monitor API and worker logs as well as managed-datastore metrics.

Useful read-only database checks, using milliseconds from the database clock:

```sql
SELECT status, count(*) FROM games GROUP BY status;
SELECT count(*) AS pending_notifications,
       extract(epoch FROM clock_timestamp()) * 1000 - min(created_at) AS oldest_ms
FROM outbox;
SELECT kind, status, count(*) AS epochs, max(last_healthy) AS newest_checkpoint_ms
FROM service_epochs GROUP BY kind, status;
SELECT reason, started_at, recovered_at FROM incidents ORDER BY started_at DESC LIMIT 20;
```

Initially investigate sustained API/worker CPU above 70%, RSS above 75% of its limit, nonzero database-pool waiters, increasing outbox age, unhealthy checkpoints, Key Value memory above 70%, or database storage above 70%. These are operational starting thresholds to tune from measurements. Track command processing and end-to-end acknowledgement latency separately; the basic `/metrics` endpoint does not currently export command latency histograms.

For an ordinary player's network loss, the server starts the 25-second allowance when it detects the loss. The active clock keeps running. A healthy second game tab prevents disconnection, and a player who permanently passed has no further clock/disconnect exposure. For a loss deadline, equality belongs to the deadline, using database acceptance time. Repeated command IDs return their stored response before new deadline checks.

Infrastructure is different. An API epoch checkpoints dependency health every second. A deadline needs positive health evidence after it before becoming a loss; missing evidence postpones adjudication, and a three-second checkpoint gap confirms an incident. Affected games pause at a trustworthy checkpoint, clamped after their latest accepted transition. A spectator-only gateway failure does not pause unrelated participants' games. On database recovery the process records the incident before a new healthy checkpoint or overdue adjudication.

After dependencies recover, active participants have up to 120 seconds to return. Both must be ready before the short countdown resumes the clocks; if someone remains absent the game ends without a winner. Passed participants need not return. Do not manually advance clocks, replay a new random draw, clear command receipts, or decide a winner from an offline client's timer. Ordinary process recovery retains committed snapshots and receipts; clients retry uncertain commands with the same ID and synchronize revisions.

When investigating a dependency incident, establish whether PostgreSQL, Key Value, one API, or the worker is unhealthy. Restore the dependency, inspect incidents/outbox/epochs, and verify an affected game recovers correctly before increasing admission. A Key Value restart can lose its most recent second of transport writes even with journaling; PostgreSQL and its outbox remain the authority for accepted gameplay. [Key Value persistence](https://render.com/docs/key-value).

## Backup and recovery

Paid Render PostgreSQL includes continuous point-in-time recovery, currently three days on Hobby and seven days on Pro or higher. Recovery creates a new database, which must be validated before switching clients. Render currently excludes recovery points within ten minutes of the present. A historical restore can lose accepted actions after the selected recovery point; this is a disaster-recovery limitation and differs from restarting an application against its existing durable database. [Render backups and recovery](https://render.com/docs/postgresql-backups).

Before a schema-changing release, confirm a recent recoverable point and save an access-controlled logical export through Render's database recovery/export interface. Establish an external encrypted export retention policy appropriate to the project; no backup automation or external storage has been provisioned by this repository. Backups include accounts, password hashes, private racks and sessions. Restrict access, encrypt copies, and never attach a production dump to a public issue.

For a local restore drill, use the database container's `pg_dump`/`pg_restore`, keeping the dump inside the container until copying it as a file. This avoids Windows shell text redirection corrupting a custom-format binary dump:

```sh
docker compose exec -T postgres pg_dump -U bestword -d bestword -Fc -f /tmp/bestword.dump
docker compose cp postgres:/tmp/bestword.dump .local/bestword.dump
docker compose exec -T postgres createdb -U bestword bestword_restore_drill
docker compose exec -T postgres pg_restore -U bestword -d bestword_restore_drill --no-owner --exit-on-error /tmp/bestword.dump
docker compose exec -T postgres psql -U bestword -d bestword_restore_drill -c "SELECT count(*) FROM games;"
```

Use a unique new drill database name if that name already exists. Compare account counts, migration versions, event revisions, command receipts and representative replay results. A successful export alone is not a tested backup.

For production disaster recovery, first stop public admission and all API/worker processes. Restore into a new isolated database; retain the failed database for investigation. Validate the recovery point and data integrity before updating connection strings. Invalidate restored sessions before reopening because an old backup can resurrect previously revoked sessions. Historical active games require an explicit no-winner reconciliation: do not silently resume older clocks or accept old commands against a rewound board. There is currently no one-click disaster-restore/admin reconciliation command; this requires a reviewed maintenance change and verification of snapshots, events, receipts and playing slots before production cutover. Rehearse that procedure in isolation before claiming a recovery-time objective.

Keep the same vocabulary artifact when restoring historical data. Restart both roles against the validated database and healthy Key Value, verify history and private/public projections, then reopen admission. Document any acknowledged actions absent from the recovery point. The starter configuration has no automatic PostgreSQL high-availability replica and no measured disaster-recovery time guarantee.

## Capacity and scaling gate

Run the load driver against an isolated test database and report the machine/service sizes, versions, duration, socket counts, command mix, connection failures, command latency percentiles, process RSS, datastore load and bandwidth. A single laptop also running the load clients cannot establish Render capacity.

The initial acceptance target is 100 games, up to 1,000 spectators, 1,200 sockets, 50 commands/second, 100-command bursts and a one-hour run. Target server processing p95 below 250 ms and p99 below 750 ms with no accepted-command loss, duplicate application, privacy leakage or false outage forfeits. Confirm the workload actually sustained its target and track end-to-end delay separately. Run process kill, dependency interruption, reconnect and duplicate-command tests as separate correctness checks; an idle-socket count is not a gameplay benchmark.

The larger scenario is 5,000 simultaneous games and 2,500 spectators. Progress in measured steps and cap admission at the last passing level. Measure database transaction/JSON write cost and worker deadline lag before adding API instances. Redis/Valkey connections are per server/adapter rather than one per browser; still monitor its actual limits and stream memory.

Raise API/worker memory or CPU when measurements identify that bottleneck. Raise database resources when transaction latency, CPU, I/O or connection headroom identifies it. With a 100-connection database, account for every API's configured pool, workers, deployment overlap and operator connections before adding instances; the initial pools are 10 and 5. Manual horizontal scaling is available on Render; automatic horizontal scaling requires an eligible workspace plan. New sockets distribute across instances and reconnect may change the selected instance. [Scaling](https://render.com/docs/scaling), [PostgreSQL connection pooling](https://render.com/docs/postgresql-connection-pooling).

Keep autoscaling disabled while operating under the initial budget target. Raising admission or instance counts is a reviewed configuration change with a revised cost estimate and a new capacity report. Hosting 5,000 games remains a scale target until tests demonstrate it on the specific paid infrastructure.

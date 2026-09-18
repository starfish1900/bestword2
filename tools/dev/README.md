# Portable local test services

These helpers start actual PostgreSQL and Redis processes for local integration
and browser tests. They do not install system services, edit global configuration,
change PATH, or delete an existing database. Native child windows are hidden.

```sh
node tools/dev/services.mjs bootstrap
node tools/dev/services.mjs status
node tools/dev/services.mjs stop
```

With application clients stopped, `node tools/dev/verify-services.mjs` exercises
repeated starts, graceful stops and restarts, verifies that SQL/Redis test values
survive, removes only its own probe values, and leaves the services running. Its
machine-readable result is `.local/service-check.json`.

`start` is an alias of `bootstrap`: initialize a cluster only if no existing
cluster is present, start missing processes, create the `bestword` database if
needed, and verify both services. It is safe to run repeatedly. `foreground`
starts the same services and waits; Ctrl+C stops them gracefully while preserving
data. A normal detached `start` requires the explicit `stop` command afterward.

Connections:

- `postgresql://bestword:bestword-local@127.0.0.1:54329/bestword`
- `redis://127.0.0.1:6389`

The database uses SCRAM password authentication. Redis deliberately has no local
password; both services bind only to loopback. These fixed development credentials
must not be used in production.

PostgreSQL binaries come from the installed `embedded-postgres` platform package.
On this Windows task, Redis comes from the previously checksum-verified portable
Redis 7.2.16 MSYS2 download under the task's `work/tools` directory. Set the
process-local `BESTWORD_REDIS_BINARY` environment variable to use another portable
Redis-compatible executable. No Redis binary is included in the application
deliverable. Native Redis/Valkey can be used on Linux/macOS with the same override.

Data and logs stay in this checkout's ignored `.local/` folder:

- PostgreSQL: `.local/postgres/`; logs `.local/logs/postgres.log` and `initdb.log`.
- Redis: `.local/redis/` with append-only persistence; log `.local/logs/redis.log`.
- Process ownership records: `.local/services.json`. The scripts check PostgreSQL's
  actual data directory and Redis's unique run ID before stopping a process.

For MSYS2 Redis, `pid` is the Windows process ID and `reportedPid` is Redis's
internal MSYS process ID; these may differ. Normal shutdown uses Redis's own
shutdown command, not an OS process kill.

Compatibility evidence is specifically **PostgreSQL 18 and Redis 7.2.16**.
Production targets Render Valkey 8. Passing these local Redis tests does not
establish that Valkey itself, Render networking, or paid production capacity was
tested.

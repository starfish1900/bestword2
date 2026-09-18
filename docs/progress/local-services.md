# Local service preparation

Implemented `tools/dev/services.mjs` with bootstrap/start, foreground, status and
stop commands. It uses the installed embedded PostgreSQL binaries directly and
the task-local portable Redis executable. Both bind to loopback; child windows
are hidden; data lives under the checkout's `.local/` folder. Existing data is
never recursively removed or reinitialized. Stops verify process ownership and
request graceful persistent shutdown.

## Verified and running

- PostgreSQL **18.4**, real server query successful. URL:
  `postgresql://bestword:bestword-local@127.0.0.1:54329/bestword`.
- Redis **7.2.16**, real `PING`, `INFO`, `SET`, and `GET` successful. URL:
  `redis://127.0.0.1:6389`.
- At readiness handoff: PostgreSQL master Windows PID **17276**; Redis Windows
  PID **7920**, internal MSYS PID **1565**. PIDs can change on subsequent restarts;
  `status` and `.local/services.json` are the current source of truth.
- Repeating start reused both running processes. Repeating stop was harmless.
- SQL and Redis probe values both survived a graceful stop/restart. The verifier
  removed only its own values afterward and left both services running.
- Verification completed at `2026-09-18T03:35:19.303Z`; full details are in
  `.local/service-check.json`.

Logs: `.local/logs/postgres.log`, `.local/logs/redis.log`, and `initdb.log`.
Durable development data: `.local/postgres/` and `.local/redis/`. Service metadata
and logs are local development artifacts and are ignored by version control.

The startup helper uses hidden native processes. `pg_ctl` performs PostgreSQL's
normal graceful start/stop; Redis receives `SHUTDOWN SAVE`. The control script
releases inherited startup pipes so a detached start exits normally.

The local compatibility claim is PostgreSQL 18.4 and **Redis 7.2.16**, not Valkey.
Render production targets Valkey 8 and still needs platform-specific staging
validation. No Docker/WSL installation, reboot, OS service registration, global
environment edit, public deployment, or purchase occurred.

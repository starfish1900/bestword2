# Isolated PostgreSQL backup and restore verification

The real custom-format backup/restore drill passed on 2026-09-18. It used PostgreSQL 18.4 on the local Windows x64 host and PostgreSQL 18.6 `pg_dump`/`pg_restore` clients. No development or user database was dumped, changed, or restored over.

Run evidence is saved in [the machine-readable report](../../tools/testing/reports/backup-restore-latest.json). The generated fixture source and restore destination were both dropped after verification, using exact generated names, matching database ownership, and a per-run ownership comment. Cleanup does not force-disconnect other users.

## What passed

- Every row in all 12 application tables and every relational constraint matched the source after restore.
- Two accounts and their session rows survived; an Argon2id password hash still verified against the fixture password.
- The game snapshot contained a scored `PLACE_WORD` followed by `PASS`, six game events, and two accepted command receipts. Score was 22 at revision 5.
- Board, racks, bag, stored draw order and clocks passed the production engine's state invariants, including exact conservation of all 267 tiles.
- The dictionary version remained `87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af`.
- The production command method replayed both restored receipts with their original accepted revisions and current game view. No rows changed and no Redis, clock-adjudication or live-health dependency was consulted by the duplicate-command path.
- All five pending outbox rows survived, and the restored sequence continued above existing IDs.

The 24,750-byte dump is retained locally at `.local/backup-tests/f508bdeaa5aada00/fixtures.dump` (ignored by version control). SHA-256: `8919d572c93c6805c1d490a11e931b4a3fa9bec175b562eeb724f6cd739bd196`. Dump took 150 ms and restore 127 ms for this small fixture. These timings do not estimate production recovery time.

## Repeating the check

Build the packages/server first and run the local PostgreSQL service. The helper runs directly with Node 24:

```sh
node tools/testing/backup-restore.mjs
```

`BESTWORD_BACKUP_ADMIN_URL` can select a different **local** PostgreSQL server with database creation permission. The helper connects to its `postgres` maintenance database, creates two unique fixture databases, and never uses the application database named in a supplied URL. It rejects remote hostnames. Permission failure is recorded without falling back to an existing database.

The embedded PostgreSQL package on this host includes the server tools but omits `pg_dump` and `pg_restore`. Set `BESTWORD_PG_BIN` to a complete, compatible PostgreSQL client `bin` directory when necessary. For this run, a portable archive was downloaded from the [EDB binary archive page](https://www.enterprisedb.com/download-postgresql-binaries), linked by the [official PostgreSQL Windows download page](https://www.postgresql.org/download/windows/). Only the two backup executables and accompanying DLLs were extracted into the task's `work/tools/postgresql-18.6-client` directory. There was no system installation or service/configuration change. Downloaded archive SHA-256: `59f8ce701c63c2ed623c665a5e51b3ef6f2e37ccf837b68ffeed0742d0ae6abd`.

Each run writes a new fixture dump under `.local/backup-tests/` and replaces `tools/testing/reports/backup-restore-latest.json`. No caller password appears in command arguments or the report. The fixture password is random, exists only in memory during the test, and is never written in plaintext.

## Scope

This establishes a real local logical backup/restore and receipt-preservation round trip using the production schema, persistence helper, game engine and duplicate-command implementation. The fixture is quiescent while dumping. It does not establish managed Render backup retention, point-in-time recovery, recovery under concurrent production load, regional disaster recovery, or production recovery time. Those require the operational procedures in [OPERATIONS.md](../OPERATIONS.md) and a provisioned staging deployment.

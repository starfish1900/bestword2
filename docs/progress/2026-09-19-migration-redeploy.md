# Redeploy migration deadlock fix

## Reported failure

The supplied Render log shows a successful Docker image build followed by PostgreSQL `40P01` (`deadlock detected`) in `node apps/server/dist/migrate.js`. It fails during the migration transaction, before API startup. Setting `APP_ORIGIN=https://bestword.net` triggered the redeployment but does not cause this database error.

The previous migration function reran all `CREATE ... IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements on every startup and pre-deploy. PostgreSQL still requests an exclusive table lock for an ALTER whose column already exists. The migration advisory lock serializes migration callers, but does not protect against concurrent application transactions using those tables.

## Correction

- Read the existing migration registry while holding the migration advisory lock.
- Run only unapplied versions: original schema version 1, AI additions and identities version 2.
- An already updated database performs no game/user/service-table DDL and does not rewrite AI identities.
- Keep schema changes, AI identities and version markers in one transaction.
- Retry the entire rolled-back transaction for PostgreSQL deadlocks, at most three attempts, with bounded backoff. Do not retry unrelated failures or silently claim success.
- Handle PostgreSQL connection-error events while a transaction has checked out a client, including intervals between queries. The pool's idle-client listener does not cover these intervals. Discard broken clients and propagate failed queries through the existing recovery path.
- No new schema version, database reset, data deletion, vocabulary change or APP_ORIGIN change is required.

## Verification

Six real PostgreSQL regression scenarios cover simultaneous fresh startup, upgrade from the exact shipped pre-AI SQL (commit `a3b8c56`), account/session/game/event/receipt/outbox preservation, startup with real conflicting application-table locks, full rollback/retry after an injected PostgreSQL deadlock error, bounded repeated errors and non-transient error propagation. The lock test first confirms that the original no-op ALTER blocks and is cancelled, then proves that three corrected migrations finish while those same locks remain held. Retry/error fixtures are explicitly injected server errors, not claims of reproducing PostgreSQL's complete deadlock detection algorithm.

The first consolidated run exposed an unhandled connection event during the existing PostgreSQL network-cut test, despite all 251 assertions passing. That run was not accepted as passing. The additional checked-out-client error handler and a seventh new regression explicitly exercise a TCP disconnect between queries and replacement of the broken connection.

The following run exposed a cleanup timeout in an older health-test wrapper that returned only `query` and `release`, omitting the real client's event methods. The fixture now forwards the real client through a proxy, verifies that its intended COMMIT failure actually occurred, and releases the connection normally. Its focused 12-test run passed; the final consolidated run supersedes both diagnostic attempts.

Build and type checking pass. The compiled production pre-deploy command also completed in 380 ms against a real isolated PostgreSQL schema while application-table locks remained held, using `NODE_ENV=production` and `APP_ORIGIN=https://bestword.net`; see [CLI verification](../evidence/migration-redeploy-cli.json). The final consolidated run passed **252/252 tests across all 15 test files in 113.99 seconds**, with no skipped tests or unhandled errors; see [the full report](../evidence/migration-redeploy-full-tests.json). Browser and hour-long capacity results from the earlier AI release remain historical and were not rerun for this database startup/recovery fix. No public deployment or GitHub push was performed by the assistant.

## Deploying the patch

Keep `APP_ORIGIN=https://bestword.net` on `bestword-api`. Push the local patch commit to `master`, wait for GitHub checks, and deploy that commit to the API and both workers so subsequent restarts use the corrected migration. Keep the API pre-deploy command `node apps/server/dist/migrate.js`. If automatic deployment is enabled, the push may already trigger deployment. Do not reset the database or suspend healthy services merely to apply this patch.

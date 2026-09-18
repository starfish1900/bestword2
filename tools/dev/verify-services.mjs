// Run only when application/test clients are stopped: this deliberately
// restarts the two local services to prove that their data survives.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, stop, status, pgQuery, redisCommand, localRoot } from './services.mjs';

const marker = randomUUID();
const key = `bestword:local-service-probe:${marker}`;
const first = await start();
assert(first.postgres.ready && first.redis.ready);
const second = await start();
assert.equal(second.postgres.pid, first.postgres.pid, 'Repeated start must reuse Postgres');
assert.equal(second.redis.runId, first.redis.runId, 'Repeated start must reuse Redis');
await pgQuery('CREATE TABLE IF NOT EXISTS bestword_local_service_probe(id text PRIMARY KEY, marker text NOT NULL)');
await pgQuery('INSERT INTO bestword_local_service_probe(id,marker) VALUES($1,$2)', [marker, marker]);
assert.equal(await redisCommand('SET', key, marker), 'OK');
await stop();
const stopped = await status();
assert.equal(stopped.postgres.ready, false);
assert.equal(stopped.redis.ready, false);
await stop(); // Stopping an already stopped checkout is also safe.
const restarted = await start();
const [record] = await pgQuery('SELECT marker FROM bestword_local_service_probe WHERE id=$1', [marker]);
assert.equal(record.marker, marker);
assert.equal(await redisCommand('GET', key), marker);
assert.equal(await redisCommand('PING'), 'PONG');
await pgQuery('DELETE FROM bestword_local_service_probe WHERE id=$1', [marker]);
await redisCommand('DEL', key);
const report = {
  checkedAt: new Date().toISOString(), realPostgresQuery: true, realRedisPing: true,
  repeatedStartReusesProcesses: true, repeatedStopSafe: true,
  postgresDataSurvivesRestart: true, redisDataSurvivesRestart: true,
  running: restarted,
  compatibility: 'Local PostgreSQL 18.4 and Redis 7.2.16. Production Render Valkey 8 is not locally tested.',
};
writeFileSync(join(localRoot, 'service-check.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

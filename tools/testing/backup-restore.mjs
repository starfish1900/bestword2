#!/usr/bin/env node
/** Real PostgreSQL custom-format backup/restore drill, using generated fixtures only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { createGame, setConnected, startIfReady, applyAction, assertStateInvariants, nextDeadline, INITIAL_COUNTS } from '@bestword/engine';
import { Gaddag } from '@bestword/lexicon';
import { createDatabase, migrate, transaction } from '../../apps/server/dist/db.js';
import { Games } from '../../apps/server/dist/games.js';
import { findMove } from './moves.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = randomBytes(8).toString('hex');
const names = { source: `bw_restore_${runId}_source`, restored: `bw_restore_${runId}_restored` };
const owned = new Set();
const marker = `BestWord isolated backup test ${runId}`;
const artifactDirectory = join(root, '.local', 'backup-tests', runId);
const reportPath = join(root, 'tools', 'testing', 'reports', 'backup-restore-latest.json');
const dumpPath = join(artifactDirectory, 'fixtures.dump');
const adminUrl = new URL(process.env.BESTWORD_BACKUP_ADMIN_URL ?? 'postgresql://bestword:bestword-local@127.0.0.1:54329/postgres');
assert(['postgres:', 'postgresql:'].includes(adminUrl.protocol), 'A PostgreSQL connection URL is required');
assert(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'This fixture drill is restricted to a local PostgreSQL server');
// Never read the caller's application database, search_path, or service options.
adminUrl.pathname = '/postgres'; adminUrl.search = ''; adminUrl.hash = '';
const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000, application_name: 'bestword-backup-fixtures' });
let source; let restored; let connected = false;
const report = { runId, startedAt: new Date().toISOString(), status: 'running', fixtureOnly: true, databases: names, checks: {}, cleanup: {} };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ident = name => `"${name.replaceAll('"', '""')}"`;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const failDependency = new Proxy({}, { get: () => { throw new Error('A duplicate receipt must not consult live Redis/health/config dependencies'); } });
const repositoryPath = path => relative(root, path).replaceAll('\\', '/');

function fixtureUrl(name) {
  assert(Object.values(names).includes(name), 'Only a generated fixture database may be used');
  const url = new URL(adminUrl); url.pathname = `/${name}`; return url.toString();
}
function assertOwnedName(name) {
  assert(/^bw_restore_[a-f0-9]{16}_(source|restored)$/.test(name));
  assert(Object.values(names).includes(name) && owned.has(name), 'Cleanup refused: database was not created by this run');
}
async function createOwned(name) {
  assert(Object.values(names).includes(name));
  await admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE template0`);
  owned.add(name);
  await admin.query(`COMMENT ON DATABASE ${ident(name)} IS '${marker}'`);
}
async function removeOwned(name) {
  assertOwnedName(name);
  const found = await admin.query(`SELECT r.rolname AS owner, shobj_description(d.oid,'pg_database') AS marker,
    (SELECT current_user) AS caller FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1`, [name]);
  assert.equal(found.rows.length, 1, 'Cleanup refused: generated database disappeared');
  assert.equal(found.rows[0].owner, found.rows[0].caller, 'Cleanup refused: database owner changed');
  assert.equal(found.rows[0].marker, marker, 'Cleanup refused: ownership marker changed');
  // No FORCE or termination of other connections: an unexpected user stops cleanup.
  await admin.query(`DROP DATABASE ${ident(name)}`);
  report.cleanup[name] = 'dropped';
}
async function binaries() {
  if (process.env.BESTWORD_PG_BIN) return { dump: join(resolve(process.env.BESTWORD_PG_BIN), process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), restore: join(resolve(process.env.BESTWORD_PG_BIN), process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore') };
  const packageName = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const embedded = await import(packageName);
  const bin = dirname(embedded.postgres);
  return { dump: join(bin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), restore: join(bin, process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore') };
}
async function run(executable, args, database) {
  if (database !== undefined) assertOwnedName(database);
  const started = performance.now();
  const output = await new Promise((resolveRun, reject) => {
    // Keep credentials out of command arguments, logs, and the final report.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')));
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, PGHOST: adminUrl.hostname.replace(/^\[|\]$/g, ''), PGPORT: adminUrl.port || '5432',
        PGUSER: decodeURIComponent(adminUrl.username), PGPASSWORD: decodeURIComponent(adminUrl.password),
        PGDATABASE: database || 'postgres', PGCONNECT_TIMEOUT: '5' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`PostgreSQL backup tool exited ${code}: ${stderr.trim()}`)));
  });
  return { output, elapsedMs: Math.round(performance.now() - started) };
}
async function contents(db) {
  const tables = (await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  const values = {}; const counts = {};
  for (const table of tables) {
    const rows = (await db.pool.query(`SELECT * FROM public.${ident(table)}`)).rows;
    values[table] = rows.map(canonical).sort(); counts[table] = rows.length;
  }
  const schema = (await db.pool.query(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON con.conrelid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,con.conname`)).rows;
  return { values, counts, schema, digest: sha256(canonical(values)) };
}
function seededRandom(seed) { let value = seed >>> 0; return max => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % max; }; }

try {
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  const executables = await binaries();
  report.tools = { dump: (await run(executables.dump, ['--version'])).output, restore: (await run(executables.restore, ['--version'])).output };
  await admin.connect(); connected = true;
  report.postgres = (await admin.query('SHOW server_version')).rows[0].server_version;
  for (const name of Object.values(names)) await createOwned(name);
  source = createDatabase(fixtureUrl(names.source), 2);
  restored = createDatabase(fixtureUrl(names.restored), 2);
  await migrate(source);
  const lexicon = await Gaddag.open(join(root, 'data', 'lexicon.bin.gz'));
  const players = [{ id: randomUUID(), username: 'BackupAlice' }, { id: randomUUID(), username: 'BackupBob' }];
  const password = randomBytes(32).toString('base64url');
  const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
  const now = Date.now() - 10_000;
  let initial; let active; let move;
  for (let seed = 1; seed <= 12 && !move; seed++) {
    initial = createGame({ id: randomUUID(), players, minutes: 5, lexiconVersion: lexicon.sha256, seedWords: lexicon.seedWords, now, randomInt: seededRandom(seed), firstSeat: 0 }, lexicon);
    active = setConnected(initial, 0, true, now);
    active = setConnected(active, 1, true, now);
    active = startIfReady(active, now + 3000);
    move = findMove(active, lexicon);
  }
  assert(move, 'Could not construct a legal scored fixture move');
  const games = new Games(source, failDependency, failDependency, lexicon, failDependency);
  const commands = []; let finalState = active;
  await transaction(source, async client => {
    for (const player of players) {
      await client.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [player.id, player.username, player.username.toLowerCase(), passwordHash, now]);
      await client.query('INSERT INTO sessions VALUES($1,$2,$3)', [sha256(randomBytes(32)), player.id, now + 3600000]);
    }
    await client.query('INSERT INTO games(id,state,revision,status,created_at,updated_at,next_deadline) VALUES($1,$2,$3,$4,$5,$5,$6)', [initial.id, JSON.stringify(initial), initial.revision, initial.status, now, nextDeadline(initial)]);
    for (const seat of [0, 1]) {
      await client.query('INSERT INTO game_players VALUES($1,$2,$3)', [initial.id, players[seat].id, seat]);
      await client.query('INSERT INTO playing_slots VALUES($1,$2)', [players[seat].id, initial.id]);
    }
    await client.query("INSERT INTO game_events VALUES($1,0,'setup',$2,$3)", [initial.id, now, JSON.stringify({ board: initial.board, principalHistory: initial.principalHistory })]);
    let previous = initial;
    const connected0 = setConnected(initial, 0, true, now);
    const connected1 = setConnected(connected0, 1, true, now);
    for (const state of [connected0, connected1, active]) {
      await games.persist(client, previous, state, [[], []]); previous = state;
    }
    for (const [index, action] of [move, { type: 'PASS' }].entries()) {
      const seat = finalState.activeSeat;
      const command = { gameId: initial.id, commandId: randomUUID(), expectedRevision: finalState.revision, action };
      const after = applyAction(finalState, seat, action, now + 3100 + index * 100, lexicon);
      assertStateInvariants(after);
      await games.persist(client, finalState, after, [[], []]);
      const payloadHash = sha256(JSON.stringify({ expectedRevision: command.expectedRevision, action }));
      await client.query('INSERT INTO commands VALUES($1,$2,$3,$4,$5,$6)', [initial.id, players[seat].id, command.commandId, payloadHash, JSON.stringify({ ok: true, revision: after.revision }), after.lastTransitionAt]);
      commands.push({ command, player: players[seat], acceptedRevision: after.revision }); finalState = after;
    }
  });
  const before = await contents(source);
  assert.equal(before.counts.users, 2); assert.equal(before.counts.games, 1); assert.equal(before.counts.commands, 2);
  assert(before.counts.outbox > 0 && before.counts.game_events > 0);
  const dumped = await run(executables.dump, ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath], names.source);
  const restoredRun = await run(executables.restore, ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', names.restored, dumpPath], names.restored);
  const after = await contents(restored);
  assert.deepEqual(after, before, 'All restored rows and relational constraints must exactly match the fixture source');
  const state = (await restored.pool.query('SELECT state FROM games WHERE id=$1', [initial.id])).rows[0].state;
  assert.deepEqual(state, finalState); assertStateInvariants(state);
  assert.equal(state.lexiconVersion, lexicon.sha256);
  assert(await verify((await restored.pool.query('SELECT password_hash FROM users WHERE id=$1', [players[0].id])).rows[0].password_hash, password));
  const restoredGames = new Games(restored, failDependency, failDependency, lexicon, failDependency);
  for (const receipt of commands) {
    const replay = await restoredGames.command(receipt.command, receipt.player);
    assert.equal(replay.ok, true); assert.equal(replay.acceptedRevision, receipt.acceptedRevision);
    assert.equal(replay.view.game.revision, finalState.revision);
  }
  assert.deepEqual(await contents(restored), after, 'Retrying restored receipts must not execute actions or mutate rows');
  const maxOutbox = Number((await restored.pool.query('SELECT max(id) AS id FROM outbox')).rows[0].id);
  const nextOutbox = Number((await restored.pool.query("SELECT nextval(pg_get_serial_sequence('outbox','id')) AS id")).rows[0].id);
  assert(nextOutbox > maxOutbox, 'Outbox sequence must continue after restored IDs');
  const backupBytes = await readFile(dumpPath);
  report.checks = { exactTableContents: true, exactConstraints: true, passwordHashVerified: true, snapshotAndLexiconVersion: true,
    tileConservation: Object.values(INITIAL_COUNTS).reduce((sum, count) => sum + count, 0), acceptedReceiptsReplayedWithoutMutation: commands.length,
    pendingOutboxPreserved: before.counts.outbox, outboxSequenceContinues: true };
  report.rowCounts = before.counts; report.contentsSha256 = before.digest;
  report.fixture = { acceptedActions: state.moves.map(item => item.action), score: state.players[0].score, revision: state.revision, lexiconVersion: state.lexiconVersion };
  report.backup = { path: repositoryPath(dumpPath), bytes: (await stat(dumpPath)).size, sha256: sha256(backupBytes), dumpMs: dumped.elapsedMs, restoreMs: restoredRun.elapsedMs };
  report.status = 'passed';
} catch (error) {
  report.status = error?.code === '42501' && owned.size === 0 ? 'blocked-create-database-permission' : 'failed';
  // Error messages must not expose a caller-supplied password.
  const message = String(error?.stack ?? error);
  report.error = adminUrl.password ? message.replaceAll(decodeURIComponent(adminUrl.password), '[REDACTED]') : message;
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source?.pool.end(), restored?.pool.end()]);
  if (connected) {
    for (const name of owned) {
      try { await removeOwned(name); }
      catch (error) { report.cleanup[name] = `FAILED: ${error.message}`; report.status = 'failed-cleanup'; process.exitCode = 1; }
    }
    await admin.end();
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: repositoryPath(reportPath), backup: report.backup, cleanup: report.cleanup }, null, 2));
}

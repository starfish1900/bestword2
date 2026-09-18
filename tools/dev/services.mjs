#!/usr/bin/env node
// Task-local development services. No OS service registration, PATH changes,
// database deletion, or global configuration changes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const localRoot = join(repositoryRoot, '.local');
const postgresDirectory = join(localRoot, 'postgres');
const redisDirectory = join(localRoot, 'redis');
const logsDirectory = join(localRoot, 'logs');
const statePath = join(localRoot, 'services.json');
const postgresLog = join(logsDirectory, 'postgres.log');
const redisLog = join(logsDirectory, 'redis.log');
export const databaseUrl = 'postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';
export const redisUrl = 'redis://127.0.0.1:6389';
const defaultRedis = resolve(repositoryRoot, '../../work/tools/redis-7.2.16/Redis-7.2.16-Windows-x64-msys2/redis-server.exe');

function state() {
  if (!existsSync(statePath)) return null;
  const value = JSON.parse(readFileSync(statePath, 'utf8'));
  if (value.repositoryRoot !== repositoryRoot) throw new Error('Service state belongs to another checkout');
  return value;
}

function saveState(value) {
  writeFileSync(statePath, JSON.stringify({ ...value, repositoryRoot }, null, 2) + '\n');
}

async function binaries() {
  const packageName = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const postgres = await import(packageName);
  const redis = process.env.BESTWORD_REDIS_BINARY || defaultRedis;
  if (!existsSync(redis)) throw new Error(`Redis binary missing: set BESTWORD_REDIS_BINARY to a portable Redis-compatible executable. Expected ${redis}`);
  return { ...postgres, redis };
}

async function run(executable, args, logPath) {
  return new Promise((resolvePromise, reject) => {
    const output = logPath ? openSync(logPath, 'a') : null;
    const child = spawn(executable, args, {
      cwd: repositoryRoot, windowsHide: true,
      stdio: output === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', output, output],
    });
    let text = '';
    child.stdout?.on('data', chunk => { text += chunk; });
    child.stderr?.on('data', chunk => { text += chunk; });
    child.once('error', error => { if (output !== null) closeSync(output); reject(error); });
    child.once('exit', code => {
      // pg_ctl can leave inherited pipe handles open in its postmaster child.
      // The controller has exited, so release our capture streams explicitly.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (output !== null) closeSync(output);
      if (code !== 0) reject(new Error(`${executable} exited ${code}. ${text} ${logPath ? `See ${logPath}` : ''}`));
      else resolvePromise(text.trim());
    });
  });
}

async function portOpen(port) {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let complete = false;
    const done = result => { if (complete) return; complete = true; socket.destroy(); resolvePromise(result); };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function pgQuery(sql, values = [], database = 'bestword') {
  const client = new Client({
    host: '127.0.0.1', port: 54329, user: 'bestword', password: 'bestword-local', database,
    connectionTimeoutMillis: 1500, query_timeout: 2000,
  });
  try { await client.connect(); return (await client.query(sql, values)).rows; }
  finally { await client.end().catch(() => {}); }
}

// Small RESP client keeps these scripts independent of an application adapter.
function parseResp(data, offset = 0) {
  const end = data.indexOf('\r\n', offset);
  if (end < 0) return null;
  const type = data[offset];
  const line = data.subarray(offset + 1, end).toString();
  if (type === 43) return { value: line, next: end + 2 };
  if (type === 45) throw new Error(line);
  if (type === 58) return { value: Number(line), next: end + 2 };
  if (type === 36) {
    const length = Number(line);
    if (length === -1) return { value: null, next: end + 2 };
    if (data.length < end + 2 + length + 2) return null;
    return { value: data.subarray(end + 2, end + 2 + length).toString(), next: end + 2 + length + 2 };
  }
  if (type === 42) {
    const length = Number(line);
    if (length === -1) return { value: null, next: end + 2 };
    const values = [];
    let cursor = end + 2;
    for (let i = 0; i < length; i++) {
      const item = parseResp(data, cursor);
      if (!item) return null;
      values.push(item.value); cursor = item.next;
    }
    return { value: values, next: cursor };
  }
  throw new Error('Unsupported Redis response');
}

export async function redisCommand(...args) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 6389 });
    let data = Buffer.alloc(0);
    let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolvePromise(value);
    };
    socket.setTimeout(2000, () => finish(new Error('Redis command timed out')));
    socket.once('error', error => finish(error));
    socket.once('connect', () => {
      const parts = [`*${args.length}\r\n`];
      for (const argument of args) { const text = String(argument); parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`); }
      socket.write(parts.join(''));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      try { const parsed = parseResp(data); if (parsed) finish(null, parsed.value); }
      catch (error) { finish(error); }
    });
    socket.once('end', () => {
      if (String(args[0]).toUpperCase() === 'SHUTDOWN') finish(null, 'stopped');
      else if (!done) finish(new Error('Redis closed without a complete response'));
    });
  });
}

async function redisInfo() {
  const raw = await redisCommand('INFO', 'server');
  return Object.fromEntries(raw.split('\r\n').filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf(':'); return [line.slice(0, split), line.slice(split + 1)];
  }));
}

function assertOurPostgres(directory) {
  if (resolve(directory) !== postgresDirectory) throw new Error(`Refusing to control PostgreSQL in another data directory: ${directory}`);
}

async function postgresStatus() {
  if (!await portOpen(54329)) return { ready: false, url: databaseUrl, dataDirectory: postgresDirectory, log: postgresLog };
  const [result] = await pgQuery("SELECT version() AS version, current_setting('data_directory') AS directory", [], 'postgres');
  assertOurPostgres(result.directory);
  const pidFile = join(postgresDirectory, 'postmaster.pid');
  return {
    ready: true, version: result.version, pid: existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]) : null,
    url: databaseUrl, dataDirectory: postgresDirectory, log: postgresLog,
  };
}

async function redisStatus() {
  if (!await portOpen(6389)) return { ready: false, url: redisUrl, dataDirectory: redisDirectory, log: redisLog };
  const info = await redisInfo();
  const recorded = state()?.redis;
  if (!recorded?.runId || recorded.runId !== info.run_id) throw new Error('Refusing to control an unrecognized Redis process on port 6389');
  return {
    ready: true, version: info.redis_version, pid: recorded.pid, reportedPid: Number(info.process_id), runId: info.run_id,
    url: redisUrl, dataDirectory: redisDirectory, log: redisLog,
  };
}

export async function status() {
  return { postgres: await postgresStatus(), redis: await redisStatus() };
}

async function initializePostgres(bin) {
  if (existsSync(join(postgresDirectory, 'PG_VERSION'))) return;
  if (existsSync(postgresDirectory) && readdirSync(postgresDirectory).length > 0) {
    throw new Error('Postgres directory is nonempty but has no PG_VERSION. Refusing to overwrite it.');
  }
  const passwordFile = join(localRoot, 'initdb-password.tmp');
  writeFileSync(passwordFile, 'bestword-local\n', { mode: 0o600 });
  try {
    await run(bin.initdb, [
      '-D', postgresDirectory, '--username=bestword', `--pwfile=${passwordFile}`,
      '--auth=scram-sha-256', '--locale=C', '--encoding=UTF8',
    ], join(logsDirectory, 'initdb.log'));
  } finally { if (existsSync(passwordFile)) unlinkSync(passwordFile); }
}

export async function start() {
  const bin = await binaries();
  mkdirSync(logsDirectory, { recursive: true });
  mkdirSync(redisDirectory, { recursive: true });
  await initializePostgres(bin);
  if (!await portOpen(54329)) {
    await run(bin.pg_ctl, [
      '-D', postgresDirectory, '-l', postgresLog, '-w', '-t', '30',
      '-o', '-h 127.0.0.1 -p 54329 -c max_connections=100 -c shared_buffers=64MB -c fsync=on', 'start',
    ]);
  }
  const postgres = await postgresStatus();
  const databases = await pgQuery('SELECT 1 FROM pg_database WHERE datname=$1', ['bestword'], 'postgres');
  if (!databases.length) await pgQuery('CREATE DATABASE bestword', [], 'postgres');
  await pgQuery('SELECT 1');
  saveState({ ...(state() || {}), postgres });
  if (!await portOpen(6389)) {
    const log = openSync(redisLog, 'a');
    const child = spawn(bin.redis, [
      '--bind', '127.0.0.1', '--port', '6389', '--protected-mode', 'yes',
      '--daemonize', 'no', '--dir', '.', '--appendonly', 'yes', '--appendfsync', 'everysec',
      '--save', '', '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction',
    ], { cwd: redisDirectory, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    await new Promise((resolvePromise, reject) => { child.once('spawn', resolvePromise); child.once('error', reject); });
    child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if (await redisCommand('PING') === 'PONG') { ready = true; break; } } catch { /* starting */ }
      await delay(100);
    }
    if (!ready) throw new Error(`Redis did not become ready. See ${redisLog}`);
    const info = await redisInfo();
    saveState({ ...(state() || {}), postgres, redis: { pid: child.pid, reportedPid: Number(info.process_id), runId: info.run_id, binary: bin.redis } });
  }
  const result = await status();
  saveState({ ...(state() || {}), startedAt: new Date().toISOString() });
  return result;
}

export async function stop() {
  const current = await status(); // Proves ownership before issuing shutdown.
  const bin = await binaries();
  if (current.redis.ready) await redisCommand('SHUTDOWN', 'SAVE');
  if (current.postgres.ready) await run(bin.pg_ctl, ['-D', postgresDirectory, '-m', 'fast', '-w', '-t', '30', 'stop']);
  if (state()) saveState({ ...state(), stoppedAt: new Date().toISOString() });
  return { stopped: true, dataPreserved: true, localRoot };
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'status') process.stdout.write(JSON.stringify(await status(), null, 2) + '\n');
  else if (command === 'start' || command === 'bootstrap') process.stdout.write(JSON.stringify(await start(), null, 2) + '\n');
  else if (command === 'stop') process.stdout.write(JSON.stringify(await stop(), null, 2) + '\n');
  else if (command === 'foreground') {
    process.stdout.write(JSON.stringify(await start(), null, 2) + '\n');
    process.stdout.write('Local test services are running. Ctrl+C stops them and preserves data.\n');
    const keepAlive = setInterval(() => {}, 1000);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return; stopping = true;
      try { await stop(); } finally { clearInterval(keepAlive); }
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } else throw new Error('Usage: node tools/dev/services.mjs bootstrap|start|foreground|status|stop');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}

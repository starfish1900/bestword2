import pg, { type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { EngineState } from '@bestword/engine';
import type { AiDifficulty } from '@bestword/contracts';

export function createDatabase(connectionString:string,max=10) {
  // The server limit cannot answer through a half-open network connection. The
  // independent read deadline releases callers; idle transaction expiry also
  // frees server locks if a severed client's close packet cannot reach PostgreSQL.
  const pool=new pg.Pool({connectionString,max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:8000,idle_in_transaction_session_timeout:10000,application_name:'bestword'});
  pool.on('error',()=>{/* individual callers and health checks handle a failed connection */});
  return {pool,orm:drizzle(pool)};
}
export type Database=ReturnType<typeof createDatabase>;
export type GatewaySeats=[string[],string[]];
export interface GameRow {id:string;state:EngineState;revision:number;created_at:string;updated_at:string;status:string;next_deadline:string|null;gateways:GatewaySeats;handled_incidents:string[]}
export interface AiCapabilities {policyVersion:string;vocabularies:Record<AiDifficulty,string>}
export interface AiJob {game_id:string;turn_number:number;position_key:string;status:'queued'|'running'|'completed'|'cancelled';lease_owner:string|null;lease_token:string|null;leased_until:string;available_at:string;attempts:number;result:unknown|null}
export const AI_USERS:Record<AiDifficulty,{id:string;username:string}>={
  easy:{id:'00000000-0000-4000-8000-000000000001',username:'BestWord Easy'},
  medium:{id:'00000000-0000-4000-8000-000000000002',username:'BestWord Medium'},
  hard:{id:'00000000-0000-4000-8000-000000000003',username:'BestWord Hard'},
};
export async function databaseNow(client:PoolClient):Promise<number> { const result=await client.query<{now:string}>('SELECT (extract(epoch from clock_timestamp())*1000)::bigint AS now'); return Number(result.rows[0]!.now); }
export async function transaction<T>(db:Database,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await db.pool.connect();let discard:Error|undefined;
  try { await client.query('BEGIN'); const value=await fn(client); await client.query('COMMIT'); return value; }
  catch(error) {
    if(uncertainConnection(error))discard=error;
    else {
      // A normal SQL/application error leaves a usable connection after rollback.
      // The same client read limit bounds cleanup; failed cleanup retires it.
      try{await client.query('ROLLBACK');}catch(rollbackError){discard=rollbackError instanceof Error?rollbackError:new Error('Rollback failed');}
    }
    throw error;
  }
  finally { client.release(discard); }
}
function uncertainConnection(error:unknown):error is Error {
  if(!(error instanceof Error))return false;
  const code='code'in error?String(error.code):'';
  return /^E(?:CONN|PIPE|HOST|NET|TIMEDOUT|AI_)/.test(code)||/query read timeout|connection (?:terminated|closed|error)|not queryable|client was closed/i.test(error.message);
}
export async function migrate(db:Database):Promise<void> {
  await transaction(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(421715011)');
    await c.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, username varchar(15) NOT NULL, username_key varchar(15) NOT NULL UNIQUE, password_hash text NOT NULL, created_at bigint NOT NULL);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'human';
      CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id,expires_at);
      CREATE TABLE IF NOT EXISTS games (id uuid PRIMARY KEY, state jsonb NOT NULL, revision integer NOT NULL, status text NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL, next_deadline bigint, gateways jsonb NOT NULL DEFAULT '[[],[]]');
      CREATE INDEX IF NOT EXISTS games_deadlines ON games(next_deadline) WHERE status <> 'finished';
      CREATE INDEX IF NOT EXISTS games_history ON games(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS games_gateways ON games USING gin(gateways);
      ALTER TABLE games ADD COLUMN IF NOT EXISTS handled_incidents text[] NOT NULL DEFAULT '{}';
      ALTER TABLE games ADD COLUMN IF NOT EXISTS next_check bigint NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS games_checks ON games(next_check) WHERE status <> 'finished';
      CREATE TABLE IF NOT EXISTS game_players (game_id uuid NOT NULL REFERENCES games(id),user_id uuid NOT NULL REFERENCES users(id),seat smallint NOT NULL CHECK(seat IN(0,1)),PRIMARY KEY(game_id,seat),UNIQUE(game_id,user_id));
      CREATE INDEX IF NOT EXISTS game_players_user ON game_players(user_id,game_id);
      CREATE TABLE IF NOT EXISTS playing_slots (user_id uuid PRIMARY KEY REFERENCES users(id),game_id uuid NOT NULL REFERENCES games(id));
      CREATE TABLE IF NOT EXISTS seeks (id uuid PRIMARY KEY,user_id uuid NOT NULL UNIQUE REFERENCES users(id),minutes smallint NOT NULL CHECK(minutes IN(5,15,25)),created_at bigint NOT NULL,expires_at bigint NOT NULL);
      CREATE INDEX IF NOT EXISTS seeks_expiry ON seeks(expires_at);
      CREATE TABLE IF NOT EXISTS game_events (game_id uuid NOT NULL REFERENCES games(id),revision integer NOT NULL,kind text NOT NULL,at bigint NOT NULL,public_data jsonb NOT NULL,PRIMARY KEY(game_id,revision));
      CREATE TABLE IF NOT EXISTS commands (game_id uuid NOT NULL REFERENCES games(id),user_id uuid NOT NULL REFERENCES users(id),command_id uuid NOT NULL,payload_hash text NOT NULL,reply jsonb NOT NULL,created_at bigint NOT NULL,PRIMARY KEY(game_id,user_id,command_id));
      CREATE TABLE IF NOT EXISTS outbox (id bigserial PRIMARY KEY,game_id uuid NOT NULL REFERENCES games(id),revision integer NOT NULL,created_at bigint NOT NULL,attempts integer NOT NULL DEFAULT 0,claimed_until bigint NOT NULL DEFAULT 0,UNIQUE(game_id,revision));
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(claimed_until,id);
      CREATE TABLE IF NOT EXISTS service_epochs (id uuid PRIMARY KEY,kind text NOT NULL,last_healthy bigint NOT NULL,status text NOT NULL,started_at bigint NOT NULL);
      ALTER TABLE service_epochs ADD COLUMN IF NOT EXISTS capabilities jsonb;
      CREATE TABLE IF NOT EXISTS incidents (id uuid PRIMARY KEY,epoch_id uuid REFERENCES service_epochs(id),reason text NOT NULL,started_at bigint NOT NULL,recovered_at bigint,UNIQUE(epoch_id,started_at));
      INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS ai_jobs (
        game_id uuid NOT NULL REFERENCES games(id),turn_number integer NOT NULL,position_key text NOT NULL,
        status text NOT NULL DEFAULT 'queued',lease_owner uuid REFERENCES service_epochs(id),lease_token uuid,
        leased_until bigint NOT NULL DEFAULT 0,available_at bigint NOT NULL,attempts integer NOT NULL DEFAULT 0,
        result jsonb,created_at bigint NOT NULL,updated_at bigint NOT NULL,PRIMARY KEY(game_id,turn_number));
      CREATE INDEX IF NOT EXISTS ai_jobs_ready ON ai_jobs(available_at,leased_until) WHERE status IN ('queued','running');
      INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
    `);
    for(const identity of Object.values(AI_USERS))await c.query("INSERT INTO users(id,username,username_key,password_hash,created_at,kind) VALUES($1,$2,$3,'!AI-NO-LOGIN!',0,'ai') ON CONFLICT(id) DO NOTHING",[identity.id,identity.username,identity.username.toLowerCase()]);
  });
}

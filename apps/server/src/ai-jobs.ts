import { createHash,randomUUID } from 'node:crypto';
import type { EngineState } from '@bestword/engine';
import type { PoolClient } from 'pg';
import { databaseNow,transaction,type AiCapabilities,type AiJob,type Database,type GameRow } from './db.js';

export const AI_LEASE_MS=10_000;
export interface AiClaim {job:AiJob;state:EngineState;now:number;token:string;owner:string}
/** Presence, countdown and clock changes do not change the position being solved. */
export function aiPositionKey(state:EngineState):string{
  if(!state.ai)throw new Error('AI position requires an AI opponent');
  const seat=state.ai.seat;
  return createHash('sha256').update(JSON.stringify({board:state.board,rack:state.players[seat].rack,
    vowels:['A','E','I','O','U','Y'].map(letter=>state.bag[letter as keyof typeof state.bag]),
    principalHistory:state.principalHistory,opponentRackSize:state.players[seat===0?1:0].rack.length,
    opponentPassed:state.players[seat===0?1:0].passed,drawnThisTurn:state.drawnThisTurn[seat],
    consonantsRemaining:state.consonantDrawOrder.length,ai:state.ai})).digest('hex');
}
/** Run in the same transaction as the game transition; a tick also repairs missing work. */
export async function ensureAiJob(c:PoolClient,state:EngineState):Promise<void>{
  if(!state.ai)return;
  await c.query("UPDATE ai_jobs SET status='cancelled',lease_token=NULL,updated_at=$2 WHERE game_id=$1 AND status IN ('queued','running') AND (turn_number<>$3 OR $4)",[state.id,state.lastTransitionAt,state.moves.length,state.status==='finished'||state.players[state.ai.seat].passed]);
  if(state.status!=='active'||state.turnStartedAt===null||state.activeSeat!==state.ai.seat||state.players[state.ai.seat].passed)return;
  await c.query("INSERT INTO ai_jobs(game_id,turn_number,position_key,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,$4) ON CONFLICT(game_id,turn_number) DO NOTHING",[state.id,state.moves.length,aiPositionKey(state),state.lastTransitionAt]);
}
export async function claimAiJob(db:Database,owner:string,capabilities:AiCapabilities):Promise<AiClaim|null>{
  return transaction(db,async c=>{
    const now=await databaseNow(c);
    const result=await c.query<AiJob>(`SELECT j.* FROM ai_jobs j JOIN games g ON g.id=j.game_id
      WHERE j.status IN ('queued','running') AND j.available_at<=$1 AND j.leased_until<=$1
      AND g.status='active' AND g.state->>'turnStartedAt' IS NOT NULL
      AND (g.state->>'activeSeat')::int=(g.state->'ai'->>'seat')::int
      AND g.state->'ai'->>'policyVersion'=$2
      AND g.state->'ai'->>'vocabularyHash'=($3::jsonb->>(g.state->'ai'->>'difficulty'))
      AND g.state->>'lexiconVersion'=$4
      ORDER BY j.available_at,j.game_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[now,capabilities.policyVersion,JSON.stringify(capabilities.vocabularies),capabilities.vocabularies.hard]);
    const job=result.rows[0];if(!job)return null;
    const state=(await c.query<GameRow>('SELECT * FROM games WHERE id=$1',[job.game_id])).rows[0]!.state;
    if(state.moves.length!==job.turn_number||aiPositionKey(state)!==job.position_key){await c.query("UPDATE ai_jobs SET status='cancelled',updated_at=$3 WHERE game_id=$1 AND turn_number=$2",[job.game_id,job.turn_number,now]);return null;}
    const token=randomUUID();
    await c.query("UPDATE ai_jobs SET status='running',lease_owner=$3,lease_token=$4,leased_until=$5,attempts=attempts+1,updated_at=$6 WHERE game_id=$1 AND turn_number=$2",[job.game_id,job.turn_number,owner,token,now+AI_LEASE_MS,now]);
    return {job:{...job,status:'running',lease_owner:owner,lease_token:token,leased_until:String(now+AI_LEASE_MS),attempts:job.attempts+1},state,now,token,owner};
  });
}
export async function renewAiClaim(db:Database,claim:AiClaim):Promise<boolean>{
  return transaction(db,async c=>{
    const now=await databaseNow(c);
    const result=await c.query(`UPDATE ai_jobs j SET leased_until=$5,updated_at=$6 FROM games g
      WHERE j.game_id=$1 AND j.turn_number=$2 AND j.lease_owner=$3 AND j.lease_token=$4
      AND j.status='running' AND j.leased_until>$6 AND g.id=j.game_id AND g.status='active'
      AND jsonb_array_length(g.state->'moves')=$2`,[claim.job.game_id,claim.job.turn_number,claim.owner,claim.token,now+AI_LEASE_MS,now]);
    return Boolean(result.rowCount);
  });
}
export async function releaseAiClaim(db:Database,claim:AiClaim):Promise<void>{
  await db.pool.query("UPDATE ai_jobs SET status='queued',lease_owner=NULL,lease_token=NULL,leased_until=0,available_at=(extract(epoch from clock_timestamp())*1000)::bigint+250 WHERE game_id=$1 AND turn_number=$2 AND lease_owner=$3 AND lease_token=$4 AND status='running'",[claim.job.game_id,claim.job.turn_number,claim.owner,claim.token]);
}

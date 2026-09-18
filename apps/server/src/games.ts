import { randomUUID,randomInt,createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { EngineError,createGame,applyAction,startIfReady,dueOutcome,adjudicate,pauseGame,beginRecovery,resumeGame,setConnected,nextDeadline,projectGame,restartRecovery,type EngineState } from '@bestword/engine';
import type { Gaddag } from '@bestword/lexicon';
import type { User,Seat,GameCommand,CommandReply,GameView,GameSummary,TimeControl,ApiError } from '@bestword/contracts';
import type { Config } from './config.js';
import { type Database,type GameRow,type GatewaySeats,transaction,databaseNow } from './db.js';
import { HttpError,isPgError } from './errors.js';
import { type KeyValue,presence,touchPresence,removePresence,rateLimit } from './kv.js';
import type { Health } from './health.js';

type Receipt={ok:true;revision:number}|{ok:false;error:ApiError};
export type Publish=(state:EngineState)=>Promise<void>;
export class Games {
  publish:Publish=async()=>{};
  constructor(readonly db:Database,readonly kv:KeyValue,readonly health:Health,readonly lexicon:Gaddag,readonly config:Config){}
  seat(state:EngineState,userId:string|undefined):Seat|null{return state.players[0].id===userId?0:state.players[1].id===userId?1:null;}
  async read(id:string):Promise<GameRow>{const r=await this.db.pool.query<GameRow>('SELECT * FROM games WHERE id=$1',[id]);if(!r.rows[0])throw new HttpError(404,'GAME_NOT_FOUND','This game was not found.');return r.rows[0];}
  async view(id:string,userId?:string):Promise<GameView>{const row=await this.read(id);return projectGame(row.state,this.seat(row.state,userId),Date.now(),await this.spectators(id));}
  async spectators(id:string):Promise<number>{if(!this.kv.isReady)return 0;await this.kv.zRemRangeByScore(`bw:spectators:${id}`,'-inf',Date.now());return this.kv.zCard(`bw:spectators:${id}`);}
  summary(row:GameRow):GameSummary{return {id:row.id,players:row.state.players.map(({id,username})=>({id,username})) as [User,User],scores:row.state.players.map(p=>p.score) as [number,number],minutes:row.state.minutes,status:row.state.status,result:row.state.result,createdAt:Number(row.created_at),spectatorCount:0};}
  async persist(c:PoolClient,before:EngineState,state:EngineState,gateways:GatewaySeats,handled:string[]=[]):Promise<void>{
    await c.query('UPDATE games SET state=$2,revision=$3,status=$4,updated_at=$5,next_deadline=$6,gateways=$7,handled_incidents=$8 WHERE id=$1',[state.id,JSON.stringify(state),state.revision,state.status,state.lastTransitionAt,nextDeadline(state),JSON.stringify(gateways),handled]);
    if(state.revision!==before.revision){
      const kind=state.moves.length>before.moves.length?'action':state.status!==before.status?state.status:'presence';
      const data={moves:state.moves.slice(before.moves.length),status:state.status,result:state.result,clocksMs:state.clocksMs,turnDeadlineAt:state.turnDeadlineAt};
      await c.query('INSERT INTO game_events(game_id,revision,kind,at,public_data) VALUES($1,$2,$3,$4,$5)',[state.id,state.revision,kind,state.lastTransitionAt,JSON.stringify(data)]);
      await c.query('INSERT INTO outbox(game_id,revision,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[state.id,state.revision,state.lastTransitionAt]);
    }
    for(const player of state.players)if(player.passed||state.status==='finished')await c.query('DELETE FROM playing_slots WHERE user_id=$1 AND game_id=$2',[player.id,state.id]);
  }
  async announce(state:EngineState):Promise<void>{
    try{await this.publish(state);await this.db.pool.query('DELETE FROM outbox WHERE game_id=$1 AND revision<=$2',[state.id,state.revision]);}catch{/* durable outbox will retry */}
  }
  async livePresence(c:PoolClient,gameId:string,seat:Seat,now:number):Promise<string[]>{
    const members=await presence(this.kv,gameId,seat,now);
    const epochs=[...new Set(members.map(member=>member.split('/')[0]!))];
    if(!epochs.length)return [];
    return (await c.query<{id:string}>("SELECT id FROM service_epochs WHERE id=ANY($1::uuid[]) AND kind='api' AND status='active' AND last_healthy>=$2",[epochs,now-3000])).rows.map(row=>row.id);
  }
  async settle(c:PoolClient,row:GameRow,now:number):Promise<{state:EngineState;gateways:GatewaySeats;pending:boolean;handled:string[]}>{
    let state=row.state;const gateways:GatewaySeats=structuredClone(row.gateways);let handled=[...row.handled_incidents];
    if(state.status==='finished')return {state,gateways,pending:false,handled};
    const outcome=dueOutcome(state,now);
    const evidence=await this.health.evidence(c,state,gateways,now,outcome?.at??null,handled);
    handled=[...new Set([...handled,...evidence.incidentIds])];
    if(state.status==='paused'&&evidence.incidentIds.length&&evidence.pauseAt!==null)state=restartRecovery(state,now,evidence.reason);
    if(state.status!=='paused'&&evidence.pauseAt!==null)state=pauseGame(state,evidence.pauseAt,evidence.reason);
    if(state.status==='paused'){
      if(evidence.healthy){
        if(state.pause?.recoveryDeadlineAt===null)state=beginRecovery(state,now);
        for(const seat of [0,1] as const){
          if(state.players[seat].passed)continue;
          const live=await this.livePresence(c,state.id,seat,now);
          if(live.length)gateways[seat]=live;
          if(state.players[seat].connected!==Boolean(live.length)&&!dueOutcome(state,now))state=setConnected(state,seat,Boolean(live.length),now);
        }
        if(state.players.every(p=>p.passed||p.connected)&&!dueOutcome(state,now))state=resumeGame(state,now);
        else if(dueOutcome(state,now))state=adjudicate(state,now);
      }
      return {state,gateways,pending:false,handled};
    }
    if(outcome){if(evidence.pending)return {state,gateways,pending:true,handled};state=adjudicate(state,now);}
    else {
      // Leases recover missed disconnect callbacks. Preserve the last gateway when
      // absent so a gateway failure is still distinguished from a player's exit.
      for(const seat of [0,1] as const){
        if(state.players[seat].passed)continue;
        const live=await this.livePresence(c,state.id,seat,now);
        if(live.length)gateways[seat]=live;
        if(state.players[seat].connected!==Boolean(live.length))state=setConnected(state,seat,Boolean(live.length),now);
      }
      state=startIfReady(state,now);
    }
    // A delayed scheduler may start a countdown whose effective clock deadline is already past.
    const afterStart=dueOutcome(state,now);
    if(afterStart&&state.status!=='finished'){
      const afterEvidence=await this.health.evidence(c,state,gateways,now,afterStart.at,handled);
      if(afterEvidence.pauseAt!==null)state=pauseGame(state,afterEvidence.pauseAt,afterEvidence.reason);
      else if(afterEvidence.pending)return {state,gateways,pending:true,handled};else state=adjudicate(state,now);
    }
    return {state,gateways,pending:false,handled};
  }
  async command(command:GameCommand,user:User):Promise<CommandReply>{
    let changed:EngineState|undefined;
    const reply=await transaction(this.db,async c=>{
      const locked=await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE',[command.gameId]);const row=locked.rows[0];
      if(!row)throw new HttpError(404,'GAME_NOT_FOUND','This game was not found.');
      const seat=this.seat(row.state,user.id);if(seat===null)throw new HttpError(403,'NOT_A_PLAYER','Only a player in this game can submit moves.');
      const payloadHash=createHash('sha256').update(JSON.stringify({expectedRevision:command.expectedRevision,action:command.action})).digest('hex');
      const previous=await c.query<{payload_hash:string;reply:Receipt}>('SELECT payload_hash,reply FROM commands WHERE game_id=$1 AND user_id=$2 AND command_id=$3',[row.id,user.id,command.commandId]);
      const prior=previous.rows[0];const now=await databaseNow(c);
      if(prior){if(prior.payload_hash!==payloadHash)throw new HttpError(409,'COMMAND_ID_REUSED','A command identifier cannot be reused for a different action.');return prior.reply.ok?{ok:true as const,acceptedRevision:prior.reply.revision,view:projectGame(row.state,seat,now)}:{ok:false as const,error:prior.reply.error,view:projectGame(row.state,seat,now)};}
      await rateLimit(this.kv,`command:${user.id}`,40,10000);
      const settled=await this.settle(c,row,now);let state=settled.state;let error:ApiError|undefined;
      if(settled.pending)error={code:'CONFIRMING_RESULT',message:'The server is checking the game deadline. Please wait.'};
      else if(state.status==='finished')error={code:'GAME_FINISHED',message:'This game has finished.'};
      else if(state.status==='paused')error={code:'GAME_PAUSED',message:'The game is paused while the service recovers.'};
      else if(state.revision!==command.expectedRevision)error={code:'STALE_REVISION',message:'The game changed. Review the updated board and submit again.'};
      else if(state.lexiconVersion!==this.lexicon.sha256)error={code:'LEXICON_UNAVAILABLE',message:'This game requires a different dictionary version.'};
      else{try{state=applyAction(state,seat,command.action,now,this.lexicon);}catch(e){if(e instanceof EngineError)error={code:e.code,message:e.message};else throw e;}}
      await this.persist(c,row.state,state,settled.gateways,settled.handled);if(state.revision!==row.revision)changed=state;
      const receipt:Receipt=error?{ok:false,error}:{ok:true,revision:state.revision};
      await c.query('INSERT INTO commands(game_id,user_id,command_id,payload_hash,reply,created_at) VALUES($1,$2,$3,$4,$5,$6)',[row.id,user.id,command.commandId,payloadHash,JSON.stringify(receipt),now]);
      const view=projectGame(state,seat,now);return error?{ok:false as const,error,view}:{ok:true as const,view,acceptedRevision:state.revision};
    });
    if(changed)await this.announce(changed);return reply;
  }
  async connect(gameId:string,user:User,member:string,connected:boolean):Promise<GameView>{
    const first=await this.read(gameId);const seat=this.seat(first.state,user.id);if(seat===null)throw new HttpError(403,'NOT_A_PLAYER','This account is not a player in this game.');
    if(connected)await touchPresence(this.kv,gameId,seat,member,Date.now());else await removePresence(this.kv,gameId,seat,member);
    let changed:EngineState|undefined;
    const view=await transaction(this.db,async c=>{
      const result=await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE',[gameId]);const row=result.rows[0]!;const now=await databaseNow(c);
      const settled=await this.settle(c,row,now);let state=settled.state;
      const liveEpochs=await this.livePresence(c,gameId,seat,now);
      if(liveEpochs.length)settled.gateways[seat]=liveEpochs;
      if(!settled.pending&&!dueOutcome(state,now))state=setConnected(state,seat,liveEpochs.length>0,now);
      // settle alone controls recovery and verifies dependency health before resume.
      await this.persist(c,row.state,state,settled.gateways,settled.handled);if(state.revision!==row.revision)changed=state;
      return projectGame(state,seat,now);
    });if(changed)await this.announce(changed);return view;
  }
  async join(seekId:string,user:User):Promise<string>{
    if(!this.health.ready)throw new HttpError(503,'SERVICE_RECOVERING','The service is recovering. Please try again shortly.');
    let state:EngineState|undefined;
    try{
      await transaction(this.db,async c=>{
        // Serialize only game admission, never gameplay, to enforce the configured budget cap.
        await c.query('SELECT pg_advisory_xact_lock(421715012)');const now=await databaseNow(c);
        const found=await c.query<{id:string;user_id:string;minutes:TimeControl;username:string;expires_at:string}>('SELECT s.*,u.username FROM seeks s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s',[seekId]);
        const seek=found.rows[0];if(!seek||Number(seek.expires_at)<=now)throw new HttpError(404,'SEEK_GONE','This game request is no longer available.');
        if(seek.user_id===user.id)throw new HttpError(400,'OWN_SEEK','Another player must join your game request.');
        const count=await c.query<{count:string}>('SELECT count(*) AS count FROM games WHERE status<>\'finished\'');if(Number(count.rows[0]!.count)>=this.config.MAX_ACTIVE_GAMES)throw new HttpError(503,'CAPACITY_REACHED','All game tables are occupied. Please try again shortly.');
        const id=randomUUID();state=createGame({id,players:[{id:seek.user_id,username:seek.username},user],minutes:seek.minutes,lexiconVersion:this.lexicon.sha256,seedWords:this.lexicon.seedWords,now,randomInt},this.lexicon);
        await c.query('INSERT INTO games(id,state,revision,status,created_at,updated_at,next_deadline) VALUES($1,$2,$3,$4,$5,$5,$6)',[id,JSON.stringify(state),state.revision,state.status,now,nextDeadline(state)]);
        for(const seat of [0,1] as const){await c.query('INSERT INTO playing_slots(user_id,game_id) VALUES($1,$2)',[state.players[seat].id,id]);await c.query('INSERT INTO game_players(game_id,user_id,seat) VALUES($1,$2,$3)',[id,state.players[seat].id,seat]);}
        await c.query('INSERT INTO game_events(game_id,revision,kind,at,public_data) VALUES($1,0,\'setup\',$2,$3)',[id,now,JSON.stringify({board:state.board,principalHistory:state.principalHistory})]);
        await c.query('DELETE FROM seeks WHERE user_id=ANY($1::uuid[])',[[seek.user_id,user.id]]);
      });
    }catch(error){if(isPgError(error,'23505'))throw new HttpError(409,'ALREADY_PLAYING','One of the players is already playing another game.');throw error;}
    if(!state)throw new Error('Game creation produced no state');await this.announce(state);return state.id;
  }
  async tick():Promise<void>{
    if(!this.kv.isReady)return;
    const claimed=await transaction(this.db,async c=>{
      const now=await databaseNow(c);await this.health.reconcile(c,now);
      const rows=await c.query<{id:string}>(`SELECT g.id FROM games g WHERE g.status<>'finished' AND (g.next_deadline<=$1 OR g.next_check<=$1 OR EXISTS(SELECT 1 FROM incidents i WHERE g.gateways @> jsonb_build_array(jsonb_build_array(i.epoch_id::text)) AND i.started_at>=g.created_at-3000 AND (i.recovered_at IS NULL OR i.recovered_at>=g.created_at) AND NOT(i.id::text=ANY(g.handled_incidents)))) ORDER BY g.next_check ASC LIMIT 100 FOR UPDATE SKIP LOCKED`,[now]);
      if(rows.rows.length)await c.query('UPDATE games SET next_check=$1 WHERE id=ANY($2::uuid[])',[now+5000,rows.rows.map(row=>row.id)]);
      await c.query('DELETE FROM seeks WHERE expires_at<$1',[now]);await c.query('DELETE FROM sessions WHERE expires_at<$1',[now]);
      return rows.rows;
    });
    // Short, independent game transactions avoid holding a whole batch of locks
    // while waiting for Redis or another game's health checks.
    const queue=[...claimed];const failures:unknown[]=[];
    await Promise.all(Array.from({length:Math.min(4,claimed.length)},async()=>{
      for(let item=queue.shift();item;item=queue.shift()){
        try{
          const changed=await transaction(this.db,async c=>{
            const result=await c.query<GameRow>('SELECT * FROM games WHERE id=$1 FOR UPDATE',[item.id]);const row=result.rows[0];if(!row)return null;
            const now=await databaseNow(c);const settled=await this.settle(c,row,now);
            if(settled.state.revision!==row.revision||settled.handled.length!==row.handled_incidents.length||JSON.stringify(settled.gateways)!==JSON.stringify(row.gateways))await this.persist(c,row.state,settled.state,settled.gateways,settled.handled);
            return settled.state.revision!==row.revision?settled.state:null;
          });
          if(changed)await this.announce(changed);
        }catch(error){failures.push(error);}
      }
    }));
    const entries=await transaction(this.db,async c=>{const now=await databaseNow(c);const result=await c.query<{id:string;game_id:string}>('SELECT id,game_id FROM outbox WHERE claimed_until<$1 ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED',[now]);if(result.rows.length)await c.query('UPDATE outbox SET claimed_until=$1,attempts=attempts+1 WHERE id=ANY($2::bigint[])',[now+10000,result.rows.map(r=>r.id)]);return result.rows;});
    for(const id of new Set(entries.map(e=>e.game_id))){try{await this.announce((await this.read(id)).state);}catch{/* claim expires for retry */}}
    if(failures.length)throw new AggregateError(failures,'Some game transitions will be retried');
  }
}

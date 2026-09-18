import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EngineState } from '@bestword/engine';
import { type Database,type GatewaySeats,databaseNow,transaction } from './db.js';
import type { KeyValue } from './kv.js';

export interface EpochRow {id:string;last_healthy:string;status:string;kind:string}
export interface Incident {id:string;epoch_id:string|null;reason:'deployment'|'infrastructure';started_at:string;recovered_at:string|null}
export class Health {
  readonly epoch=randomUUID();
  ready=false;
  private lastHealthy=0;
  private failedSince:number|null=null;
  private timer:NodeJS.Timeout|undefined;
  private inFlight:Promise<void>|null=null;
  private stopping=false;
  private stopPromise:Promise<void>|null=null;
  constructor(private db:Database,private kv:KeyValue,readonly kind:'api'|'worker'){}
  async start():Promise<void>{
    const checkpoint=await transaction(this.db,async c=>{const now=await databaseNow(c);await c.query('INSERT INTO service_epochs(id,kind,last_healthy,status,started_at) VALUES($1,$2,$3,\'starting\',$3)',[this.epoch,this.kind,now]);return now;});
    this.lastHealthy=checkpoint;
    await this.tick();if(!this.stopping){this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();}
  }
  async tick():Promise<void>{
    if(this.stopping)return;
    if(this.inFlight)return this.inFlight;
    const pending=this.checkpoint();this.inFlight=pending;
    try{await pending;}finally{if(this.inFlight===pending)this.inFlight=null;}
  }
  private async checkpoint():Promise<void>{
    try{
      if(!this.kv.isReady)throw new Error('Key Value unavailable');
      const checkpoint=await transaction(this.db,async c=>{
        // Reconciliation and draining use the same epoch-before-incident lock order.
        const locked=await c.query<EpochRow>('SELECT id,last_healthy,status,kind FROM service_epochs WHERE id=$1 FOR UPDATE',[this.epoch]);
        const epoch=locked.rows[0];if(!epoch)throw new Error('Service epoch is missing');
        // Probe after the lock, so lock contention cannot turn an old Redis probe into a new checkpoint.
        let timeout:NodeJS.Timeout|undefined;
        try{const pong=await Promise.race([this.kv.ping(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Key Value health probe timed out')),1000);timeout.unref();})]);if(pong!=='PONG')throw new Error('Key Value health probe returned an invalid reply');}
        finally{if(timeout)clearTimeout(timeout);}
        const now=await databaseNow(c);
        const previous=Number(epoch.last_healthy);
        if(this.failedSince!==null || (epoch.status!=='starting'&&now-previous>3000)){
          const since=Math.min(this.failedSince??previous,previous);
          await c.query('INSERT INTO incidents(id,epoch_id,reason,started_at,recovered_at) VALUES($1,$2,\'infrastructure\',$3,$4) ON CONFLICT(epoch_id,started_at) DO UPDATE SET recovered_at=EXCLUDED.recovered_at',[randomUUID(),this.epoch,since,now]);
        }
        await c.query('UPDATE service_epochs SET last_healthy=$2,status=\'active\' WHERE id=$1',[this.epoch,now]);
        return now;
      });
      // A failed or ambiguous COMMIT must never advance the locally trusted checkpoint.
      this.lastHealthy=checkpoint;this.failedSince=null;this.ready=!this.stopping;
    }catch{this.ready=false;this.failedSince??=this.lastHealthy||Date.now();}
  }
  async reconcile(c:PoolClient,now:number):Promise<void>{
    // Durable epochs identify crashes even when the process could not record its own outage.
    const stale=await c.query<EpochRow>('SELECT id,last_healthy,status,kind FROM service_epochs WHERE kind=\'api\' AND status=\'active\' AND last_healthy<$1 ORDER BY id FOR UPDATE SKIP LOCKED',[now-3000]);
    for(const epoch of stale.rows){await c.query('UPDATE service_epochs SET status=\'lost\' WHERE id=$1',[epoch.id]);await c.query('INSERT INTO incidents(id,epoch_id,reason,started_at) VALUES($1,$2,\'infrastructure\',$3) ON CONFLICT DO NOTHING',[randomUUID(),epoch.id,epoch.last_healthy]);}
    const live=await c.query('SELECT 1 FROM service_epochs WHERE kind=\'api\' AND status=\'active\' AND last_healthy>=$1 LIMIT 1',[now-2000]);
    if(this.kv.isReady&&live.rowCount)await c.query('UPDATE incidents SET recovered_at=$1 WHERE recovered_at IS NULL',[now]);
  }
  async evidence(c:PoolClient,state:EngineState,gateways:GatewaySeats,now:number,deadline:number|null,handled:string[]=[]):Promise<{pauseAt:number|null;reason:'deployment'|'infrastructure';pending:boolean;healthy:boolean;incidentIds:string[]}> {
    const ids=[...new Set(gateways.flat())];
    const epochs=ids.length?(await c.query<EpochRow>('SELECT id,last_healthy,status,kind FROM service_epochs WHERE id=ANY($1::uuid[])',[ids])).rows:[];
    const incidents=ids.length?(await c.query<Incident>('SELECT * FROM incidents WHERE epoch_id=ANY($1::uuid[]) AND started_at>=$2 AND (recovered_at IS NULL OR recovered_at>=$4) AND NOT(id=ANY($3::uuid[]))',[ids,state.createdAt-3000,handled,state.createdAt])).rows:[];
    let pauseAt:number|null=null,pending=false;let reason:'deployment'|'infrastructure'='infrastructure';const incidentIds:string[]=incidents.map(i=>i.id);
    for(const seat of [0,1] as const){
      if(state.players[seat].passed)continue;
      const group=gateways[seat];
      if(group.length===0){
        if(state.status==='active'){pauseAt=pauseAt===null?state.lastTransitionAt:Math.min(pauseAt,state.lastTransitionAt);if(deadline!==null)pending=true;}
        continue;
      }
      const seatEpochs=epochs.filter(epoch=>group.includes(epoch.id));
      const healthyAlternative=seatEpochs.some(epoch=>epoch.status==='active'&&Number(epoch.last_healthy)>=now-3000&&!incidents.some(incident=>incident.epoch_id===epoch.id));
      if(!healthyAlternative){
        const affected=incidents.filter(incident=>incident.epoch_id!==null&&group.includes(incident.epoch_id));
        for(const incident of affected){incidentIds.push(incident.id);const at=Number(incident.started_at);pauseAt=pauseAt===null?at:Math.min(pauseAt,at);if(incident.reason==='deployment')reason='deployment';}
        if(affected.length===0&&seatEpochs.every(epoch=>epoch.status!=='active'||Number(epoch.last_healthy)<now-3000)){
          const at=seatEpochs.length?Math.max(...seatEpochs.map(epoch=>Number(epoch.last_healthy))):state.lastTransitionAt;
          pauseAt=pauseAt===null?at:Math.min(pauseAt,at);
        }
      }
      if(deadline!==null&&!seatEpochs.some(epoch=>epoch.status==='active'&&Number(epoch.last_healthy)>deadline))pending=true;
    }
    const live=await c.query('SELECT 1 FROM service_epochs WHERE kind=\'api\' AND status=\'active\' AND last_healthy>=$1 LIMIT 1',[now-2000]);
    // READ COMMITTED may reveal an incident created after the caller captured `now`.
    // The caller owns monotonic per-game acceptance times; never return a future transition.
    return {pauseAt:pauseAt===null?null:Math.min(now,Math.max(state.lastTransitionAt,pauseAt)),reason,pending,healthy:this.kv.isReady&&Boolean(live.rowCount),incidentIds:[...new Set(incidentIds)]};
  }
  async stop():Promise<void>{
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;this.ready=false;if(this.timer)clearInterval(this.timer);
    // A heartbeat already in flight must not move the shutdown watermark forward
    // after clients have been told to reconnect. Game transitions clamp this bound.
    const pending=this.drain(this.lastHealthy);this.stopPromise=pending;await pending;
  }
  private async drain(checkpoint:number):Promise<void>{
    await this.inFlight;
    if(this.kind==='api')await transaction(this.db,async c=>{const now=await databaseNow(c);await c.query('UPDATE service_epochs SET status=\'draining\' WHERE id=$1',[this.epoch]);await c.query('INSERT INTO incidents(id,epoch_id,reason,started_at) VALUES($1,$2,\'deployment\',$3) ON CONFLICT DO NOTHING',[randomUUID(),this.epoch,checkpoint>0?Math.min(checkpoint,now):now]);}).catch(()=>{});
    else await this.db.pool.query('UPDATE service_epochs SET status=\'stopped\' WHERE id=$1',[this.epoch]).catch(()=>{});
  }
}

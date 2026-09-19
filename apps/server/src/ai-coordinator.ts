import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type { AiDecisionPosition } from '@bestword/ai';
import { VOWELS,type GameAction } from '@bestword/contracts';
import type { Gaddag } from '@bestword/lexicon';
import { EngineError } from '@bestword/engine';
import type { Config } from './config.js';
import type { AiCapabilities } from './db.js';
import type { Games } from './games.js';
import { claimAiJob,releaseAiClaim,renewAiClaim,type AiClaim } from './ai-jobs.js';

interface Decision {complete:boolean;action:GameAction|null;[key:string]:unknown}
class AiSearchFailure extends Error {}
interface Slot {worker:Worker;busy:boolean;claim:AiClaim|null;cancel:Int32Array|null;pending:{id:string;resolve:(decision:Decision)=>void;reject:(error:Error)=>void}|null}
export class AiCoordinator {
  private readonly slots:Slot[]=[];
  private stopping=false;
  private stopPromise:Promise<void>|null=null;
  private timer:NodeJS.Timeout|undefined;
  private cycles=new Set<Promise<void>>();
  readonly metrics={completed:0,cancelled:0,failures:0,busy:0};
  constructor(readonly games:Games,readonly config:Config,readonly capabilities:AiCapabilities,
    readonly vocabularies:{easy:Gaddag;medium:Gaddag;hard:Gaddag},private readonly onFatal:(error:Error)=>void=error=>console.error(error)){}
  async start():Promise<void>{
    try{for(let index=0;index<this.config.AI_WORKERS;index++)await this.addSlot();if(this.stopping)throw new Error('AI coordinator stopped during startup');await this.games.health.start();}
    catch(error){await this.stop();throw error;}
    this.timer=setInterval(()=>this.schedule(),this.config.WORKER_INTERVAL_MS);this.schedule();
  }
  private async addSlot():Promise<void>{
    const compiled=new URL('./ai-search-thread.js',import.meta.url);
    const worker=new Worker(existsSync(compiled)?compiled:new URL('./ai-search-thread.ts',import.meta.url),{
      workerData:{full:this.config.LEXICON_PATH,easy:this.config.EASY_LEXICON_PATH,medium:this.config.MEDIUM_LEXICON_PATH},
      resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
    const slot:Slot={worker,busy:false,claim:null,cancel:null,pending:null};this.slots.push(slot);
    await new Promise<void>((resolve,reject)=>{
      let ready=false;
      const timeout=setTimeout(()=>reject(new Error('AI search worker did not become ready')),60_000);
      worker.on('message',(message:{type:string;capabilities?:AiCapabilities;id?:string;decision?:Decision;error?:string})=>{
        if(message.type==='ready'){
          clearTimeout(timeout);
          if(JSON.stringify(message.capabilities)!==JSON.stringify(this.capabilities)){reject(new Error('AI worker loaded incompatible vocabulary'));return;}
          ready=true;resolve();return;
        }
        if(message.id!==slot.pending?.id)return;
        const pending=slot.pending;slot.pending=null;if(!pending)return;
        if(message.type==='result'&&message.decision)pending.resolve(message.decision);else pending.reject(new AiSearchFailure(message.error??'AI search failed'));
      });
      worker.on('error',error=>{clearTimeout(timeout);slot.pending?.reject(error);slot.pending=null;if(!ready)reject(error);else this.fatal(error);});
      worker.on('exit',code=>{clearTimeout(timeout);const error=new Error(`AI search worker exited (${code})`);slot.pending?.reject(error);slot.pending=null;if(!ready)reject(error);else this.fatal(error);});
    });
  }
  private fatal(error:Error):void{
    if(this.stopping)return;
    // A dead search thread must stop advertising healthy AI capacity, even when
    // a caller only records the error instead of terminating its process.
    void this.stop().catch(failure=>console.error(failure));this.onFatal(error);
  }
  private schedule():void{
    if(this.stopping||!this.games.health.ready)return;
    for(const slot of this.slots){
      if(slot.busy)continue;slot.busy=true;this.metrics.busy++;
      const cycle=this.run(slot).catch(error=>{this.metrics.failures++;console.error(JSON.stringify({level:'error',message:'AI turn will retry',error:String(error)}));if(error instanceof AiSearchFailure||error instanceof EngineError)this.fatal(error);}).finally(()=>{slot.busy=false;this.metrics.busy--;this.cycles.delete(cycle);});
      this.cycles.add(cycle);
    }
  }
  private async run(slot:Slot):Promise<void>{
    const claim=await claimAiJob(this.games.db,this.games.health.epoch,this.capabilities);if(!claim)return;
    if(this.stopping){await releaseAiClaim(this.games.db,claim);return;}
    slot.claim=claim;const started=performance.now();let renewing=false;
    const cancellation=new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));slot.cancel=cancellation;
    const timer=setInterval(()=>{
      if(renewing)return;renewing=true;
      void renewAiClaim(this.games.db,claim).then(renewed=>{if(!renewed)Atomics.store(cancellation,0,1);}).catch(()=>Atomics.store(cancellation,0,1)).finally(()=>{renewing=false;});
    },2000);
    let watchdog:NodeJS.Timeout|undefined;
    try{
      const state=claim.state,ai=state.ai!,opponent=state.players[ai.seat===0?1:0];
      const input:AiDecisionPosition={board:[...state.board],rack:[...state.players[ai.seat].rack],
        vowels:Object.fromEntries(VOWELS.map(letter=>[letter,state.bag[letter]])) as AiDecisionPosition['vowels'],
        principalHistory:[...state.principalHistory],opponentRackSize:opponent.rack.length,
        consonantsRemaining:state.consonantDrawOrder.length,drawnThisTurn:state.drawnThisTurn[ai.seat],
        opponentPassed:opponent.passed,gameId:state.id,revision:state.moves.length};
      const remainingClockMs=Math.max(0,(state.turnDeadlineAt??claim.now)-claim.now-(performance.now()-started));
      watchdog=setTimeout(()=>this.fatal(new AiSearchFailure('AI search did not acknowledge its clock deadline')),remainingClockMs+2000);
      const decision=await new Promise<Decision>((resolve,reject)=>{
        const id=randomUUID();slot.pending={id,resolve,reject};
        slot.worker.postMessage({type:'search',id,input,difficulty:ai.difficulty,remainingClockMs,lookaheadMs:this.config.AI_LOOKAHEAD_MS,cancellation:cancellation.buffer});
      });
      clearTimeout(watchdog);watchdog=undefined;
      if(this.stopping||Atomics.load(cancellation,0)!==0||!decision.complete){this.metrics.cancelled++;return;}
      const result=await this.games.commitAiClaim(claim,decision,this.vocabularies[ai.difficulty]);
      if(result.accepted)this.metrics.completed++;else this.metrics.cancelled++;
    }finally{clearInterval(timer);if(watchdog)clearTimeout(watchdog);slot.cancel=null;slot.claim=null;await releaseAiClaim(this.games.db,claim);}
  }
  stop():Promise<void>{
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;if(this.timer)clearInterval(this.timer);
    for(const slot of this.slots)if(slot.cancel)Atomics.store(slot.cancel,0,1);
    const pending=(async()=>{
      await this.games.health.stop();
      await Promise.allSettled(this.slots.map(slot=>slot.worker.terminate()));
      await Promise.allSettled([...this.cycles]);
    })();this.stopPromise=pending;return pending;
  }
}

import { parentPort,workerData } from 'node:worker_threads';
import { Gaddag } from '@bestword/lexicon';
import { AI_POLICY_VERSION,decideMove,type AiDecisionPosition } from '@bestword/ai';
import type { AiDifficulty } from '@bestword/contracts';

const settings=workerData as {full:string;easy:string;medium:string};
const [full,easy,medium]=await Promise.all([Gaddag.open(settings.full,{decodeSeeds:false}),Gaddag.open(settings.easy,{decodeSeeds:false}),Gaddag.open(settings.medium,{decodeSeeds:false})]);
const lexicons={easy,medium,hard:full};
parentPort!.postMessage({type:'ready',capabilities:{policyVersion:AI_POLICY_VERSION,vocabularies:{easy:easy.sha256,medium:medium.sha256,hard:full.sha256}}});
parentPort!.on('message',(message:{type:'search';id:string;input:AiDecisionPosition;difficulty:AiDifficulty;remainingClockMs:number;lookaheadMs:number;cancellation:SharedArrayBuffer})=>{
  if(message.type!=='search')return;
  const cancellation=new Int32Array(message.cancellation);const expires=Date.now()+Math.max(0,message.remainingClockMs);
  try{
    const decision=decideMove(message.input,{play:lexicons[message.difficulty],full},{remainingClockMs:message.remainingClockMs,rolloutBudgetMs:message.lookaheadMs,shouldCancel:()=>Atomics.load(cancellation,0)!==0||Date.now()>=expires});
    parentPort!.postMessage({type:'result',id:message.id,decision});
  }catch(error){parentPort!.postMessage({type:'error',id:message.id,error:error instanceof Error?error.message:String(error)});}
});

import { createClient } from 'redis';
import { HttpError } from './errors.js';
export function createKeyValue(url:string){ const client=createClient({url,socket:{connectTimeout:5000,reconnectStrategy:retries=>Math.min(2000,100+retries*200)},disableOfflineQueue:true}); client.on('error',()=>{}); return client; }
export type KeyValue=ReturnType<typeof createKeyValue>;
const LIMIT_SCRIPT="local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n";
export async function rateLimit(kv:KeyValue,key:string,limit:number,windowMs:number):Promise<void>{
  if(!kv.isReady)throw new HttpError(503,'SERVICE_RECOVERING','The service is reconnecting. Please try again shortly.');
  const count=Number(await kv.eval(LIMIT_SCRIPT,{keys:[`bw:limit:${key}`],arguments:[String(windowMs)]}));
  if(count>limit)throw new HttpError(429,'RATE_LIMITED','Please slow down and try again shortly.');
}
const PRESENCE_SCRIPT="redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); return redis.call('ZRANGE',KEYS[1],0,-1)";
export async function presence(kv:KeyValue,gameId:string,seat:number,now:number):Promise<string[]>{return await kv.eval(PRESENCE_SCRIPT,{keys:[`bw:presence:${gameId}:${seat}`],arguments:[String(now)]}) as string[];}
export async function touchPresence(kv:KeyValue,gameId:string,seat:number,member:string,now:number):Promise<void>{const key=`bw:presence:${gameId}:${seat}`;await kv.multi().zAdd(key,{score:now+16000,value:member}).pExpire(key,45000).exec();}
export async function removePresence(kv:KeyValue,gameId:string,seat:number,member:string):Promise<void>{await kv.zRem(`bw:presence:${gameId}:${seat}`,member);}

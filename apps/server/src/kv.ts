import { createClient } from 'redis';
import { HttpError } from './errors.js';
export const KEY_VALUE_REPLY_TIMEOUT_MS=1500;
export function createKeyValue(url:string){
  const client=createClient({url,socket:{connectTimeout:5000,socketTimeout:2000,reconnectStrategy:retries=>Math.min(2000,100+retries*200)},disableOfflineQueue:true,commandOptions:{timeout:KEY_VALUE_REPLY_TIMEOUT_MS},commandsQueueMaxLength:10000});
  client.on('error',()=>{});
  let disposed=false,reconnecting:Promise<unknown>|null=null;
  const restart=()=>{
    if(disposed||reconnecting)return;
    // Flushing the abandoned connection releases every outstanding request and
    // prevents an unbounded queue of replies after a half-open connection.
    if(client.isOpen)client.destroy();
    const pending=client.connect().catch(()=>{});reconnecting=pending;
    void pending.finally(()=>{if(reconnecting===pending)reconnecting=null;});
  };
  const bounded=<T>(request:PromiseLike<T>):Promise<T>=>new Promise((resolve,reject)=>{
    // node-redis's command timeout covers its write queue only. Once written,
    // an unanswered command otherwise holds its PostgreSQL transaction forever.
    const timer=setTimeout(()=>{
      reject(new HttpError(503,'SERVICE_RECOVERING','The service is reconnecting. Your accepted moves are saved.'));
      restart();
    },KEY_VALUE_REPLY_TIMEOUT_MS);
    timer.unref();
    Promise.resolve(request).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
  const lifecycle=new Set(['connect','close','quit','destroy','disconnect','duplicate']);
  const closing=new Set(['close','quit','destroy','disconnect']);
  const batch=async<T>(request:PromiseLike<T>):Promise<T>=>{
    try{return await bounded(request);}catch(error){
      // A full client queue can reject EXEC after already enqueueing MULTI and
      // part of its body. Discard that connection before another request uses it.
      restart();throw error;
    }
  };
  return new Proxy(client,{get(target,key){
    const value=Reflect.get(target,key,target) as unknown;
    if(typeof value!=='function')return value;
    if(key==='multi')return (...args:unknown[])=>{
      const multi=Reflect.apply(value,target,args) as ReturnType<typeof client.multi>;
      const exec=multi.exec.bind(multi),pipeline=multi.execAsPipeline.bind(multi);
      multi.exec=(...options:Parameters<typeof exec>)=>batch(exec(...options));
      multi.execAsPipeline=(...options:Parameters<typeof pipeline>)=>batch(pipeline(...options));
      return multi;
    };
    if(typeof key==='string'&&lifecycle.has(key))return (...args:unknown[])=>{
      if(closing.has(key))disposed=true;
      return Reflect.apply(value,target,args);
    };
    return (...args:unknown[])=>{
      const result=Reflect.apply(value,target,args) as unknown;
      return result&&typeof(result as PromiseLike<unknown>).then==='function'?bounded(result as PromiseLike<unknown>):result;
    };
  }});
}
export type KeyValue=ReturnType<typeof createKeyValue>;
const LIMIT_SCRIPT="local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n";
export async function rateLimit(kv:KeyValue,key:string,limit:number,windowMs:number):Promise<void>{
  if(!kv.isReady)throw new HttpError(503,'SERVICE_RECOVERING','The service is reconnecting. Please try again shortly.');
  const count=Number(await kv.eval(LIMIT_SCRIPT,{keys:[`bw:limit:${key}`],arguments:[String(windowMs)]}));
  if(count>limit)throw new HttpError(429,'RATE_LIMITED','Please slow down and try again shortly.');
}
const PRESENCE_SCRIPT="redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); return redis.call('ZRANGE',KEYS[1],0,-1)";
export async function presence(kv:KeyValue,gameId:string,seat:number,now:number):Promise<string[]>{
  const members:unknown=await kv.eval(PRESENCE_SCRIPT,{keys:[`bw:presence:${gameId}:${seat}`],arguments:[String(now)]});
  if(!Array.isArray(members)||!members.every(member=>typeof member==='string'))throw new HttpError(503,'SERVICE_RECOVERING','The service is reconnecting. Please try again shortly.');
  return members as string[];
}
const TOUCH_PRESENCE_SCRIPT="redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]);redis.call('PEXPIRE',KEYS[1],45000);return 1";
export async function touchPresence(kv:KeyValue,gameId:string,seat:number,member:string,now:number):Promise<void>{await kv.eval(TOUCH_PRESENCE_SCRIPT,{keys:[`bw:presence:${gameId}:${seat}`],arguments:[String(now+16000),member]});}
export async function removePresence(kv:KeyValue,gameId:string,seat:number,member:string):Promise<void>{await kv.zRem(`bw:presence:${gameId}:${seat}`,member);}

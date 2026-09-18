import { createDatabase,migrate } from './db.js';
import { createKeyValue } from './kv.js';
import { readConfig } from './config.js';
import { Health } from './health.js';
import { Games } from './games.js';
import { Gaddag } from '@bestword/lexicon';
import { publishGame } from './realtime.js';

const config=readConfig();const db=createDatabase(config.DATABASE_URL,Math.min(config.DB_POOL_SIZE,5));const kv=createKeyValue(config.REDIS_URL);
await kv.connect();await migrate(db);const lexicon=await Gaddag.open(config.LEXICON_PATH);const health=new Health(db,kv,'worker');await health.start();
const games=new Games(db,kv,health,lexicon,config);games.publish=state=>publishGame(games,state);
let running=false,stopping=false;
const timer=setInterval(()=>{if(running||stopping)return;running=true;void games.tick().catch(error=>console.error(JSON.stringify({level:'error',message:'Worker cycle failed',error:String(error)}))).finally(()=>{running=false;});},config.WORKER_INTERVAL_MS);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopping=true;clearInterval(timer);void(async()=>{while(running)await new Promise(resolve=>setTimeout(resolve,50));await health.stop();await kv.close();await db.pool.end();})().then(()=>process.exit(0)).catch(()=>process.exit(1));});

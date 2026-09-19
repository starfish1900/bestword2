import { AI_POLICY_VERSION } from '@bestword/ai';
import { Gaddag } from '@bestword/lexicon';
import { readConfig } from './config.js';
import { createDatabase,migrate } from './db.js';
import { createKeyValue } from './kv.js';
import { Health } from './health.js';
import { Games } from './games.js';
import { publishGame } from './realtime.js';
import { AiCoordinator } from './ai-coordinator.js';

const config=readConfig(),db=createDatabase(config.DATABASE_URL,Math.min(config.DB_POOL_SIZE,5)),kv=createKeyValue(config.REDIS_URL);
await kv.connect();await migrate(db);
const [full,easy,medium]=await Promise.all([Gaddag.open(config.LEXICON_PATH,{decodeSeeds:false}),Gaddag.open(config.EASY_LEXICON_PATH,{decodeSeeds:false}),Gaddag.open(config.MEDIUM_LEXICON_PATH,{decodeSeeds:false})]);
const capabilities={policyVersion:AI_POLICY_VERSION,vocabularies:{easy:easy.sha256,medium:medium.sha256,hard:full.sha256}};
const health=new Health(db,kv,'ai',capabilities),games=new Games(db,kv,health,full,config);games.publish=state=>publishGame(games,state);
let stopping=false;
const coordinator=new AiCoordinator(games,config,capabilities,{easy,medium,hard:full},error=>{console.error(JSON.stringify({level:'fatal',message:'AI worker unavailable',error:String(error)}));void stop(1);});
async function stop(code:number):Promise<void>{if(stopping)return;stopping=true;await coordinator.stop();await kv.close();await db.pool.end();process.exitCode=code;}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void stop(0);});
await coordinator.start();
console.log(JSON.stringify({level:'info',message:'AI worker ready',epoch:health.epoch,workers:config.AI_WORKERS,vocabularies:capabilities.vocabularies}));

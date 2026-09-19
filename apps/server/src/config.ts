import { z } from 'zod';
import { resolve } from 'node:path';

const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  PORT:z.coerce.number().int().min(1).max(65535).default(3000),
  HOST:z.string().default('127.0.0.1'),
  APP_ORIGIN:z.url().default('http://localhost:3000'),
  DATABASE_URL:z.string().min(1),REDIS_URL:z.string().min(1),
  LEXICON_PATH:z.string().default('data/lexicon.bin.gz'),
  EASY_LEXICON_PATH:z.string().default('data/easy.gaddag'),
  MEDIUM_LEXICON_PATH:z.string().default('data/medium.gaddag'),
  AI_WORKERS:z.coerce.number().int().min(1).max(16).default(1),
  AI_MAX_GAMES:z.coerce.number().int().min(1).default(10),
  AI_LOOKAHEAD_MS:z.coerce.number().int().min(0).max(1500).default(1500),
  SESSION_DAYS:z.coerce.number().int().min(1).max(90).default(30),
  MAX_ACTIVE_GAMES:z.coerce.number().int().min(1).default(100),
  MAX_SPECTATORS_PER_GAME:z.coerce.number().int().min(0).default(10),
  DB_POOL_SIZE:z.coerce.number().int().min(2).max(50).default(10),
  LOG_LEVEL:z.enum(['silent','fatal','error','warn','info','debug','trace']).default('info'),
  METRICS_TOKEN:z.string().optional(),
  WORKER_INTERVAL_MS:z.coerce.number().int().min(50).max(5000).default(250)
});
export type Config=z.infer<typeof schema>;
export function readConfig(env:NodeJS.ProcessEnv=process.env):Config {
  if(env===process.env){try{process.loadEnvFile(resolve('.env'));}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}}
  const config=schema.parse({...env,APP_ORIGIN:env.APP_ORIGIN||env.RENDER_EXTERNAL_URL||undefined});return {...config,LEXICON_PATH:resolve(config.LEXICON_PATH),EASY_LEXICON_PATH:resolve(config.EASY_LEXICON_PATH),MEDIUM_LEXICON_PATH:resolve(config.MEDIUM_LEXICON_PATH)};
}

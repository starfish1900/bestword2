import { readConfig } from './config.js';
import { createDatabase,migrate } from './db.js';
const config=readConfig();const db=createDatabase(config.DATABASE_URL,2);
try{await migrate(db);console.log('BestWord database migrations applied.');}finally{await db.pool.end();}

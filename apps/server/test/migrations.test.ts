import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { AI_USERS,createDatabase,migrate,type Database } from '../src/db.js';

const enabled=process.env.BESTWORD_INTEGRATION==='1';
const base=process.env.BESTWORD_TEST_DATABASE_URL??process.env.DATABASE_URL??'postgresql://bestword:bestword-local@127.0.0.1:54329/bestword';
describe.skipIf(!enabled)('versioned migrations against real PostgreSQL',()=>{
  let admin:Database,db:Database,schema:string,url:string,legacy:string;
  beforeAll(async()=>{
    admin=createDatabase(base,2);
    legacy=await readFile(new URL('./fixtures/schema-v1.sql',import.meta.url),'utf8');
  });
  beforeEach(async()=>{
    schema=`migration_${randomUUID().replaceAll('-','')}`;
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
    const connection=new URL(base);connection.searchParams.set('options',`-c search_path=${schema}`);url=connection.toString();
    db=createDatabase(url,4);
  });
  afterEach(async()=>{await db?.pool.end();if(schema)await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);});
  afterAll(async()=>{await admin?.pool.end();});
  async function versions(){return (await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version);}
  async function botCount(){return Number((await db.pool.query("SELECT count(*) FROM users WHERE kind='ai'")).rows[0].count);}

  it('initializes an empty database with concurrent API and worker starts',async()=>{
    await Promise.all([migrate(db),migrate(db),migrate(db)]);
    expect(await versions()).toEqual([1,2]);expect(await botCount()).toBe(3);
    expect((await db.pool.query("SELECT to_regclass('ai_jobs') AS name")).rows[0].name).toBe('ai_jobs');
  });

  it('upgrades the shipped pre-AI schema without changing accounts, sessions or saved game data',async()=>{
    await db.pool.query(legacy);
    const user=randomUUID(),game=randomUUID(),command=randomUUID();
    const state={id:game,revision:7,moves:[{word:'EXAMPLE',score:35}],fixture:'migration preserves opaque snapshots'};
    await db.pool.query("INSERT INTO users VALUES($1,'LegacyPlayer','legacyplayer','saved-password-hash',123)",[user]);
    await db.pool.query("INSERT INTO sessions VALUES('saved-session',$1,9999999999999)",[user]);
    await db.pool.query("INSERT INTO games(id,state,revision,status,created_at,updated_at) VALUES($1,$2,7,'finished',123,456)",[game,state]);
    await db.pool.query('INSERT INTO game_players VALUES($1,$2,0)',[game,user]);
    await db.pool.query("INSERT INTO game_events VALUES($1,7,'move',456,'{\"score\":35}')",[game]);
    await db.pool.query("INSERT INTO commands VALUES($1,$2,$3,'saved-hash','{\"ok\":true}',456)",[game,user,command]);
    await db.pool.query('INSERT INTO outbox(game_id,revision,created_at) VALUES($1,7,456)',[game]);
    const tables=['sessions','games','game_players','game_events','commands','outbox'];
    const before=await Promise.all(tables.map(async table=>(await db.pool.query(`SELECT * FROM ${table}`)).rows));
    await Promise.all([migrate(db),migrate(db)]);
    expect(await versions()).toEqual([1,2]);expect(await botCount()).toBe(3);
    expect((await db.pool.query('SELECT username,password_hash,kind FROM users WHERE id=$1',[user])).rows[0]).toEqual({username:'LegacyPlayer',password_hash:'saved-password-hash',kind:'human'});
    expect(await Promise.all(tables.map(async table=>(await db.pool.query(`SELECT * FROM ${table}`)).rows))).toEqual(before);
    const applied=(await db.pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    await migrate(db);
    expect((await db.pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(applied);
  });

  it('does not request exclusive game-table locks when an installed database is busy',async()=>{
    await migrate(db);
    const locker=await admin.pool.connect(),startup=createDatabase(url,1);
    try{
      await locker.query('BEGIN');
      await locker.query(`LOCK TABLE "${schema}".users,"${schema}".games,"${schema}".service_epochs IN ROW EXCLUSIVE MODE`);
      await startup.pool.query("SET statement_timeout='300ms'");
      // Control: reproduce the released migration's unnecessary lock request,
      // although the column already exists. PostgreSQL must cancel this wait.
      await expect(startup.pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'human'")).rejects.toMatchObject({code:'57014'});
      // The old IF NOT EXISTS ALTERs block on these real transaction locks.
      // Every startup must finish while the live transaction still holds them.
      await migrate(startup);await migrate(startup);await migrate(startup);
      expect(await versions()).toEqual([1,2]);
    }finally{await locker.query('ROLLBACK');locker.release();await startup.pool.end();}
  });

  async function injectMigrationError(code:string,onlyFirst:boolean){
    await db.pool.query(legacy);
    // Explicit server-side fault fixture. Sequence increments survive rollback,
    // so the test observes the number of complete migration attempts.
    await db.pool.query(`
      CREATE SEQUENCE migration_attempts;
      CREATE FUNCTION reject_migration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.version=2 THEN
          IF nextval('migration_attempts')${onlyFirst?'=1':'>0'} THEN
            RAISE EXCEPTION 'Injected migration failure' USING ERRCODE='${code}';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER migration_fault BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_migration();
    `);
  }
  it('retries a rolled-back deadlock and atomically completes all pending changes',async()=>{
    await injectMigrationError('40P01',true);
    await migrate(db);
    expect(await versions()).toEqual([1,2]);expect(await botCount()).toBe(3);
    expect(Number((await db.pool.query('SELECT last_value FROM migration_attempts')).rows[0].last_value)).toBe(2);
    expect((await db.pool.query('SELECT id FROM users ORDER BY id')).rows.map(r=>r.id)).toEqual(Object.values(AI_USERS).map(u=>u.id));
  });
  it('bounds deadlock retries and leaves the previous schema intact on failure',async()=>{
    await injectMigrationError('40P01',false);
    await expect(migrate(db)).rejects.toMatchObject({code:'40P01'});
    expect(Number((await db.pool.query('SELECT last_value FROM migration_attempts')).rows[0].last_value)).toBe(3);
    expect(await versions()).toEqual([1]);
    expect((await db.pool.query("SELECT to_regclass('ai_jobs') AS name")).rows[0].name).toBeNull();
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='kind'",[schema])).rowCount).toBe(0);
  });
  it('does not retry non-transient migration failures',async()=>{
    await injectMigrationError('23505',false);
    await expect(migrate(db)).rejects.toMatchObject({code:'23505'});
    expect(Number((await db.pool.query('SELECT last_value FROM migration_attempts')).rows[0].last_value)).toBe(1);
    expect(await versions()).toEqual([1]);
  });
});

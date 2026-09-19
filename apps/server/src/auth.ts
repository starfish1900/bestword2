import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { hash,verify,Algorithm } from '@node-rs/argon2';
import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { credentialsSchema,loginSchema,type User } from '@bestword/contracts';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import { type Database,databaseNow,transaction } from './db.js';
import { HttpError,isPgError } from './errors.js';
import { type KeyValue,rateLimit } from './kv.js';

export const SESSION_COOKIE='bw_session';
const ARGON_OPTIONS={algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1,outputLen:32};
export function digestToken(token:string):string{return createHash('sha256').update(token).digest('hex');}
export interface Session {user:User;tokenHash:string;expiresAt:number}
export class Auth {
  onSessionRevoked:(tokenHash:string)=>void=()=>{};
  onUserSessionsRevoked:(userId:string)=>void=()=>{};
  private hashing=0;
  private dummyHash:Promise<string>;
  constructor(private db:Database,private kv:KeyValue,private config:Config){this.dummyHash=hash(randomBytes(32),ARGON_OPTIONS);}
  async lookup(token:string|undefined):Promise<Session|null>{
    if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
    const tokenHash=digestToken(token);
    const result=await this.db.pool.query<{id:string;username:string;expires_at:string}>(`SELECT u.id,u.username,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.kind='human' AND s.expires_at>(extract(epoch from clock_timestamp())*1000)::bigint`,[tokenHash]);
    const row=result.rows[0];return row?{user:{id:row.id,username:row.username},tokenHash,expiresAt:Number(row.expires_at)}:null;
  }
  async require(request:FastifyRequest):Promise<Session>{const session=await this.lookup(request.cookies[SESSION_COOKIE]);if(!session)throw new HttpError(401,'AUTH_REQUIRED','Please sign in to continue.');return session;}
  private async hashPassword(password:string):Promise<string>{if(this.hashing>=2)throw new HttpError(503,'AUTH_BUSY','Sign-in is busy. Please try again shortly.');this.hashing++;try{return await hash(password,ARGON_OPTIONS);}finally{this.hashing--;}}
  private async checkPassword(encoded:string,password:string):Promise<boolean>{if(this.hashing>=2)throw new HttpError(503,'AUTH_BUSY','Sign-in is busy. Please try again shortly.');this.hashing++;try{return await verify(encoded,password);}finally{this.hashing--;}}
  private async createSession(user:User,client:PoolClient):Promise<string>{
    const token=randomBytes(32).toString('hex');const expiresAt=Date.now()+this.config.SESSION_DAYS*86400000;
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digestToken(token),user.id,expiresAt]);
    return token;
  }
  private setSessionCookie(token:string,reply:FastifyReply):void{
    reply.setCookie(SESSION_COOKIE,token,{path:'/',httpOnly:true,secure:this.config.NODE_ENV==='production',sameSite:'lax',maxAge:this.config.SESSION_DAYS*86400});
  }
  register(app:FastifyInstance):void {
    app.get('/api/session',async request=>{const session=await this.lookup(request.cookies[SESSION_COOKIE]);const slot=session?(await this.db.pool.query<{game_id:string}>('SELECT game_id FROM playing_slots WHERE user_id=$1',[session.user.id])).rows[0]:undefined;return {user:session?.user??null,activeGameId:slot?.game_id??null};});
    app.post('/api/auth/register',async(request,reply)=>{
      await rateLimit(this.kv,`register:${request.ip}`,5,3600000);
      const input=credentialsSchema.parse(request.body);const encoded=await this.hashPassword(input.password);
      const user:User={id:randomUUID(),username:input.username};
      let token:string;
      try{token=await transaction(this.db,async c=>{await c.query('INSERT INTO users(id,username,username_key,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',[user.id,user.username,user.username.toLowerCase(),encoded,Date.now()]);return this.createSession(user,c);});}
      catch(error){if(isPgError(error,'23505'))throw new HttpError(409,'USERNAME_TAKEN','That username is already in use.');throw error;}
      this.setSessionCookie(token,reply);return reply.code(201).send({user});
    });
    app.post('/api/auth/login',async(request,reply)=>{
      const input=loginSchema.parse(request.body);
      await rateLimit(this.kv,`login-ip:${request.ip}`,30,60000);
      await rateLimit(this.kv,`login-name:${input.username.toLowerCase()}`,10,60000);
      const result=await this.db.pool.query<{id:string;username:string;password_hash:string}>("SELECT id,username,password_hash FROM users WHERE username_key=$1 AND kind='human'",[input.username.toLowerCase()]);
      const row=result.rows[0];const valid=await this.checkPassword(row?.password_hash??await this.dummyHash,input.password);
      if(!row||!valid)throw new HttpError(401,'INVALID_CREDENTIALS','The username or password is incorrect.');
      const user={id:row.id,username:row.username};
      const token=await transaction(this.db,async c=>{
        const current=await c.query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[user.id]);
        // Password verification is deliberately outside the lock. Recheck its
        // version under the same lock used for password/session revocation.
        if(current.rows[0]?.password_hash!==row.password_hash)throw new HttpError(401,'INVALID_CREDENTIALS','The password changed. Please sign in again.');
        return this.createSession(user,c);
      });
      this.setSessionCookie(token,reply);return {user};
    });
    app.post('/api/auth/logout',async(request,reply)=>{
      const token=request.cookies[SESSION_COOKIE];if(token)await this.db.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digestToken(token)]);
      if(token)this.onSessionRevoked(digestToken(token));
      reply.clearCookie(SESSION_COOKIE,{path:'/'});return {ok:true};
    });
    app.post('/api/auth/password',async(request,reply)=>{
      const session=await this.require(request);await rateLimit(this.kv,`password:${session.user.id}`,5,3600000);
      const input=z.object({currentPassword:z.string().max(128),newPassword:z.string().min(12).max(128)}).strict().parse(request.body);
      const result=await this.db.pool.query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1',[session.user.id]);
      if(!await this.checkPassword(result.rows[0]!.password_hash,input.currentPassword))throw new HttpError(401,'INVALID_CREDENTIALS','The current password is incorrect.');
      const encoded=await this.hashPassword(input.newPassword);
      const token=await transaction(this.db,async c=>{
        const current=await c.query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[session.user.id]);
        if(current.rows[0]?.password_hash!==result.rows[0]!.password_hash)throw new HttpError(401,'INVALID_CREDENTIALS','The password changed. Please sign in again.');
        await c.query('UPDATE users SET password_hash=$2 WHERE id=$1',[session.user.id,encoded]);await c.query('DELETE FROM sessions WHERE user_id=$1',[session.user.id]);
        return this.createSession(session.user,c);
      });
      this.onUserSessionsRevoked(session.user.id);
      this.setSessionCookie(token,reply);return {ok:true};
    });
  }
}

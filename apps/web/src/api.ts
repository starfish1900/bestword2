import type { ApiError, CommandReply, GameCommand, GameView, SyncReply, User } from '@bestword/contracts';
import { io, type Socket } from 'socket.io-client';
export class RequestError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'RequestError'; }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), credentials:'same-origin', headers: body === undefined ? { 'Accept':'application/json' } : { 'Content-Type':'application/json', 'Accept':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  } catch { throw new RequestError('NETWORK', 'Could not reach BestWord. Check your connection and try again.'); }
  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = (data as { error?: ApiError } | null)?.error;
    throw new RequestError(error?.code ?? 'REQUEST_FAILED', error?.message ?? `Request failed (${response.status}). Please try again.`);
  }
  return data as T;
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
let socket: Socket | null = null;
const matchedHandlers = new Set<(gameId:string)=>void>();
export function onGameMatched(handler:(gameId:string)=>void) { matchedHandlers.add(handler); return () => { matchedHandlers.delete(handler); }; }
export function getSocket(): Socket {
  if (!socket) { socket=io({ transports:['websocket'], autoConnect:false, reconnection:true, reconnectionDelay:500, reconnectionDelayMax:3000, timeout:10000 }); socket.on('game:matched', (payload:{gameId:string})=>{ for(const handler of matchedHandlers)handler(payload.gameId); }); }
  if (!socket.connected) socket.connect();
  return socket;
}
export function resetSocket() { socket?.disconnect(); socket = null; }
export function gameRequest(event: 'game:subscribe' | 'game:sync', gameId: string): Promise<CommandReply> {
  return new Promise((resolve, reject) => {
    getSocket().timeout(10000).emit(event, { gameId }, (error: Error | null, reply: CommandReply) => {
      if (error) reject(new RequestError('ACK_TIMEOUT', 'Connection interrupted. Reconnecting to your game…')); else resolve(reply);
    });
  });
}
export function sendCommand(command: GameCommand): Promise<CommandReply> {
  return new Promise((resolve, reject) => {
    getSocket().timeout(10000).emit('game:command', command, (error: Error | null, reply: CommandReply) => {
      if (error) reject(new RequestError('ACK_TIMEOUT', 'Your move is awaiting confirmation. Retry safely when connected.')); else resolve(reply);
    });
  });
}
export function gameSync(gameId:string,revision?:number):Promise<SyncReply> {
  return new Promise((resolve,reject)=>{
    getSocket().timeout(10000).emit('game:sync',{gameId,...(revision===undefined?{}:{revision})},(error:Error|null,reply:SyncReply)=>{
      if(error)reject(new RequestError('ACK_TIMEOUT','Connection interrupted. Reconnecting to your game…'));else resolve(reply);
    });
  });
}
export type SessionReply = { user: User | null; activeGameId?:string|null };
export type UpdateHandler = (view: GameView) => void;

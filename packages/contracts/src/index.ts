import { z } from 'zod';

export const LETTERS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'] as const;
export type Letter = typeof LETTERS[number];
export const VOWELS = ['A','E','I','O','U','Y'] as const;
export type Vowel = typeof VOWELS[number];
export type Seat = 0 | 1;
export type Direction = 'H' | 'V';
export type Board = (Letter | null)[];
export type LetterCounts = Record<Letter, number>;
export type TimeControl = 5 | 15 | 25;
export type AiDifficulty = 'easy' | 'medium' | 'hard';
export interface AiOpponent { seat: Seat; difficulty: AiDifficulty }
export type TileOrigin = 'opening' | Seat | null;
export const BOARD_SIZE = 15;
export const INCREMENT_MS = 30_000;
export const DISCONNECT_GRACE_MS = 25_000;
export const OUTAGE_RECOVERY_MS = 120_000;
export const RULES_VERSION = 'bestword-1';

export const placeWordSchema = z.object({type:z.literal('PLACE_WORD'),row:z.number().int().min(0).max(14),column:z.number().int().min(0).max(14),direction:z.enum(['H','V']),word:z.string().regex(/^[A-Z]{3,15}$/)}).strict();
export const actionSchema = z.discriminatedUnion('type',[placeWordSchema,z.object({type:z.literal('PASS')}).strict(),z.object({type:z.literal('NO_WORDS')}).strict()]);
export type PlaceWordAction = z.infer<typeof placeWordSchema>;
export type GameAction = z.infer<typeof actionSchema>;
export const gameCommandSchema = z.object({commandId:z.uuid(),gameId:z.uuid(),expectedRevision:z.number().int().nonnegative(),action:actionSchema}).strict();
export type GameCommand = z.infer<typeof gameCommandSchema>;
export const credentialsSchema = z.object({username:z.string().regex(/^[A-Za-z0-9]{3,15}$/),password:z.string().min(12).max(128)}).strict();
export const loginSchema = z.object({username:z.string().min(1).max(15),password:z.string().min(1).max(128)}).strict();
export const seekSchema = z.object({minutes:z.union([z.literal(5),z.literal(15),z.literal(25)])}).strict();
export const aiGameSchema = seekSchema.extend({difficulty:z.enum(['easy','medium','hard'])}).strict();

export interface User { id: string; username: string }
export interface PlacedTile { row: number; column: number; letter: Letter }
export interface ScoredWord { word: string; row: number; column: number; direction: Direction; letterSum: number; consonants: number; spans: number; isPrincipal: boolean; score: number }
export interface PublicMove { revision: number; seat: Seat; action: GameAction['type']; at: number; score: number; words: ScoredWord[]; tiles: PlacedTile[]; notation: string | null; word: string | null }
export type RecentMove = Pick<PublicMove,'revision'|'seat'|'action'|'at'|'score'|'word'>;
export type ResultReason = 'both-passed' | 'clock' | 'disconnect' | 'simultaneous-abandonment' | 'infrastructure-aborted' | 'start-cancelled';
export interface GameResult { winner: Seat | null; reason: ResultReason; at: number }
export interface PublicPlayer extends User { score: number; rackSize: number; passed: boolean; connected: boolean }
export interface GamePause { reason: 'deployment' | 'infrastructure'; since: number; recoveryDeadlineAt: number | null }
export interface PublicGame {
  ai?: AiOpponent | null;
  /** Absent only in legacy client fixtures; production responses always specify access. */
  historyAccess?: 'full' | 'recent';
  moveCount?: number; tileOrigins?: TileOrigin[]; lastMoveTiles?: PlacedTile[]; recentMoves?: RecentMove[];
  id: string; revision: number; rulesVersion: string; lexiconVersion: string;
  status: 'waiting' | 'active' | 'paused' | 'finished'; board: Board;
  players: [PublicPlayer, PublicPlayer]; activeSeat: Seat; minutes: TimeControl;
  clocksMs: [number, number]; turnStartedAt: number | null; turnDeadlineAt: number | null;
  startsAt: number | null; serverTime: number;
  vowelsRemaining: Record<Vowel, number>; consonantsRemaining: number;
  principalHistory: string[]; moves: PublicMove[];
  disconnectDeadlines: [number | null, number | null]; pause: GamePause | null;
  result: GameResult | null; spectatorCount: number;
}
export interface PrivatePlayerView { seat: Seat; rack: Letter[]; drawnThisTurn: number; canNoWords: boolean }
export interface GameView { game: PublicGame; you: PrivatePlayerView | null }
export interface ApiError { code: string; message: string; details?: Record<string, unknown> }
export type CommandReply = {ok:true;view:GameView;acceptedRevision?:number} | {ok:false;error:ApiError;view?:GameView};
export type SyncReply = CommandReply | {ok:true;unchanged:true;serverTime:number};
export interface Seek { id:string;host:User;minutes:TimeControl;createdAt:number }
export interface SeekPage {items:Seek[];nextCursor:string|null}
export interface GameSummary {id:string;players:[User,User];scores:[number,number];minutes:TimeControl;status:PublicGame['status'];result:GameResult|null;createdAt:number;spectatorCount:number;ai?:AiOpponent|null}
export interface GamePage {items:GameSummary[];nextCursor:string|null}

export function isVowel(letter: Letter): letter is Vowel { return (VOWELS as readonly string[]).includes(letter); }
export function boardIndex(row:number,column:number):number { return row*BOARD_SIZE+column; }
export function formatNotation(row:number,column:number,direction:Direction,word:string):string { const col=String.fromCharCode(65+column); return `${direction==='H'?`${row+1}${col}`:`${col}${row+1}`} ${word}`; }

import {
  BOARD_SIZE, DISCONNECT_GRACE_MS, INCREMENT_MS, LETTERS, OUTAGE_RECOVERY_MS,
  RULES_VERSION, VOWELS, actionSchema, boardIndex, formatNotation, isVowel,
  type Board, type GameAction, type GamePause, type GameResult, type GameView,
  type Letter, type LetterCounts, type PlaceWordAction, type PlacedTile, type AiOpponent, type TileOrigin,
  type PublicMove, type ScoredWord, type Seat, type TimeControl, type User, type Vowel,
} from '@bestword/contracts';

export interface Lexicon { has(word: string): boolean }
export type RandomInt = (maxExclusive: number) => number;
export class EngineError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'EngineError'; }
}
export const COUNTDOWN_MS = 3_000;
export const INITIAL_COUNTS: Readonly<LetterCounts> = Object.freeze({
  A:16,B:8,C:10,D:10,E:24,F:7,G:10,H:10,I:16,J:4,K:5,L:8,M:8,N:16,
  O:13,P:9,Q:4,R:16,S:16,T:16,U:13,V:7,W:5,X:4,Y:8,Z:4,
});
export const LETTER_VALUES: Readonly<LetterCounts> = Object.freeze({
  A:1,B:8,C:6,D:4,E:1,F:9,G:6,H:6,I:1,J:11,K:7,L:5,M:5,N:3,
  O:1,P:8,Q:11,R:3,S:2,T:4,U:2,V:9,W:7,X:10,Y:2,Z:10,
});
export interface EnginePlayer extends User { score: number; rack: Letter[]; passed: boolean; connected: boolean }
export interface AiConfiguration extends AiOpponent { vocabularyHash: string; policyVersion: string }
export interface PauseMetadata {
  previousStatus: 'waiting' | 'active';
  waitingRemainingMs: number | null;
  disconnectRemainingMs: [number | null, number | null];
}
/** Private persistence snapshot. Never send this object directly over the wire. */
export interface EngineState {
  ai?: AiConfiguration;
  id: string; revision: number; rulesVersion: string; lexiconVersion: string;
  createdAt: number; lastTransitionAt: number;
  status: 'waiting' | 'active' | 'paused' | 'finished';
  board: Board; players: [EnginePlayer, EnginePlayer]; minutes: TimeControl;
  activeSeat: Seat; clocksMs: [number, number]; turnStartedAt: number | null;
  turnDeadlineAt: number | null; startsAt: number | null; waitingDeadlineAt: number | null;
  disconnectDeadlines: [number | null, number | null];
  bag: LetterCounts; consonantDrawOrder: Letter[]; drawnThisTurn: [number, number];
  pendingInitialDraw: boolean; principalHistory: string[]; moves: PublicMove[];
  pause: GamePause | null; pauseMetadata: PauseMetadata | null; result: GameResult | null;
}
export interface CreateGameOptions {
  id: string; players: [User, User]; minutes: TimeControl; lexiconVersion: string;
  seedWords: readonly string[]; now: number; randomInt: RandomInt; firstSeat?: Seat;
}
export interface PlacementEvaluation {
  board: Board; rack: Letter[]; bag: LetterCounts;
  words: ScoredWord[]; tiles: PlacedTile[]; score: number;
}

function fail(code: string, message: string): never { throw new EngineError(code, message); }
function requireWordComposition(word: string): void {
  const letters = [...word] as Letter[];
  if (!letters.some(isVowel) || !letters.some(letter => !isVowel(letter)))
    fail('INVALID_WORD_COMPOSITION', `${word} must contain at least one vowel (A, E, I, O, U or Y) and at least one consonant.`);
}
function checkSeat(seat: Seat): void { if(seat!==0 && seat!==1)fail('INVALID_SEAT','Player seat must be 0 or 1.'); }
function checkTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_TIME', 'Time must be a nonnegative integer in milliseconds.');
}
function checkTransitionTime(state: EngineState, now: number): void {
  checkTime(now);
  if (now < state.lastTransitionAt) fail('TIME_REVERSED', 'A transition cannot precede the latest saved transition.');
}
function checkedRandom(random: RandomInt, maximum: number): number {
  const value = random(maximum);
  if (!Number.isInteger(value) || value < 0 || value >= maximum) fail('INVALID_RANDOM', 'Random integer source returned an out-of-range value.');
  return value;
}
function other(seat: Seat): Seat { return seat === 0 ? 1 : 0; }
function inside(row: number, column: number): boolean { return row >= 0 && row < BOARD_SIZE && column >= 0 && column < BOARD_SIZE; }
function cell(board: Board, row: number, column: number): Letter | null {
  return inside(row, column) ? (board[boardIndex(row, column)] ?? null) : null;
}
function copyState(state: EngineState, now: number): EngineState {
  checkTransitionTime(state, now);
  return {
    ...state, revision: state.revision + 1, lastTransitionAt: now,
    board: [...state.board],
    players: [{...state.players[0],rack:[...state.players[0].rack]}, {...state.players[1],rack:[...state.players[1].rack]}],
    clocksMs:[...state.clocksMs], disconnectDeadlines:[...state.disconnectDeadlines],
    bag:{...state.bag}, consonantDrawOrder:[...state.consonantDrawOrder], drawnThisTurn:[...state.drawnThisTurn],
    principalHistory:[...state.principalHistory], moves:state.moves.map(copyMove),
    pause:state.pause ? {...state.pause} : null,
    pauseMetadata:state.pauseMetadata ? {...state.pauseMetadata,disconnectRemainingMs:[...state.pauseMetadata.disconnectRemainingMs]} : null,
    result:state.result ? {...state.result} : null,
  };
}
function copyMove(move: PublicMove): PublicMove {
  return {...move,tiles:move.tiles.map(tile=>({...tile})),words:move.words.map(word=>({...word}))};
}
function countsOf(letters: readonly Letter[]): LetterCounts {
  const counts = Object.fromEntries(LETTERS.map(letter => [letter, 0])) as LetterCounts;
  for (const letter of letters) counts[letter]++;
  return counts;
}
function clockAt(state: EngineState, seat: Seat, now: number): number {
  return Math.max(0, state.clocksMs[seat] - (state.status === 'active' && state.activeSeat === seat && state.turnStartedAt !== null ? Math.max(0, now - state.turnStartedAt) : 0));
}
function freezeClock(state: EngineState, now: number): void {
  state.clocksMs[state.activeSeat] = clockAt(state, state.activeSeat, now);
  state.turnStartedAt = null;
  state.turnDeadlineAt = null;
}
function drawIntoRack(state: EngineState, seat: Seat): void {
  const rack = state.players[seat].rack;
  const quantity = Math.min(2, 10 - rack.length, state.consonantDrawOrder.length);
  if (quantity < 0) fail('CORRUPT_STATE', 'Rack exceeds its capacity.');
  state.drawnThisTurn[seat] = quantity;
  for (let i = 0; i < quantity; i++) {
    const letter = state.consonantDrawOrder.pop();
    if (!letter || isVowel(letter) || state.bag[letter] < 1) fail('CORRUPT_STATE', 'Consonant draw order does not match the bag.');
    rack.push(letter); state.bag[letter]--;
  }
}
function startTurn(state: EngineState, now: number, draw: boolean): void {
  if (state.players[state.activeSeat].passed) fail('CORRUPT_STATE', 'A passed player cannot start a turn.');
  if (draw) drawIntoRack(state, state.activeSeat);
  state.turnStartedAt = now;
  state.turnDeadlineAt = now + state.clocksMs[state.activeSeat];
}
function everyoneReady(state: EngineState): boolean { return state.players.every(player => player.passed || player.connected); }

interface SeedPair { horizontal: string; vertical: string; horizontalIndex: number; verticalIndex: number }
function crossings(horizontal: string, vertical: string): SeedPair[] {
  const result: SeedPair[] = [];
  if (horizontal === vertical) return result;
  const letters = [...horizontal, ...vertical] as Letter[];
  const combined = countsOf(letters);
  for (let h = 0; h < horizontal.length; h++) for (let v = 0; v < vertical.length; v++) {
    const shared = horizontal[h] as Letter;
    if (shared !== vertical[v]) continue;
    if (LETTERS.every(letter => combined[letter] - (letter === shared ? 1 : 0) <= INITIAL_COUNTS[letter]))
      result.push({horizontal,vertical,horizontalIndex:h,verticalIndex:v});
  }
  return result;
}
function pickSeeds(options: CreateGameOptions, lexicon: Lexicon): SeedPair {
  const candidates = options.seedWords;
  if (candidates.length < 2) fail('INVALID_SETUP', 'At least two setup candidates are required.');
  const valid = (word: string): boolean => {
    if (!/^[A-Z]{9,12}$/.test(word) || !lexicon.has(word)) return false;
    requireWordComposition(word);
    return true;
  };
  // A fixed attempt limit keeps malformed candidate sources from blocking the server.
  for (let attempt = 0; attempt < Math.min(2_000, candidates.length * candidates.length * 2); attempt++) {
    const h = checkedRandom(options.randomInt, candidates.length);
    const v = (h + 1 + checkedRandom(options.randomInt, candidates.length - 1)) % candidates.length;
    const horizontal = candidates[h]!; const vertical = candidates[v]!;
    if (!valid(horizontal) || !valid(vertical)) fail('INVALID_SETUP', 'Setup candidates must be dictionary words of length 9–12.');
    const choices = crossings(horizontal, vertical);
    if (choices.length) return choices[checkedRandom(options.randomInt, choices.length)]!;
  }
  // Exhaustive fallback for small test/custom dictionaries; large providers should retry with a fresh random source.
  for (let h = 0; h < Math.min(candidates.length, 64); h++) for (let v = h + 1; v < Math.min(candidates.length, 64); v++) {
    const horizontal = candidates[h]!; const vertical = candidates[v]!;
    if (!valid(horizontal) || !valid(vertical)) continue;
    const choices = crossings(horizontal, vertical);
    if (choices.length) return choices[checkedRandom(options.randomInt, choices.length)]!;
  }
  return fail('SETUP_UNAVAILABLE', 'No feasible crossing was found among setup candidates.');
}

export function createGame(options: CreateGameOptions, lexicon: Lexicon): EngineState {
  checkTime(options.now);
  if (![5,15,25].includes(options.minutes)) fail('INVALID_TIME_CONTROL', 'Choose a 5, 15, or 25 minute game.');
  if (options.players[0].id === options.players[1].id) fail('SAME_PLAYER', 'A game requires two distinct players.');
  const pair = pickSeeds(options, lexicon);
  const board: Board = Array<Letter | null>(BOARD_SIZE * BOARD_SIZE).fill(null);
  const bag: LetterCounts = {...INITIAL_COUNTS};
  const top = checkedRandom(options.randomInt, BOARD_SIZE - pair.vertical.length + 1);
  const left = checkedRandom(options.randomInt, BOARD_SIZE - pair.horizontal.length + 1);
  const horizontalRow = top + pair.verticalIndex;
  const verticalColumn = left + pair.horizontalIndex;
  const place = (word: string, row: number, column: number, dr: number, dc: number): void => {
    [...word].forEach((value, index) => {
      const letter = value as Letter; const square = boardIndex(row + dr * index, column + dc * index);
      if (board[square] === null) { board[square] = letter; bag[letter]--; }
      else if (board[square] !== letter) fail('CORRUPT_SETUP', 'Setup words do not agree at their crossing.');
    });
  };
  place(pair.horizontal,horizontalRow,left,0,1); place(pair.vertical,top,verticalColumn,1,0);
  const drawOrder: Letter[] = [];
  for (const letter of LETTERS) if (!isVowel(letter)) for (let i=0;i<bag[letter];i++) drawOrder.push(letter);
  for (let i=drawOrder.length-1;i>0;i--) { const j=checkedRandom(options.randomInt,i+1); [drawOrder[i],drawOrder[j]]=[drawOrder[j]!,drawOrder[i]!]; }
  const firstSeat = options.firstSeat ?? checkedRandom(options.randomInt,2) as Seat;
  if (firstSeat !== 0 && firstSeat !== 1) fail('INVALID_SEAT','First player must be seat 0 or 1.');
  return {
    id:options.id,revision:0,rulesVersion:RULES_VERSION,lexiconVersion:options.lexiconVersion,
    createdAt:options.now,lastTransitionAt:options.now,status:'waiting',board,minutes:options.minutes,
    players:[{...options.players[0],score:0,rack:[],passed:false,connected:false},{...options.players[1],score:0,rack:[],passed:false,connected:false}],
    activeSeat:firstSeat,clocksMs:[options.minutes*60_000,options.minutes*60_000],turnStartedAt:null,turnDeadlineAt:null,
    startsAt:null,waitingDeadlineAt:options.now+DISCONNECT_GRACE_MS,disconnectDeadlines:[null,null],bag,
    consonantDrawOrder:drawOrder,drawnThisTurn:[0,0],pendingInitialDraw:true,
    principalHistory:[pair.horizontal,pair.vertical],moves:[],pause:null,pauseMetadata:null,result:null,
  };
}

export function calculateWordScore(letterSum:number,consonants:number,spans:number,isPrincipal:boolean):number {
  return letterSum * (isPrincipal ? consonants + spans : spans > 0 ? 2 : 1);
}
function scoreWord(before: Board, after: Board, row: number, column: number, direction: 'H' | 'V', isPrincipal: boolean): ScoredWord {
  const dr = direction === 'V' ? 1 : 0; const dc = direction === 'H' ? 1 : 0;
  let word=''; const occupied: boolean[]=[];
  for (let r=row,c=column;inside(r,c) && cell(after,r,c)!==null;r+=dr,c+=dc) {
    word+=cell(after,r,c)!; occupied.push(cell(before,r,c)!==null);
  }
  const first=occupied.indexOf(true); const last=occupied.lastIndexOf(true);
  let spans=0; if (first>=0 && last>first) for(let i=first+1;i<last;i++) if(!occupied[i]) spans++;
  let letterSum=0,consonants=0;
  for(const value of word) { const letter=value as Letter; letterSum+=LETTER_VALUES[letter]; if(!isVowel(letter)) consonants++; }
  return {word,row,column,direction,letterSum,consonants,spans,isPrincipal,score:calculateWordScore(letterSum,consonants,spans,isPrincipal)};
}
/** Validate and score without changing clocks, drawing tiles, or mutating the input. */
export function evaluatePlacement(state: EngineState, seat: Seat, action: PlaceWordAction, lexicon: Lexicon): PlacementEvaluation {
  checkSeat(seat);
  const parsed=actionSchema.safeParse(action);
  if(!parsed.success || parsed.data.type!=='PLACE_WORD') fail('INVALID_ACTION','The placement is not well formed.');
  const {row,column,direction,word}=action;
  const dr=direction==='V'?1:0,dc=direction==='H'?1:0;
  if(!inside(row+dr*(word.length-1),column+dc*(word.length-1))) fail('OUT_OF_BOUNDS','The word extends beyond the board.');
  if(cell(state.board,row-dr,column-dc)!==null || cell(state.board,row+dr*word.length,column+dc*word.length)!==null)
    fail('NON_MAXIMAL_WORD','Include all existing letters directly before and after the word.');
  if(!lexicon.has(word)) fail('INVALID_WORD',`${word} is not in the dictionary.`);
  requireWordComposition(word);
  if(state.principalHistory.includes(word)) fail('REPEATED_PRINCIPAL','That principal word has already been played.');
  const board=[...state.board]; const tiles:PlacedTile[]=[]; let connected=false;
  for(let i=0;i<word.length;i++) {
    const r=row+dr*i,c=column+dc*i,letter=word[i] as Letter,existing=cell(state.board,r,c);
    if(existing!==null) { if(existing!==letter) fail('LETTER_CONFLICT','Existing letters cannot be replaced.'); connected=true; }
    else {
      tiles.push({row:r,column:c,letter}); board[boardIndex(r,c)]=letter;
      if([[r-1,c],[r+1,c],[r,c-1],[r,c+1]].some(([nr,nc])=>cell(state.board,nr!,nc!)!==null)) connected=true;
    }
  }
  if(tiles.length<2) fail('TOO_FEW_TILES','Place at least two new tiles.');
  if(!connected) fail('DISCONNECTED_WORD','The word must connect to the existing board.');
  const rack=[...state.players[seat].rack],bag={...state.bag};
  for(const {letter} of tiles) {
    if(isVowel(letter)) { if(bag[letter]<1) fail('VOWEL_UNAVAILABLE',`No ${letter} vowels remain in the bag.`); bag[letter]--; }
    else { const index=rack.indexOf(letter); if(index<0) fail('CONSONANT_UNAVAILABLE',`${letter} is not available on your rack.`); rack.splice(index,1); }
  }
  const words=[scoreWord(state.board,board,row,column,direction,true)];
  const crossDirection=direction==='H'?'V':'H',cr=dc,cc=dr;
  for(const tile of tiles) {
    let r=tile.row,c=tile.column;
    while(cell(board,r-cr,c-cc)!==null) { r-=cr;c-=cc; }
    const secondary=scoreWord(state.board,board,r,c,crossDirection,false);
    if(secondary.word.length===1) continue;
    if(secondary.word.length<3 || secondary.word.length>15 || !lexicon.has(secondary.word))
      fail('INVALID_SECONDARY',`${secondary.word} is not a valid 3–15 letter crossword.`);
    requireWordComposition(secondary.word);
    words.push(secondary);
  }
  return {board,rack,bag,words,tiles,score:words.reduce((sum,scored)=>sum+scored.score,0)};
}

/** Returns an outcome candidate; the caller must establish service health before applying it. */
export function dueOutcome(state: EngineState, now: number): GameResult | null {
  checkTime(now);
  if(state.status==='finished') return null;
  if(state.status==='paused') {
    const deadline=state.pause?.recoveryDeadlineAt;
    return deadline!==null && deadline!==undefined && now>=deadline && !everyoneReady(state)
      ? {winner:null,reason:'infrastructure-aborted',at:deadline}:null;
  }
  if(state.status==='waiting') return state.waitingDeadlineAt!==null && now>=state.waitingDeadlineAt && !everyoneReady(state)
    ? {winner:null,reason:'start-cancelled',at:state.waitingDeadlineAt}:null;
  const candidates:{seat:Seat;at:number;reason:'clock'|'disconnect'}[]=[];
  if(state.turnDeadlineAt!==null && now>=state.turnDeadlineAt && !state.players[state.activeSeat].passed)
    candidates.push({seat:state.activeSeat,at:state.turnDeadlineAt,reason:'clock'});
  for(const seat of [0,1] as const) {
    const at=state.disconnectDeadlines[seat];
    if(!state.players[seat].passed && at!==null && now>=at) candidates.push({seat,at,reason:'disconnect'});
  }
  candidates.sort((a,b)=>a.at-b.at || (a.reason==='clock'?-1:1));
  const first=candidates[0]; if(!first) return null;
  if(candidates.some(candidate=>candidate.at===first.at && candidate.seat!==first.seat))
    return {winner:null,reason:'simultaneous-abandonment',at:first.at};
  return {winner:other(first.seat),reason:first.reason,at:first.at};
}
function finish(state: EngineState, result: GameResult, now: number): void {
  freezeClock(state,Math.min(now,result.at));
  state.status='finished';state.result=result;state.startsAt=null;state.waitingDeadlineAt=null;
  state.disconnectDeadlines=[null,null];state.pause=null;state.pauseMetadata=null;
}
export function adjudicate(state: EngineState, now: number): EngineState {
  const outcome=dueOutcome(state,now);if(!outcome)return state;
  const next=copyState(state,now);finish(next,outcome,now);return next;
}
function rejectDue(state: EngineState, now: number): void {
  if(dueOutcome(state,now)) fail('DEADLINE_REACHED','A game deadline has been reached.');
}
export function applyAction(state: EngineState, seat: Seat, action: GameAction, now: number, lexicon: Lexicon): EngineState {
  checkSeat(seat);
  checkTransitionTime(state,now);
  if(state.status!=='active' || state.turnStartedAt===null) fail('NOT_ACTIVE','The game is not accepting moves yet.');
  rejectDue(state,now);
  if(seat!==state.activeSeat || state.players[seat].passed) fail('NOT_YOUR_TURN','It is not your turn.');
  if(!state.players[seat].connected) fail('NOT_CONNECTED','Reconnect before playing.');
  if(!actionSchema.safeParse(action).success) fail('INVALID_ACTION','The action is not well formed.');
  if(action.type==='NO_WORDS' && (state.drawnThisTurn[seat]===0 || state.players[other(seat)].passed))
    fail('NO_WORDS_UNAVAILABLE','NO WORDS requires a consonant drawn this turn and an opponent who has not passed.');
  const placement=action.type==='PLACE_WORD'?evaluatePlacement(state,seat,action,lexicon):null;
  const next=copyState(state,now);freezeClock(next,now);next.clocksMs[seat]+=INCREMENT_MS;
  if(placement) { next.board=placement.board;next.bag=placement.bag;next.players[seat].rack=placement.rack;next.players[seat].score+=placement.score;next.principalHistory.push(action.type==='PLACE_WORD'?action.word:''); }
  if(action.type==='PASS') {next.players[seat].passed=true;next.disconnectDeadlines[seat]=null;}
  next.moves.push({revision:next.revision,seat,action:action.type,at:now,score:placement?.score??0,words:placement?.words??[],tiles:placement?.tiles??[],notation:action.type==='PLACE_WORD'?formatNotation(action.row,action.column,action.direction,action.word):null,word:action.type==='PLACE_WORD'?action.word:null});
  if(next.players.every(player=>player.passed)) {
    const difference=next.players[0].score-next.players[1].score;
    finish(next,{winner:difference===0?null:difference>0?0:1,reason:'both-passed',at:now},now);
  } else {
    next.activeSeat=next.players[other(seat)].passed?seat:other(seat);
    startTurn(next,now,true);
  }
  return next;
}

export function setConnected(state: EngineState, seat: Seat, connected: boolean, now: number): EngineState {
  checkSeat(seat);
  checkTransitionTime(state,now);
  if(state.players[seat].connected===connected) return state;
  if(state.status!=='finished') rejectDue(state,now);
  const next=copyState(state,now);next.players[seat].connected=connected;
  if(state.status==='active' && !state.players[seat].passed) next.disconnectDeadlines[seat]=connected?null:now+DISCONNECT_GRACE_MS;
  if(state.status==='waiting') next.startsAt=everyoneReady(next)?now+COUNTDOWN_MS:null;
  return next;
}
export function startIfReady(state: EngineState, now: number): EngineState {
  checkTransitionTime(state,now);
  if((state.status!=='waiting' && state.status!=='active') || state.startsAt===null || now<state.startsAt) return state;
  if(state.status==='waiting' && !everyoneReady(state)) return state;
  rejectDue(state,now);
  const next=copyState(state,now),start=state.startsAt;
  next.status='active';next.startsAt=null;next.waitingDeadlineAt=null;
  startTurn(next,start,next.pendingInitialDraw);next.pendingInitialDraw=false;return next;
}
export function pauseGame(state: EngineState, now: number, reason: 'deployment'|'infrastructure'='infrastructure'): EngineState {
  checkTransitionTime(state,now);if(state.status==='finished' || state.status==='paused')return state;
  const next=copyState(state,now);
  next.pauseMetadata={previousStatus:state.status,waitingRemainingMs:state.waitingDeadlineAt===null?null:Math.max(0,state.waitingDeadlineAt-now),disconnectRemainingMs:state.disconnectDeadlines.map(at=>at===null?null:Math.max(0,at-now)) as [number|null,number|null]};
  freezeClock(next,now);next.status='paused';next.pause={reason,since:now,recoveryDeadlineAt:null};
  next.startsAt=null;next.waitingDeadlineAt=null;next.disconnectDeadlines=[null,null];
  for(const player of next.players) player.connected=false;
  return next;
}
export function beginRecovery(state: EngineState, now: number): EngineState {
  checkTransitionTime(state,now);
  if(state.status!=='paused' || state.pause===null)fail('NOT_PAUSED','Only a paused game can begin recovery.');
  if(state.pause.recoveryDeadlineAt!==null)return state;
  const next=copyState(state,now);next.pause!.recoveryDeadlineAt=now+OUTAGE_RECOVERY_MS;return next;
}
/** Call once for a NEW infrastructure incident, never for repeated scans of the same incident. */
export function restartRecovery(state: EngineState, now: number, reason: 'deployment'|'infrastructure'='infrastructure'): EngineState {
  checkTransitionTime(state,now);
  if(state.status!=='paused')return pauseGame(state,now,reason);
  if(state.pause?.recoveryDeadlineAt===null && state.pause.reason===reason && state.players.every(player=>!player.connected))return state;
  const next=copyState(state,now);
  if(next.pause===null)fail('CORRUPT_STATE','A paused game is missing its pause details.');
  next.pause.recoveryDeadlineAt=null;next.pause.reason=reason;
  for(const player of next.players)player.connected=false;
  return next;
}
export function resumeGame(state: EngineState, now: number): EngineState {
  checkTransitionTime(state,now);
  if(state.status!=='paused' || state.pauseMetadata===null || state.pause?.recoveryDeadlineAt===null)fail('NOT_RECOVERING','The game is not ready to resume.');
  rejectDue(state,now);
  if(!everyoneReady(state))fail('PLAYERS_NOT_READY','Wait for every remaining player to reconnect.');
  const next=copyState(state,now);
  next.status=state.pauseMetadata.previousStatus;
  next.waitingDeadlineAt=state.pauseMetadata.waitingRemainingMs===null?null:now+state.pauseMetadata.waitingRemainingMs;
  next.startsAt=now+COUNTDOWN_MS;next.pause=null;next.pauseMetadata=null;
  return next;
}
export function nextDeadline(state: EngineState): number | null {
  if(state.status==='finished')return null;
  if(state.status==='paused')return state.pause?.recoveryDeadlineAt??null;
  const deadlines:number[]=[];
  if(state.startsAt!==null)deadlines.push(state.startsAt);
  if(state.status==='waiting' && !everyoneReady(state) && state.waitingDeadlineAt!==null)deadlines.push(state.waitingDeadlineAt);
  if(state.status==='active') {
    if(state.turnDeadlineAt!==null)deadlines.push(state.turnDeadlineAt);
    for(const seat of [0,1] as const)if(!state.players[seat].passed && state.disconnectDeadlines[seat]!==null)deadlines.push(state.disconnectDeadlines[seat]!);
  }
  return deadlines.length?Math.min(...deadlines):null;
}

export function projectGame(state: EngineState, viewerSeat: Seat|null, now: number, spectatorCount=0, historyAccess:'full'|'recent'='full'): GameView {
  if(viewerSeat!==null)checkSeat(viewerSeat);
  checkTime(now);
  const vowelsRemaining=Object.fromEntries(VOWELS.map(letter=>[letter,state.bag[letter]])) as Record<Vowel,number>;
  const tileOrigins:TileOrigin[]=state.board.map(letter=>letter?'opening':null);
  for(const move of state.moves)for(const tile of move.tiles)tileOrigins[boardIndex(tile.row,tile.column)]=move.seat;
  return {
    game:{
      ai:state.ai?{seat:state.ai.seat,difficulty:state.ai.difficulty}:null,
      historyAccess,moveCount:state.moves.length,tileOrigins,
      lastMoveTiles:state.moves.at(-1)?.tiles.map(tile=>({...tile}))??[],
      recentMoves:state.moves.slice(-3).map(({revision,seat,action,at,score,word})=>({revision,seat,action,at,score,word})),
      id:state.id,revision:state.revision,rulesVersion:state.rulesVersion,lexiconVersion:state.lexiconVersion,
      status:state.status,board:[...state.board],
      players:state.players.map(({id,username,score,rack,passed,connected})=>({id,username,score,rackSize:rack.length,passed,connected})) as GameView['game']['players'],
      activeSeat:state.activeSeat,minutes:state.minutes,clocksMs:[clockAt(state,0,now),clockAt(state,1,now)],
      turnStartedAt:state.turnStartedAt,turnDeadlineAt:state.turnDeadlineAt,startsAt:state.startsAt,serverTime:now,
      vowelsRemaining,consonantsRemaining:LETTERS.reduce((sum,letter)=>sum+(isVowel(letter)?0:state.bag[letter]),0),
      principalHistory:historyAccess==='full'?[...state.principalHistory]:state.principalHistory.slice(0,2),moves:historyAccess==='full'?state.moves.map(copyMove):[],
      disconnectDeadlines:[...state.disconnectDeadlines],pause:state.pause?{...state.pause}:null,result:state.result?{...state.result}:null,spectatorCount,
    },
    you:viewerSeat===null?null:{seat:viewerSeat,rack:[...state.players[viewerSeat].rack],drawnThisTurn:state.drawnThisTurn[viewerSeat],canNoWords:state.status==='active' && state.turnStartedAt!==null && state.activeSeat===viewerSeat && !state.players[viewerSeat].passed && state.drawnThisTurn[viewerSeat]>0 && !state.players[other(viewerSeat)].passed && dueOutcome(state,now)===null},
  };
}

/** Conservation includes the bag and racks; the private draw order mirrors the consonant bag, not extra tiles. */
export function assertStateInvariants(state: EngineState): void {
  if(state.board.length!==225)fail('CORRUPT_STATE','Board must contain 225 squares.');
  if([...state.board,...state.players[0].rack,...state.players[1].rack].some(letter=>letter!==null && !(LETTERS as readonly string[]).includes(letter)))fail('CORRUPT_STATE','An unknown tile is present.');
  const counts=countsOf([...state.board.filter((value):value is Letter=>value!==null),...state.players[0].rack,...state.players[1].rack]);
  for(const letter of LETTERS) {
    if(!Number.isInteger(state.bag[letter]) || state.bag[letter]<0 || counts[letter]+state.bag[letter]!==INITIAL_COUNTS[letter])fail('CORRUPT_STATE',`Tile conservation failed for ${letter}.`);
  }
  const drawCounts=countsOf(state.consonantDrawOrder);
  for(const letter of LETTERS)if(drawCounts[letter]!== (isVowel(letter)?0:state.bag[letter]))fail('CORRUPT_STATE','Consonant draw order differs from the bag.');
  for(const player of state.players)if(player.rack.length>10 || player.rack.some(isVowel))fail('CORRUPT_STATE','Rack contains invalid tiles.');
  for(const player of state.players)if(!Number.isSafeInteger(player.score) || player.score<0)fail('CORRUPT_STATE','Score is invalid.');
  for(const clock of state.clocksMs)if(!Number.isSafeInteger(clock) || clock<0)fail('CORRUPT_STATE','Clock is invalid.');
  if(state.drawnThisTurn.some(count=>!Number.isInteger(count) || count<0 || count>2))fail('CORRUPT_STATE','Draw count is invalid.');
  if((state.turnStartedAt===null)!==(state.turnDeadlineAt===null))fail('CORRUPT_STATE','Clock anchor and deadline disagree.');
  if(state.turnStartedAt!==null && (state.status!=='active' || state.turnDeadlineAt!==state.turnStartedAt+state.clocksMs[state.activeSeat]))fail('CORRUPT_STATE','Active clock deadline is invalid.');
  if((state.status==='finished')!==(state.result!==null))fail('CORRUPT_STATE','Final status and result disagree.');
  if((state.status==='paused')!==(state.pause!==null && state.pauseMetadata!==null))fail('CORRUPT_STATE','Pause metadata and status disagree.');
  for(const seat of [0,1] as const)if(state.players[seat].passed && state.disconnectDeadlines[seat]!==null)fail('CORRUPT_STATE','A passed player has a disconnect deadline.');
  if(new Set(state.principalHistory).size!==state.principalHistory.length)fail('CORRUPT_STATE','Principal history contains a duplicate.');
  if(state.status==='active' && state.players[state.activeSeat].passed)fail('CORRUPT_STATE','Passed player remains active.');
}

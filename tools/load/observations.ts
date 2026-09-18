import { LETTERS,VOWELS,type GameView,type Letter,type Seat } from '@bestword/contracts';

export interface HistogramSummary {count:number;p50:number|null;p95:number|null;p99:number|null;max:number|null;resolutionMs:number;overflowThresholdMs:number}
/** Quantiles round upward to 1ms; the 10s bin is right-censored. Max stays exact. */
export class Histogram {
  private readonly bins=new Float64Array(10001);
  private count=0;
  private maximum=0;
  add(ms:number):void{
    if(!Number.isFinite(ms)||ms<0)throw new RangeError('Histogram observations must be finite, nonnegative milliseconds');
    const bin=Math.min(10000,Math.ceil(ms));this.bins[bin]=this.bins[bin]!+1;this.count++;this.maximum=Math.max(this.maximum,ms);
  }
  summary():HistogramSummary{
    const values:[number|null,number|null,number|null]=[null,null,null];
    if(this.count){
      const ranks=[.5,.95,.99].map(percentile=>Math.ceil(this.count*percentile));let cumulative=0,target=0;
      for(let bin=0;bin<this.bins.length&&target<ranks.length;bin++){
        cumulative+=this.bins[bin]!;
        while(target<ranks.length&&cumulative>=ranks[target]!){values[target]=bin;target++;}
      }
    }
    return {count:this.count,p50:values[0],p95:values[1],p99:values[2],max:this.count?this.maximum:null,resolutionMs:1,overflowThresholdMs:10000};
  }
}

export interface ExpectedWireView {seat:Seat|null;playerIds:[string,string];knownGame:boolean;racks:[readonly Letter[],readonly Letter[]];drawn:[number,number]}
const TOP=['game','you'] as const;
const GAME=['id','revision','rulesVersion','lexiconVersion','status','board','players','activeSeat','minutes','clocksMs','turnStartedAt','turnDeadlineAt','startsAt','serverTime','vowelsRemaining','consonantsRemaining','principalHistory','moves','disconnectDeadlines','pause','result','spectatorCount'] as const;
const PLAYER=['id','username','score','rackSize','passed','connected'] as const;
const PRIVATE=['seat','rack','drawnThisTurn','canNoWords'] as const;
const MOVE=['revision','seat','action','at','score','words','tiles','notation','word'] as const;
const WORD=['word','row','column','direction','letterSum','consonants','spans','isPrincipal','score'] as const;
const TILE=['row','column','letter'] as const;
const PAUSE=['reason','since','recoveryDeadlineAt'] as const;
const RESULT=['winner','reason','at'] as const;
const LETTER_SET=new Set<string>(LETTERS);
const FORBIDDEN=new Set(['rack','racks','bag','consonantDrawOrder','drawnThisTurn','password','password_hash','token','token_hash','session','sessions','draft','drafts']);
type RecordValue=Record<string,unknown>;
const record=(value:unknown):value is RecordValue=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const seat=(value:unknown)=>value===0||value===1;

/** Validate every packet before filtering stale/unknown game IDs. Never throw on wire input. */
export function validateWireView(view:GameView,expected:ExpectedWireView):string[]{
  const errors:string[]=[];
  const add=(message:string)=>{if(errors.length<40)errors.push(message);};
  const fields=(value:unknown,allowed:readonly string[],path:string):value is RecordValue=>{
    if(!record(value)){add(`${path} must be an object`);return false;}
    for(const key of Object.keys(value))if(!allowed.includes(key))add(`${path}.${key} is not an allowed wire field`);
    for(const key of allowed)if(!Object.hasOwn(value,key))add(`${path}.${key} is missing`);
    return true;
  };
  const check=(condition:boolean,message:string)=>{if(!condition)add(message);};
  const coordinate=(value:unknown)=>integer(value)&&(value as number)<15;
  const letters=(value:unknown):value is Letter[]=>Array.isArray(value)&&value.every(letter=>typeof letter==='string'&&LETTER_SET.has(letter));
  const scanPublic=(value:unknown)=>{
    const pending:Array<{value:unknown;path:string;depth:number}>=[{value,path:'game',depth:0}],seen=new WeakSet<object>();let visited=0;
    while(pending.length){
      const item=pending.pop()!;if(typeof item.value!=='object'||item.value===null)continue;
      if(seen.has(item.value))continue;seen.add(item.value);
      if(++visited>20000||item.depth>40){add('Public view exceeds the bounded validation depth/size');return;}
      for(const [key,child]of Object.entries(item.value)){
        if(FORBIDDEN.has(key))add(`${item.path}.${key} exposes a forbidden private field`);
        if(typeof child==='object'&&child!==null)pending.push({value:child,path:`${item.path}.${key}`,depth:item.depth+1});
      }
    }
  };
  try{
    if(!fields(view,TOP,'view'))return errors;
    check(expected.knownGame,'Packet refers to an unknown game');
    check(expected.seat===null||seat(expected.seat),'Expected viewer seat is invalid');
    const game=view.game as unknown;
    if(fields(game,GAME,'game')){
      scanPublic(game);
      for(const name of ['id','rulesVersion','lexiconVersion'])check(typeof game[name]==='string'&&game[name]!=='',`game.${name} must be a nonempty string`);
      for(const name of ['revision','serverTime','consonantsRemaining','spectatorCount'])check(integer(game[name]),`game.${name} must be a nonnegative integer`);
      check(['waiting','active','paused','finished'].includes(String(game.status)),'game.status is invalid');
      check(seat(game.activeSeat),'game.activeSeat is invalid');check([5,15,25].includes(game.minutes as number),'game.minutes is invalid');
      check(Array.isArray(game.board)&&game.board.length===225&&game.board.every(tile=>tile===null||(typeof tile==='string'&&LETTER_SET.has(tile))),'game.board is invalid');
      check(Array.isArray(game.clocksMs)&&game.clocksMs.length===2&&game.clocksMs.every(integer),'game.clocksMs is invalid');
      check(Array.isArray(game.disconnectDeadlines)&&game.disconnectDeadlines.length===2&&game.disconnectDeadlines.every(at=>at===null||integer(at)),'game.disconnectDeadlines is invalid');
      for(const name of ['turnStartedAt','turnDeadlineAt','startsAt'])check(game[name]===null||integer(game[name]),`game.${name} is invalid`);
      check(Array.isArray(game.principalHistory)&&game.principalHistory.every(word=>typeof word==='string'),'game.principalHistory is invalid');
      if(fields(game.vowelsRemaining,VOWELS,'game.vowelsRemaining'))for(const vowel of VOWELS)check(integer(game.vowelsRemaining[vowel]),`game.vowelsRemaining.${vowel} is invalid`);
      if(!Array.isArray(game.players)||game.players.length!==2)add('game.players must contain exactly two players');
      else for(const index of [0,1] as const){
        const player=game.players[index];if(!fields(player,PLAYER,`game.players[${index}]`))continue;
        check(player.id===expected.playerIds[index],`game.players[${index}].id does not match the expected player`);
        check(typeof player.username==='string',`game.players[${index}].username is invalid`);
        check(integer(player.score),`game.players[${index}].score is invalid`);
        check(integer(player.rackSize)&&player.rackSize===expected.racks[index].length,`game.players[${index}].rackSize differs from the expected rack`);
        check(typeof player.passed==='boolean'&&typeof player.connected==='boolean',`game.players[${index}] presence flags are invalid`);
      }
      if(game.pause!==null&&fields(game.pause,PAUSE,'game.pause')){
        check(game.pause.reason==='deployment'||game.pause.reason==='infrastructure','game.pause.reason is invalid');
        check(integer(game.pause.since)&&(game.pause.recoveryDeadlineAt===null||integer(game.pause.recoveryDeadlineAt)),'game.pause timestamps are invalid');
      }
      if(game.result!==null&&fields(game.result,RESULT,'game.result')){
        check(game.result.winner===null||seat(game.result.winner),'game.result.winner is invalid');
        check(['both-passed','clock','disconnect','simultaneous-abandonment','infrastructure-aborted','start-cancelled'].includes(String(game.result.reason)),'game.result.reason is invalid');
        check(integer(game.result.at),'game.result.at is invalid');
      }
      if(!Array.isArray(game.moves))add('game.moves must be an array');
      else for(const [index,move]of game.moves.entries()){
        const path=`game.moves[${index}]`;if(!fields(move,MOVE,path))continue;
        check(seat(move.seat)&&['PLACE_WORD','PASS','NO_WORDS'].includes(String(move.action)),`${path} action/seat is invalid`);
        for(const name of ['revision','at','score'])check(integer(move[name]),`${path}.${name} is invalid`);
        for(const name of ['notation','word'])check(move[name]===null||typeof move[name]==='string',`${path}.${name} is invalid`);
        if(!Array.isArray(move.words))add(`${path}.words must be an array`);
        else for(const [wordIndex,word]of move.words.entries())if(fields(word,WORD,`${path}.words[${wordIndex}]`)){
          check(typeof word.word==='string'&&coordinate(word.row)&&coordinate(word.column)&&(word.direction==='H'||word.direction==='V'),`${path}.words[${wordIndex}] has invalid word coordinates`);
          for(const name of ['letterSum','consonants','spans','score'])check(integer(word[name]),`${path}.words[${wordIndex}].${name} is invalid`);
          check(typeof word.isPrincipal==='boolean',`${path}.words[${wordIndex}].isPrincipal is invalid`);
        }
        if(!Array.isArray(move.tiles))add(`${path}.tiles must be an array`);
        else for(const [tileIndex,tile]of move.tiles.entries())if(fields(tile,TILE,`${path}.tiles[${tileIndex}]`))check(coordinate(tile.row)&&coordinate(tile.column)&&typeof tile.letter==='string'&&LETTER_SET.has(tile.letter),`${path}.tiles[${tileIndex}] is invalid`);
      }
    }
    const privateView=view.you as unknown;
    if(expected.seat===null)check(privateView===null,'Spectator received a private player view');
    else check(privateView!==null,'Player private view is missing');
    if(privateView!==null&&fields(privateView,PRIVATE,'you')){
      check(seat(privateView.seat)&&privateView.seat===expected.seat,'Private seat does not match the viewer');
      check(letters(privateView.rack),'Private rack contains invalid letters');
      check(integer(privateView.drawnThisTurn)&&(privateView.drawnThisTurn as number)<=2,'Private draw count is invalid');
      check(typeof privateView.canNoWords==='boolean','you.canNoWords must be boolean');
      if(expected.seat!==null&&seat(expected.seat)){
        const rack=expected.racks[expected.seat];
        check(Array.isArray(privateView.rack)&&privateView.rack.length===rack.length&&privateView.rack.every((letter,index)=>letter===rack[index]),'Private rack order/letters differ from the expected player rack');
        check(privateView.drawnThisTurn===expected.drawn[expected.seat],'Private drawn count differs from the expected player');
      }
    }
  }catch{add('Malformed wire view could not be safely inspected');}
  return errors;
}

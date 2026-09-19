import assert from 'node:assert/strict';
import { createGame,setConnected,startIfReady,applyAction,projectGame } from '@bestword/engine';
import type { GameView } from '@bestword/contracts';
import { Histogram,validateWireView,type ExpectedWireView } from './observations.js';

const empty=new Histogram();assert.deepEqual(empty.summary(),{count:0,p50:null,p95:null,p99:null,max:null,resolutionMs:1,overflowThresholdMs:10000});
const ordered=new Histogram();for(let value=1;value<=100;value++)ordered.add(value);
assert.deepEqual(ordered.summary(),{count:100,p50:50,p95:95,p99:99,max:100,resolutionMs:1,overflowThresholdMs:10000});
const fractional=new Histogram();for(const value of [0,.01,1.01,9999.1,12345.67])fractional.add(value);
assert.deepEqual(fractional.summary(),{count:5,p50:2,p95:10000,p99:10000,max:12345.67,resolutionMs:1,overflowThresholdMs:10000});
assert.throws(()=>fractional.add(-1),RangeError);assert.throws(()=>fractional.add(Number.NaN),RangeError);assert.throws(()=>fractional.add(Infinity),RangeError);assert.equal(fractional.summary().count,5);
const repeated=new Histogram();for(let index=0;index<200000;index++)repeated.add(7.2);assert.equal(repeated.summary().p99,8);assert.equal(repeated.summary().max,7.2);assert.equal(repeated.summary().count,200000);

const words=['CROSSWORD','WORDGAMES'],lexicon={has:(word:string)=>words.includes(word)};
let state=createGame({id:'fixture-game',players:[{id:'player-a',username:'First'},{id:'player-b',username:'Second'}],minutes:5,lexiconVersion:'fixture',seedWords:words,now:1000,randomInt:()=>0,firstSeat:0},lexicon);
state=setConnected(state,0,true,1000);state=setConnected(state,1,true,1000);state=startIfReady(state,4000);state=applyAction(state,0,{type:'NO_WORDS'},4100,lexicon);
for(let turn=0;turn<3;turn++)state=applyAction(state,state.activeSeat,{type:'NO_WORDS'},4200+turn*100,lexicon);
const view=projectGame(state,0,4500);
const expected:ExpectedWireView={seat:0,historyAccess:'full',playerIds:['player-a','player-b'],knownGame:true,racks:[state.players[0].rack,state.players[1].rack],drawn:state.drawnThisTurn,moveCount:state.moves.length,tileOrigins:view.game.tileOrigins!,lastMoveTiles:view.game.lastMoveTiles!,recentMoves:view.game.recentMoves!,principalHistory:state.principalHistory};
assert.deepEqual(validateWireView(view,expected),[]);
assert.deepEqual(validateWireView(projectGame(state,1,4500),{...expected,seat:1}),[]);
assert.deepEqual(validateWireView(projectGame(state,null,4500),{...expected,seat:null}),[]);
const guest=projectGame(state,null,4500,0,'recent'),guestExpected:ExpectedWireView={...expected,seat:null,historyAccess:'recent'};
assert.deepEqual(validateWireView(guest,guestExpected),[]);
assert.equal(guest.game.moves.length,0);assert.equal(guest.game.moveCount,4);assert.equal(guest.game.recentMoves!.length,3);
function invalidGuest(edit:(value:any)=>void,pattern:RegExp){const altered=structuredClone(guest);edit(altered);assert(validateWireView(altered,guestExpected).some(error=>pattern.test(error)),`Expected guest error ${pattern}`);}
invalidGuest(value=>{value.game.moves=[structuredClone(state.moves[0])];},/forbidden history/);
invalidGuest(value=>{value.game.principalHistory.push('PRIVATEHISTORY');},/allowed history/);
invalidGuest(value=>{value.game.recentMoves.push({...value.game.recentMoves[0]});},/latest three/);
invalidGuest(value=>{value.game.recentMoves[0].rack=['Z'];},/forbidden private field/);
invalidGuest(value=>{value.game.recentMoves[0].words=[];},/allowed wire field/);
invalidGuest(value=>{delete value.game.recentMoves[0].at;},/at is missing/);
invalidGuest(value=>{value.game.recentMoves[0].score+=1;},/accepted turn/);
invalidGuest(value=>{value.game.tileOrigins[state.board.findIndex(Boolean)]=0;},/contributors/);
invalidGuest(value=>{value.game.lastMoveTiles=[{row:0,column:0,letter:'A'}];},/last accepted move/);
invalidGuest(value=>{value.game.historyAccess='full';},/authenticated access/);
invalidGuest(value=>{value.game.moveCount=0;},/expected sequence/);
function invalid(edit:(value:any)=>void,pattern:RegExp){const altered=structuredClone(view);edit(altered);assert(validateWireView(altered,expected).some(error=>pattern.test(error)),`Expected validation error ${pattern}`);}
invalid(value=>{value.extraPrivateRack=['Z'];},/allowed wire field/);
invalid(value=>{value.game.players[0].rack=['Z'];},/forbidden private field/);
invalid(value=>{value.game.moves[0].words.push({word:'EXTRA',rack:['Z']});},/forbidden private field/);
invalid(value=>{value.game.players.reverse();},/expected player/);
invalid(value=>{value.you.seat=1;},/seat does not match/);
invalid(value=>{value.you.rack=[...state.players[1].rack];},/Private rack order/);
invalid(value=>{value.you.rack[0]='a';},/invalid letters/);
invalid(value=>{value.you.drawnThisTurn=1;},/drawn count differs/);
invalid(value=>{value.you.opponentRack=['Z'];},/allowed wire field/);
invalid(value=>{delete value.game.board;},/board is missing/);
assert(validateWireView(view,{...expected,knownGame:false}).some(error=>/unknown game/.test(error)));
assert(validateWireView(view,{...expected,seat:null}).some(error=>/Spectator received/.test(error)));
assert(validateWireView(projectGame(state,null,4500),expected).some(error=>/private view is missing/.test(error)));
for(const malformed of [null,undefined,42,[],{}, {game:null,you:0},{game:{},you:[]},new Proxy({},{ownKeys(){throw new Error('Unreadable object');}})]){
  assert.doesNotThrow(()=>validateWireView(malformed as GameView,expected));assert(validateWireView(malformed as GameView,expected).length>0);
}
const reordered=structuredClone(view);const predicted=[...expected.racks[0]];predicted[0]='B';predicted[1]='C';reordered.you!.rack=[...predicted];
assert.deepEqual(validateWireView(reordered,{...expected,racks:[predicted,expected.racks[1]]}),[]);
[reordered.you!.rack[0],reordered.you!.rack[1]]=[reordered.you!.rack[1]!,reordered.you!.rack[0]!];
assert(validateWireView(reordered,{...expected,racks:[predicted,expected.racks[1]]}).some(error=>/Private rack order/.test(error)));
console.log('Observation helpers: histogram and strict wire/privacy checks passed.');

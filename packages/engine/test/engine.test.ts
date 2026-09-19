import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LETTERS, isVowel, type Board, type Letter, type PlaceWordAction, type Seat } from '@bestword/contracts';
import {
  COUNTDOWN_MS, EngineError, INITIAL_COUNTS, LETTER_VALUES, adjudicate, applyAction, assertStateInvariants,
  beginRecovery, createGame, dueOutcome, evaluatePlacement, nextDeadline, pauseGame, projectGame,
  restartRecovery, resumeGame, setConnected, startIfReady, type EngineState, type Lexicon, type RandomInt,
} from '../src/index.js';

const seedWords=['CROSSWORD','WORDGAMES'];
const dictionary=(words:readonly string[]):Lexicon=>{const set=new Set([...seedWords,...words]);return {has:word=>set.has(word)};};
const seeds=dictionary([]);
function random(seed=1):RandomInt { let n=seed>>>0;return max=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n%max;}; }
function waiting(seed=1):EngineState {
  return createGame({id:'game',players:[{id:'one',username:'Alice'},{id:'two',username:'Bob'}],minutes:5,lexiconVersion:'test',seedWords,now:0,randomInt:random(seed),firstSeat:0},seeds);
}
function active(seed=1):EngineState {
  let state=waiting(seed);state=setConnected(state,0,true,0);state=setConnected(state,1,true,0);
  return startIfReady(state,COUNTDOWN_MS);
}
function put(board:Board,notation:string,word:string):void {
  const horizontal=/^\d/.test(notation);
  const match=horizontal?/^(\d+)([A-O])$/.exec(notation):/^([A-O])(\d+)$/.exec(notation);
  if(!match)throw new Error('Bad fixture notation');
  const row=Number(match[horizontal?1:2])-1,column=match[horizontal?2:1]!.charCodeAt(0)-65;
  [...word].forEach((letter,index)=>{const square=(row+(horizontal?0:index))*15+column+(horizontal?index:0);if(board[square]!==null && board[square]!==letter)throw new Error('Conflicting fixture');board[square]=letter as Letter;});
}
function placement(notation:string,word:string):PlaceWordAction {
  const horizontal=/^\d/.test(notation),match=horizontal?/^(\d+)([A-O])$/.exec(notation):/^([A-O])(\d+)$/.exec(notation);
  if(!match)throw new Error('Bad notation');
  return {type:'PLACE_WORD',row:Number(match[horizontal?1:2])-1,column:match[horizontal?2:1]!.charCodeAt(0)-65,direction:horizontal?'H':'V',word};
}
function rebalance(state:EngineState):void {
  state.bag={...INITIAL_COUNTS};
  for(const letter of [...state.board,...state.players[0].rack,...state.players[1].rack])if(letter!==null)state.bag[letter]--;
  state.consonantDrawOrder=[];
  for(const letter of LETTERS)if(!isVowel(letter))for(let i=0;i<state.bag[letter];i++)state.consonantDrawOrder.push(letter);
}
function fixture(existing:[string,string][],rack:string,history:string[]=[]):EngineState {
  const state=active();state.board=Array<Letter|null>(225).fill(null);
  for(const [notation,word]of existing)put(state.board,notation,word);
  state.players[0].rack=[...rack] as Letter[];state.players[1].rack=[];
  state.principalHistory=[...history];state.moves=[];state.drawnThisTurn=[2,0];
  rebalance(state);assertStateInvariants(state);return state;
}
function errorCode(operation:()=>unknown,code:string):void {
  try { operation();throw new Error('Expected rejection'); }catch(error){expect(error).toBeInstanceOf(EngineError);expect((error as EngineError).code).toBe(code);}
}

describe('exact published scoring examples',()=>{
  const examples:[string,[string,string][],string,string,string[],number,number[]][]=[
    ['ROOMMATE',[['2A','BOOM'],['6A','RANG']],'RMMT','B1',['ROOMMATE'],147,[3]],
    ['BOOMERANG',[['E1','BOOM'],['E6','RANG'],['5A','BOO'],['5F','RANG']],'M','5A',['BOOMERANG'],261,[2,1]],
    ['BOOMERANGS',[['1F','RANG']],'BMS','1A',['BOOMERANGS'],186,[0]],
    ['SOS',[['A1','BOOM'],['C1','RANG']],'SS','5A',['SOS','BOOMS','RANGS'],42,[0,0,0]],
    ['ANOPIAS',[['F1','FLOPPY'],['3A','SCHIZOGNATHOUS'],['5B','ZYGAPOPHYSEAL']],'NS','4C',['ANOPIAS','HAY','ING','ZOA','GIO','NAP','ASH'],171,[0,1,1,1,1,1,1]],
  ];
  for(const [word,existing,rack,notation,lexicon,total,spans]of examples)it(`${word}: total ${total}`,()=>{
    const state=fixture(existing,rack),before=JSON.stringify(state);
    const result=evaluatePlacement(state,0,placement(notation,word),dictionary(lexicon));
    expect(result.score).toBe(total);expect(result.words.map(value=>value.spans)).toEqual(spans);
    expect(JSON.stringify(state)).toBe(before);
    const next=applyAction(state,0,placement(notation,word),3100,dictionary(lexicon));
    expect(next.players[0].score).toBe(total);expect(next.moves.at(-1)?.score).toBe(total);assertStateInvariants(next);
    expect(JSON.stringify(state)).toBe(before);
  });
  it('records Example5 as six new tiles, six different secondary bridges, and a 51 point principal',()=>{
    const state=fixture([['F1','FLOPPY'],['3A','SCHIZOGNATHOUS'],['5B','ZYGAPOPHYSEAL']],'NS');
    const result=evaluatePlacement(state,0,placement('4C','ANOPIAS'),dictionary(['ANOPIAS','HAY','ING','ZOA','GIO','NAP','ASH']));
    expect(result.tiles).toHaveLength(6);expect(result.words[0]?.score).toBe(51);
    expect(result.words.slice(1).map(word=>word.word)).toEqual(['HAY','ING','ZOA','GIO','NAP','ASH']);
  });
});

describe('setup and mandatory draws',()=>{
  it('uses exactly267 tiles including Y as a vowel',()=>{
    expect(Object.values(INITIAL_COUNTS).reduce((a,b)=>a+b,0)).toBe(267);
    expect(LETTERS.filter(isVowel).reduce((sum,letter)=>sum+INITIAL_COUNTS[letter],0)).toBe(90);
    expect(isVowel('Y')).toBe(true);expect(LETTER_VALUES.Y).toBe(2);
  });
  it('starts with empty racks, distinct seeds, no initial score, and one shared consumed square',()=>{
    const state=waiting();expect(state.players.map(player=>player.rack)).toEqual([[],[]]);
    expect(new Set(state.principalHistory).size).toBe(2);
    expect(state.board.filter(Boolean)).toHaveLength(17);expect(state.players.map(player=>player.score)).toEqual([0,0]);
    expect(nextDeadline(state)).toBe(25000);assertStateInvariants(state);
  });
  it('waits for both connections and the entire countdown, then draws exactly once',()=>{
    let state=waiting();state=setConnected(state,0,true,1000);expect(state.startsAt).toBeNull();
    state=setConnected(state,1,true,2000);expect(state.startsAt).toBe(5000);expect(nextDeadline(state)).toBe(5000);
    expect(startIfReady(state,4999)).toBe(state);state=startIfReady(state,5000);
    expect(state.status).toBe('active');expect(state.players[0].rack).toHaveLength(2);expect(state.drawnThisTurn).toEqual([2,0]);
    expect(startIfReady(state,6000)).toBe(state);expect(setConnected(state,0,true,6000)).toBe(state);assertStateInvariants(state);
  });
  it('begins the clock at the scheduled countdown even if its worker runs late',()=>{
    let state=waiting();state=setConnected(state,0,true,0);state=setConnected(state,1,true,0);state=startIfReady(state,4500);
    expect(state.turnStartedAt).toBe(3000);expect(projectGame(state,0,4500).game.clocksMs[0]).toBe(298500);
  });
  it('a ready pair at24seconds may finish countdown after the no-show deadline',()=>{
    let state=waiting();state=setConnected(state,0,true,24000);state=setConnected(state,1,true,24000);
    expect(dueOutcome(state,25000)).toBeNull();expect(startIfReady(state,27000).status).toBe('active');
  });
  it('cancels a pre-start no-show exactly at25seconds and rejects a late connection',()=>{
    const state=setConnected(waiting(),0,true,0);expect(dueOutcome(state,24999)).toBeNull();
    expect(dueOutcome(state,25000)).toEqual({winner:null,reason:'start-cancelled',at:25000});
    errorCode(()=>setConnected(state,1,true,25000),'DEADLINE_REACHED');expect(adjudicate(state,25000).status).toBe('finished');
  });
  for(let rackSize=0;rackSize<=10;rackSize++)for(let remaining=0;remaining<=3;remaining++)it(`draws correctly with rack${rackSize} and remaining${remaining}`,()=>{
    const state=active();state.activeSeat=1;state.drawnThisTurn[1]=2;
    state.players[0].rack=Array<Letter>(rackSize).fill('B');state.bag.B=remaining;
    state.consonantDrawOrder=Array<Letter>(remaining).fill('B');
    const next=applyAction(state,1,{type:'PASS'},3100,seeds),expected=Math.min(2,10-rackSize,remaining);
    expect(next.players[0].rack).toHaveLength(rackSize+expected);expect(next.drawnThisTurn[0]).toBe(expected);
    expect(next.bag.B).toBe(remaining-expected);
  });
  it('reproduces the same setup and all draws from the same random source',()=>{
    let left=active(4321),right=active(4321);expect(left).toEqual(right);
    for(let turn=0;turn<8;turn++){left=applyAction(left,left.activeSeat,{type:'NO_WORDS'},3100+turn,seeds);right=applyAction(right,right.activeSeat,{type:'NO_WORDS'},3100+turn,seeds);expect(left).toEqual(right);}
  });
  it('rejects invalid candidate sources and out-of-range randomness',()=>{
    const options={id:'game',players:[{id:'1',username:'One'},{id:'2',username:'Two'}] as [{id:string;username:string},{id:string;username:string}],minutes:5 as const,lexiconVersion:'test',now:0,randomInt:random(),seedWords:['BAD','ALSO']};
    errorCode(()=>createGame(options,seeds),'INVALID_SETUP');
    errorCode(()=>createGame({...options,seedWords,randomInt:()=>-1},seeds),'INVALID_RANDOM');
    errorCode(()=>createGame({...options,seedWords:['CROSSWORD','CROSSWORD']},seeds),'SETUP_UNAVAILABLE');
    const impossible=['JJJJAAAAA','JJJJAAAAB'];
    errorCode(()=>createGame({...options,seedWords:impossible},dictionary(impossible)),'SETUP_UNAVAILABLE');
  });
  it.each(['AEIOUYAEI','BCDFGHJKL'])('rejects an opening candidate without both letter types: %s',word=>{
    const options={id:'game',players:[{id:'one',username:'Alice'},{id:'two',username:'Bob'}] as [{id:string;username:string},{id:string;username:string}],minutes:5 as const,lexiconVersion:'test',seedWords:[word,'CROSSWORD'],now:0,randomInt:()=>0};
    errorCode(()=>createGame(options,dictionary([word])),'INVALID_WORD_COMPOSITION');
    expect(()=>createGame(options,dictionary([word]))).toThrow(`${word} must contain at least one vowel`);
  });
  it('accepts Y as the only vowel in an opening word',()=>{
    const word='RHYTHMYYZ';
    const state=createGame({id:'game',players:[{id:'one',username:'Alice'},{id:'two',username:'Bob'}],minutes:5,lexiconVersion:'test',seedWords:[word,'CROSSWORD'],now:0,randomInt:()=>0},dictionary([word]));
    expect(state.principalHistory).toContain(word);assertStateInvariants(state);
  });
  it('all randomized setup placements conserve every tile and fit the board',()=>{
    fc.assert(fc.property(fc.integer(),seed=>{const state=waiting(seed);assertStateInvariants(state);expect(state.board.filter(Boolean)).toHaveLength(17);}),{numRuns:300});
  });
});

describe('word validation',()=>{
  it('permits all-vowel new tiles when an existing tile supplies the consonant',()=>{
    const state=fixture([['1B','C']],'');const result=evaluatePlacement(state,0,placement('1A','ACE'),dictionary(['ACE']));
    expect(result.score).toBe(8);expect(result.rack).toEqual([]);expect(result.tiles.map(tile=>tile.letter)).toEqual(['A','E']);
    expect(result.bag.A).toBe(state.bag.A-1);expect(result.bag.E).toBe(state.bag.E-1);
  });
  it('permits all-consonant new tiles when an existing Y supplies the vowel',()=>{
    const state=fixture([['1C','Y']],'CR');const result=evaluatePlacement(state,0,placement('1A','CRY'),dictionary(['CRY']));
    expect(result.rack).toEqual([]);expect(result.bag.Y).toBe(state.bag.Y);expect(result.words[0]?.consonants).toBe(2);
    expect(result.tiles.map(tile=>tile.letter)).toEqual(['C','R']);expect(result.score).toBe(22);
  });
  it('takes a newly placed Y from the bag and counts it as a vowel',()=>{
    const state=fixture([['1A','A']],'RS');const result=evaluatePlacement(state,0,placement('1A','ARYS'),dictionary(['ARYS']));
    expect(result.rack).toEqual([]);expect(result.bag.Y).toBe(state.bag.Y-1);expect(result.words[0]?.consonants).toBe(2);
  });
  const badCompositionCases:[string,[string,string][],string,string,string,string[]][]=[
    ['all-vowel principal',[['1B','A']],'','1A','EAI',['EAI']],
    ['Y does not supply a consonant',[['1B','A']],'','1A','EAY',['EAY']],
    ['all-consonant principal',[['1B','R']],'BR','1A','BRR',['BRR']],
    ['all-vowel secondary',[['2A','C'],['1B','E'],['3B','Y']],'T','2A','CAT',['CAT','EAY']],
    ['all-consonant secondary',[['2B','A'],['1A','B'],['3A','R']],'CT','2A','CAT',['CAT','BCR']],
  ];
  for(const [name,existing,rack,notation,word,words]of badCompositionCases)it(`rejects ${name}, names the word, and preserves the entire turn`,()=>{
    const state=fixture(existing,rack),before=JSON.stringify(state),action=placement(notation,word),lexicon=dictionary(words),offending=words.at(-1)!;
    errorCode(()=>applyAction(state,0,action,4000,lexicon),'INVALID_WORD_COMPOSITION');
    expect(()=>applyAction(state,0,action,4000,lexicon)).toThrow(`${offending} must contain at least one vowel`);
    expect(JSON.stringify(state)).toBe(before);expect(projectGame(state,0,5000).game.clocksMs[0]).toBe(298000);
  });
  const invalidCases:[string,()=>[EngineState,PlaceWordAction,Lexicon],string][]=[
    ['one new tile',()=>[fixture([['1A','CA']],'T'),placement('1A','CAT'),dictionary(['CAT'])],'TOO_FEW_TILES'],
    ['no new tiles',()=>[fixture([['1A','CAT']],'TT'),placement('1A','CAT'),dictionary(['CAT'])],'TOO_FEW_TILES'],
    ['out of bounds',()=>[fixture([['15N','A']],'CT'),placement('15N','ACT'),dictionary(['ACT'])],'OUT_OF_BOUNDS'],
    ['replacement',()=>[fixture([['1A','D']],'CT'),placement('1A','CAT'),dictionary(['CAT'])],'LETTER_CONFLICT'],
    ['isolated word',()=>[fixture([['1A','CAT']],'DG'),placement('8H','DOG'),dictionary(['DOG'])],'DISCONNECTED_WORD'],
    ['dictionary miss',()=>[fixture([['1B','A']],'CT'),placement('1A','CAT'),dictionary([])],'INVALID_WORD'],
    ['repeated principal',()=>[fixture([['1B','A']],'CT',['CAT']),placement('1A','CAT'),dictionary(['CAT'])],'REPEATED_PRINCIPAL'],
    ['omitted prefix',()=>[fixture([['1A','S'],['1C','A']],'CT'),placement('1B','CAT'),dictionary(['CAT'])],'NON_MAXIMAL_WORD'],
    ['omitted suffix',()=>[fixture([['1B','A'],['1D','S']],'CT'),placement('1A','CAT'),dictionary(['CAT'])],'NON_MAXIMAL_WORD'],
    ['missing consonant',()=>[fixture([['1B','A']],'C'),placement('1A','CAT'),dictionary(['CAT'])],'CONSONANT_UNAVAILABLE'],
    ['two-letter cross',()=>[fixture([['1A','A']],'CT'),placement('2A','CAT'),dictionary(['CAT','AC'])],'INVALID_SECONDARY'],
    ['invalid secondary',()=>[fixture([['1A','B'],['2B','ZZ']],'TTS'),placement('A1','BATTS'),dictionary(['BATTS'])],'INVALID_SECONDARY'],
  ];
  for(const [name,build,code]of invalidCases)it(`rejects ${name} without mutation`,()=>{const [state,action,lexicon]=build(),before=JSON.stringify(state);errorCode(()=>applyAction(state,0,action,3100,lexicon),code);expect(JSON.stringify(state)).toBe(before);});
  it('checks each vowel copy against the remaining bag',()=>{
    const state=fixture([['1A','B']],'');state.bag.E=1;
    errorCode(()=>evaluatePlacement(state,0,placement('1A','BEE'),dictionary(['BEE'])),'VOWEL_UNAVAILABLE');
  });
  it('checks repeated consonant letters individually',()=>{
    const state=fixture([['1B','A']],'L');errorCode(()=>evaluatePlacement(state,0,placement('1A','LALL'),dictionary(['LALL'])),'CONSONANT_UNAVAILABLE');
  });
  it('allows repeated secondary words without adding them to principal history',()=>{
    const state=fixture([['A1','BOOM'],['C1','RANG']],'SS',['BOOMS','RANGS']);
    const next=applyAction(state,0,placement('5A','SOS'),3100,dictionary(['SOS','BOOMS','RANGS']));
    expect(next.principalHistory).toEqual(['BOOMS','RANGS','SOS']);
  });
  it('accepts a fifteen-letter maximal word',()=>{
    const word='AEAEAEANAEAEAEA',state=fixture([['1H','N']],'');
    const result=evaluatePlacement(state,0,placement('1A',word),dictionary([word]));expect(result.words[0]?.word).toHaveLength(15);
  });
  it('rejects malformed runtime actions before changing state',()=>{
    const state=active();errorCode(()=>applyAction(state,0,{type:'PLACE_WORD',row:-1,column:0,direction:'H',word:'ABC'},3100,seeds),'INVALID_ACTION');
  });
  it('bridge spans count preexisting interior pillars, excluding extensions',()=>{
    const state=fixture([['1C','A'],['1F','A']],'N');const result=evaluatePlacement(state,0,placement('1A','EEAEEANE'),dictionary(['EEAEEANE']));
    expect(result.words[0]?.spans).toBe(2);expect(result.words[0]?.score).toBe(30);
  });
  it('random valid principal placements agree with an independent span oracle and conserve tiles',()=>{
    fc.assert(fc.property(fc.array(fc.constantFrom<Letter>('A','E','I','N','S'),{minLength:3,maxLength:12}),fc.array(fc.boolean(),{minLength:12,maxLength:12}),fc.boolean(),fc.integer({min:0,max:14}),fc.integer({min:0,max:3}),(letters,mask,vertical,line,offset)=>{
      fc.pre(letters.some(isVowel)&&letters.some(letter=>!isVowel(letter)));
      const occupied=mask.slice(0,letters.length);fc.pre(occupied.some(Boolean)&&occupied.filter(value=>!value).length>=2);
      const board:Board=Array<Letter|null>(225).fill(null),rack:Letter[]=[];
      const row=vertical?offset:line,column=vertical?line:offset;
      letters.forEach((letter,index)=>{if(occupied[index])board[(row+(vertical?index:0))*15+column+(vertical?0:index)]=letter;else if(!isVowel(letter))rack.push(letter);});fc.pre(rack.length<=10);
      const state=fixture([],'');state.board=board;state.players[0].rack=rack;rebalance(state);
      const word=letters.join(''),action:PlaceWordAction={type:'PLACE_WORD',row,column,direction:vertical?'V':'H',word},result=evaluatePlacement(state,0,action,dictionary([word]));
      const first=occupied.indexOf(true),last=occupied.lastIndexOf(true),spans=occupied.slice(first+1,last).filter(value=>!value).length;
      const sum=letters.reduce((n,letter)=>n+LETTER_VALUES[letter],0),consonants=letters.filter(letter=>!isVowel(letter)).length;
      expect(result.score).toBe(sum*(consonants+spans));
      const next=applyAction(state,0,action,3100,dictionary([word]));assertStateInvariants(next);
    }),{numRuns:500});
  });
});

describe('PASS, NO WORDS and clocks',()=>{
  it('accounts elapsed milliseconds and adds one increment for NO WORDS',()=>{
    const state=active(),next=applyAction(state,0,{type:'NO_WORDS'},3101,seeds);
    expect(next.clocksMs).toEqual([329899,300000]);expect(next.activeSeat).toBe(1);expect(next.turnStartedAt).toBe(3101);
    expect(next.players[1].rack).toHaveLength(2);expect(next.moves[0]?.score).toBe(0);
  });
  it('freezes a PASS player permanently, including after they leave',()=>{
    let state=applyAction(active(),0,{type:'PASS'},4000,seeds);
    expect(state.players[0].passed).toBe(true);expect(state.clocksMs[0]).toBe(329000);const rack=[...state.players[0].rack];
    state=setConnected(state,0,false,5000);expect(state.disconnectDeadlines[0]).toBeNull();
    expect(dueOutcome(state,30000)).toBeNull();expect(projectGame(state,0,30000).game.clocksMs[0]).toBe(329000);
    errorCode(()=>applyAction(state,1,{type:'NO_WORDS'},5001,seeds),'NO_WORDS_UNAVAILABLE');
    state=applyAction(state,1,{type:'PASS'},6000,seeds);expect(state.result).toEqual({winner:null,reason:'both-passed',at:6000});expect(state.players[0].rack).toEqual(rack);expect(state.clocksMs[0]).toBe(329000);
  });
  it('allows consecutive turns for the remaining player with one draw and increment per move',()=>{
    let state=fixture([['1B','A']],'CT');state.players[1].passed=true;state.players[1].connected=false;
    state=applyAction(state,0,placement('1A','CAT'),4000,dictionary(['CAT']));
    expect(state.activeSeat).toBe(0);expect(state.players[0].rack).toHaveLength(2);expect(state.drawnThisTurn[0]).toBe(2);
    expect(state.clocksMs[0]).toBe(329000);expect(state.turnStartedAt).toBe(4000);
    expect(state.players[1].rack).toEqual([]);expect(state.disconnectDeadlines[1]).toBeNull();assertStateInvariants(state);
  });
  for(const drawn of [0,1,2])it(`NO WORDS eligibility uses actual draw count ${drawn}`,()=>{
    const state=active();state.drawnThisTurn[0]=drawn;
    if(drawn===0)errorCode(()=>applyAction(state,0,{type:'NO_WORDS'},3100,seeds),'NO_WORDS_UNAVAILABLE');
    else expect(applyAction(state,0,{type:'NO_WORDS'},3100,seeds).activeSeat).toBe(1);
  });
  it('full rack after drawing is still eligible when at least one consonant was drawn',()=>{
    const state=active();state.players[0].rack=Array<Letter>(10).fill('B');state.drawnThisTurn[0]=1;
    expect(applyAction(state,0,{type:'NO_WORDS'},3100,seeds).activeSeat).toBe(1);
  });
  it('bag exhaustion does not end a game or prevent PASS',()=>{
    const state=active();state.consonantDrawOrder=[];for(const letter of LETTERS)state.bag[letter]=0;
    state.drawnThisTurn[0]=0;expect(dueOutcome(state,3100)).toBeNull();
    expect(applyAction(state,0,{type:'PASS'},3100,seeds).status).toBe('active');
  });
  it('higher score wins after both passes',()=>{
    let state=active();state.players[1].score=100;state=applyAction(state,0,{type:'PASS'},3100,seeds);state=applyAction(state,1,{type:'PASS'},3200,seeds);
    expect(state.result?.winner).toBe(1);expect(nextDeadline(state)).toBeNull();
  });
  it('one millisecond before expiry is accepted and equality loses regardless of score',()=>{
    const state=active(),deadline=state.turnDeadlineAt!;state.players[0].score=99999;
    const timely=applyAction(state,0,{type:'NO_WORDS'},deadline-1,seeds);expect(timely.clocksMs[0]).toBe(30001);
    expect(dueOutcome(state,deadline-1)).toBeNull();expect(dueOutcome(state,deadline)).toEqual({winner:1,reason:'clock',at:deadline});
    errorCode(()=>applyAction(state,0,{type:'PASS'},deadline,seeds),'DEADLINE_REACHED');expect(state.status).toBe('active');
    const ended=adjudicate(state,deadline+5000);expect(ended.result?.winner).toBe(1);expect(ended.clocksMs[0]).toBe(0);
  });
  it('invalid attempts do not draw or add increments and the clock continues',()=>{
    const state=active(),before=JSON.stringify(state);errorCode(()=>applyAction(state,1,{type:'PASS'},4000,seeds),'NOT_YOUR_TURN');
    expect(JSON.stringify(state)).toBe(before);expect(projectGame(state,0,5000).game.clocksMs[0]).toBe(298000);
  });
  it('random NO WORDS/PASS games retain invariants and finish in bounded turns',()=>{
    fc.assert(fc.property(fc.integer(),fc.array(fc.boolean(),{minLength:50,maxLength:50}),(seed,choices)=>{
      let state=active(seed);let steps=0;
      while(state.status==='active'&&steps<50){const seat=state.activeSeat,can=projectGame(state,seat,3100+steps).you!.canNoWords;state=applyAction(state,seat,{type:can&&choices[steps]?'NO_WORDS':'PASS'},3100+steps,seeds);assertStateInvariants(state);steps++;}
      expect(state.status).toBe('finished');expect(steps).toBeLessThanOrEqual(12);
    }),{numRuns:300});
  });
});

describe('disconnects, outage suspension and recovery',()=>{
  it('sets grace from detection without freezing the active clock',()=>{
    const state=setConnected(active(),0,false,4000);expect(state.disconnectDeadlines[0]).toBe(29000);expect(state.turnDeadlineAt).toBe(303000);
    expect(dueOutcome(state,28999)).toBeNull();expect(dueOutcome(state,29000)).toEqual({winner:1,reason:'disconnect',at:29000});
    expect(projectGame(state,null,10000).game.clocksMs[0]).toBe(293000);
  });
  it('applies disconnect forfeits even when it is not that player’s turn',()=>{
    const state=setConnected(active(),1,false,4000);expect(dueOutcome(state,29000)?.winner).toBe(0);
  });
  it('reconnect before deadline restores presence without drawing or clock changes',()=>{
    const original=active(),gone=setConnected(original,0,false,4000),back=setConnected(gone,0,true,28999);
    expect(back.disconnectDeadlines[0]).toBeNull();expect(back.players[0].rack).toEqual(original.players[0].rack);expect(back.turnDeadlineAt).toBe(original.turnDeadlineAt);
    errorCode(()=>setConnected(gone,0,true,29000),'DEADLINE_REACHED');
  });
  it('duplicate presence signals do not extend the disconnect deadline',()=>{
    const state=setConnected(active(),0,false,4000);expect(setConnected(state,0,false,10000)).toBe(state);expect(state.disconnectDeadlines[0]).toBe(29000);
  });
  it('uses earliest loss and same-player clock tie wins over disconnect',()=>{
    let state=active();state.clocksMs[0]=26000;state.turnDeadlineAt=29000;
    state=setConnected(state,0,false,4000);expect(dueOutcome(state,50000)).toEqual({winner:1,reason:'clock',at:29000});
    state.disconnectDeadlines[1]=28000;expect(dueOutcome(state,50000)).toEqual({winner:0,reason:'disconnect',at:28000});
  });
  it('simultaneous losses of different players close with no winner',()=>{
    let state=active();state=setConnected(state,0,false,4000);state=setConnected(state,1,false,4000);
    expect(dueOutcome(state,29000)).toEqual({winner:null,reason:'simultaneous-abandonment',at:29000});
  });
  it('pauses elapsed clock and disconnect allowance, with no loss while infrastructure remains unavailable',()=>{
    let state=setConnected(active(),1,false,4000);state=pauseGame(state,6000,'infrastructure');
    expect(state.clocksMs).toEqual([297000,300000]);expect(state.pauseMetadata?.disconnectRemainingMs[1]).toBe(23000);
    expect(state.turnStartedAt).toBeNull();expect(state.disconnectDeadlines).toEqual([null,null]);expect(nextDeadline(state)).toBeNull();
    expect(dueOutcome(state,10000000)).toBeNull();expect(projectGame(state,null,10000000).game.clocksMs[0]).toBe(297000);
  });
  it('requires fresh connections, resumes through a countdown, and does not redraw',()=>{
    const original=active();let state=pauseGame(original,5000);state=beginRecovery(state,50000);
    expect(state.pause?.recoveryDeadlineAt).toBe(170000);expect(state.players.map(player=>player.connected)).toEqual([false,false]);
    errorCode(()=>resumeGame(state,51000),'PLAYERS_NOT_READY');
    state=setConnected(state,0,true,51000);state=setConnected(state,1,true,52000);state=resumeGame(state,53000);
    expect(state.startsAt).toBe(56000);expect(state.turnDeadlineAt).toBeNull();expect(state.players[0].rack).toEqual(original.players[0].rack);
    errorCode(()=>applyAction(state,0,{type:'PASS'},54000,seeds),'NOT_ACTIVE');
    state=startIfReady(state,56000);expect(state.turnDeadlineAt).toBe(354000);expect(state.drawnThisTurn[0]).toBe(2);expect(state.players[0].rack).toEqual(original.players[0].rack);
    assertStateInvariants(state);
  });
  it('does not require an already-passed participant to reconnect',()=>{
    let state=applyAction(active(),0,{type:'PASS'},4000,seeds);state=pauseGame(state,5000);state=beginRecovery(state,10000);state=setConnected(state,1,true,11000);state=resumeGame(state,11000);
    state=startIfReady(state,14000);expect(state.activeSeat).toBe(1);expect(state.players[0].passed).toBe(true);expect(state.disconnectDeadlines[0]).toBeNull();
  });
  it('missing recovery participant closes without a winner at120seconds',()=>{
    let state=beginRecovery(pauseGame(active(),4000),10000);state=setConnected(state,0,true,11000);
    expect(dueOutcome(state,129999)).toBeNull();expect(dueOutcome(state,130000)).toEqual({winner:null,reason:'infrastructure-aborted',at:130000});
    expect(adjudicate(state,130000).result?.reason).toBe('infrastructure-aborted');
  });
  it('repeated outage notifications do not reset the frozen clock or recovery window',()=>{
    const state=beginRecovery(pauseGame(active(),5000),10000);expect(pauseGame(state,20000)).toBe(state);expect(beginRecovery(state,20000)).toBe(state);
  });
  it('a distinct new incident suspends an in-progress recovery window without redrawing or charging outage time',()=>{
    let state=beginRecovery(pauseGame(active(),5000),10000);state=setConnected(state,0,true,11000);
    const rack=[...state.players[0].rack],clocks=[...state.clocksMs];state=restartRecovery(state,129999,'infrastructure');
    expect(state.pause?.recoveryDeadlineAt).toBeNull();expect(state.players.map(player=>player.connected)).toEqual([false,false]);
    expect(dueOutcome(state,1000000)).toBeNull();expect(state.clocksMs).toEqual(clocks);expect(state.players[0].rack).toEqual(rack);
    expect(restartRecovery(state,140000)).toBe(state);state=beginRecovery(state,200000);expect(state.pause?.recoveryDeadlineAt).toBe(320000);
  });
  it('supports outage recovery during initial setup and performs the initial draw only after resume countdown',()=>{
    let state=beginRecovery(pauseGame(waiting(),1000),10000);state=setConnected(state,0,true,11000);state=setConnected(state,1,true,11000);state=resumeGame(state,11000);
    expect(state.players[0].rack).toEqual([]);state=startIfReady(state,14000);expect(state.players[0].rack).toHaveLength(2);expect(state.clocksMs[0]).toBe(300000);assertStateInvariants(state);
  });
  it('rejects rollback earlier than a committed transition',()=>{
    const state=applyAction(active(),0,{type:'NO_WORDS'},5000,seeds);errorCode(()=>pauseGame(state,4999),'TIME_REVERSED');expect(pauseGame(state,5000).lastTransitionAt).toBe(5000);
  });
  it('adjudicates at the original disconnect deadline without charging late worker delay',()=>{
    const state=setConnected(active(),1,false,4000),ended=adjudicate(state,50000);expect(ended.result?.at).toBe(29000);expect(ended.clocksMs[0]).toBe(274000);expect(ended.lastTransitionAt).toBe(50000);
  });
});

describe('public and private projections',()=>{
  it('reveals only own rack, vowel counts, consonant total, and opponent rack size',()=>{
    const state=active(),spectator=projectGame(state,null,4000,3),player=projectGame(state,0,4000);
    expect(spectator.you).toBeNull();expect(spectator.game.players[0].rackSize).toBe(2);expect(spectator.game.spectatorCount).toBe(3);
    expect(player.you?.rack).toEqual(state.players[0].rack);expect(Object.keys(player.game.vowelsRemaining)).toEqual(['A','E','I','O','U','Y']);
    for(const key of ['bag','consonantDrawOrder','drawnThisTurn','pauseMetadata','waitingDeadlineAt'])expect(spectator.game).not.toHaveProperty(key);
    expect(spectator.game.players[0]).not.toHaveProperty('rack');expect(spectator.game.players[1]).not.toHaveProperty('rack');
    expect(spectator.game.consonantsRemaining).toBe(state.consonantDrawOrder.length);
  });
  it('returned view edits cannot modify persisted state or moves',()=>{
    const state=applyAction(fixture([['1B','A']],'CT'),0,placement('1A','CAT'),3100,dictionary(['CAT'])),before=JSON.stringify(state),view=projectGame(state,0,3200);
    view.game.board.fill(null);view.you!.rack.length=0;view.game.moves[0]!.words[0]!.word='CHANGED';view.game.moves[0]!.tiles[0]!.letter='Z';
    expect(JSON.stringify(state)).toBe(before);
  });
  it('later snapshots own independent move records and private arrays',()=>{
    const state=applyAction(fixture([['1B','A']],'CT'),0,placement('1A','CAT'),3100,dictionary(['CAT'])),before=JSON.stringify(state);
    const next=applyAction(state,1,{type:'NO_WORDS'},3200,seeds);
    next.moves[0]!.words[0]!.word='CHANGED';next.moves[0]!.tiles[0]!.letter='Z';next.board.fill(null);next.players[0].rack.length=0;
    expect(JSON.stringify(state)).toBe(before);
  });
  it('invalid runtime seats fail with a structured engine error',()=>{
    const state=active();errorCode(()=>applyAction(state,2 as Seat,{type:'PASS'},3100,seeds),'INVALID_SEAT');errorCode(()=>projectGame(state,2 as Seat,3100),'INVALID_SEAT');
  });
  it('never offers NO WORDS while paused, in countdown, out of turn, or after expiry',()=>{
    const state=active();expect(projectGame(state,1,3100).you?.canNoWords).toBe(false);expect(projectGame(state,0,state.turnDeadlineAt!).you?.canNoWords).toBe(false);
    expect(projectGame(pauseGame(state,3100),0,4000).you?.canNoWords).toBe(false);expect(projectGame(waiting(),0,0).you?.canNoWords).toBe(false);
  });
});

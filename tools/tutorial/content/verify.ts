/** Rebuild and verify tutorial examples using the shipped engine and exact GADDAG. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LETTERS, VOWELS, isVowel, type Board, type Letter, type PlaceWordAction } from '../../../packages/contracts/src/index.js';
import { INITIAL_COUNTS, LETTER_VALUES, createGame, setConnected, startIfReady, evaluatePlacement, assertStateInvariants, type EngineState } from '../../../packages/engine/src/index.js';
import { Gaddag } from '../../../packages/lexicon/src/index.js';
import { clickSquare, emptyDraft, typeLetter, inferMove } from '../../../apps/web/src/draft.js';

const root = new URL('../../../', import.meta.url);
const here = new URL('./', import.meta.url);
const lexicon = await Gaddag.open(new URL('data/lexicon.bin.gz', root));
const specs = [
  { id:'boomerangs', title:'BOOMERANGS', existing:[['1F','RANG']], rack:'BMS', notation:'1A', score:186, spans:[0], wordScores:[186] },
  { id:'roommate', title:'ROOMMATE', existing:[['2A','BOOM'],['6A','RANG']], rack:'RMMT', notation:'B1', score:147, spans:[3], wordScores:[147] },
  { id:'boomerang', title:'BOOMERANG', existing:[['E1','BOOM'],['E6','RANG'],['5A','BOO'],['5F','RANG']], rack:'M', notation:'5A', score:261, spans:[2,1], wordScores:[203,58] },
  { id:'sos', title:'SOS', existing:[['A1','BOOM'],['C1','RANG']], rack:'SS', notation:'5A', score:42, spans:[0,0,0], wordScores:[10,17,15] },
  { id:'anopias', title:'ANOPIAS', existing:[['F1','FLOPPY'],['3A','SCHIZOGNATHOUS'],['5B','ZYGAPOPHYSEAL']], rack:'NS', notation:'4C', score:171, spans:[0,1,1,1,1,1,1], wordScores:[51,18,20,24,16,24,18] },
];
function action(notation:string, word:string): PlaceWordAction {
  const horizontal=/^\d/.test(notation);
  const match=(horizontal?/^(\d+)([A-O])$/:/^([A-O])(\d+)$/).exec(notation);
  assert(match, `Invalid notation ${notation}`);
  return {type:'PLACE_WORD',row:Number(match[horizontal?1:2])-1,column:match[horizontal?2:1]!.charCodeAt(0)-65,direction:horizontal?'H':'V',word};
}
function indices(move:Pick<PlaceWordAction,'row'|'column'|'direction'|'word'>):number[] {
  return [...move.word].map((_,i)=>(move.row+(move.direction==='V'?i:0))*15+move.column+(move.direction==='H'?i:0));
}
function put(board:Board, notation:string, word:string):void {
  const squares=indices(action(notation,word));
  squares.forEach((square,i)=> {assert(board[square]===null || board[square]===word[i]);board[square]=word[i] as Letter;});
}
function fixture(existing:string[][], rack:string):EngineState {
  let state=createGame({id:'tutorial',players:[{id:'tutorial-one',username:'Alice'},{id:'tutorial-two',username:'Ben'}],minutes:15,lexiconVersion:lexicon.sha256,seedWords:['CROSSWORD','WORDGAMES'],now:0,randomInt:()=>0,firstSeat:0},lexicon);
  state=setConnected(state,0,true,0);state=setConnected(state,1,true,0);state=startIfReady(state,3000);
  state.board=Array<Letter|null>(225).fill(null);
  for(const [notation,word] of existing)put(state.board,notation!,word!);
  state.players[0].rack=[...rack] as Letter[];state.players[1].rack=[];
  state.principalHistory=[...new Set(existing.map(pair=>pair[1]!))];state.moves=[];state.bag={...INITIAL_COUNTS};
  for(const letter of [...state.board,...state.players[0].rack])if(letter)state.bag[letter]--;
  state.consonantDrawOrder=[];
  for(const letter of LETTERS)if(!isVowel(letter))for(let i=0;i<state.bag[letter];i++)state.consonantDrawOrder.push(letter);
  assertStateInvariants(state);return state;
}
const examples=specs.map(spec=>{
  const state=fixture(spec.existing,spec.rack), beforeBoard=[...state.board], before=JSON.stringify(state);
  const move=action(spec.notation,spec.title),result=evaluatePlacement(state,0,move,lexicon);
  assert.equal(JSON.stringify(state),before,'Evaluation must not mutate the source position');
  assert.equal(result.score,spec.score);assert.deepEqual(result.words.map(word=>word.spans),spec.spans);
  assert.deepEqual(result.words.map(word=>word.score),spec.wordScores);
  for(const word of result.words)assert(lexicon.has(word.word),`${word.word} must be in the actual dictionary`);
  const words=result.words.map(word=>{
    const squares=indices(word),old=squares.filter(square=>beforeBoard[square]!==null);
    const pillars=old.length===0?[]:old.length===1?[old[0]!]:[old[0]!,old.at(-1)!];
    const first=squares.indexOf(pillars[0]??-1),last=squares.indexOf(pillars.at(-1)??-1);
    const spanIndices=first>=0 && last>first?squares.slice(first+1,last).filter(square=>beforeBoard[square]===null):[];
    assert.equal(spanIndices.length,word.spans,'Visual span markers must equal the engine count');
    return {...word,indices:squares,pillars,spanIndices};
  });
  return {id:spec.id,title:spec.title,beforeBoard,action:move,afterBoard:result.board,newTiles:result.tiles,words,score:result.score,expectedScore:spec.score,notation:spec.notation,existing:spec.existing,rack:spec.rack};
});
assert.equal(examples.find(item=>item.id==='anopias')!.newTiles.length,6);
assert.deepEqual(examples.find(item=>item.id==='anopias')!.words.slice(1).map(word=>word.word),['HAY','ING','ZOA','GIO','NAP','ASH']);

const teachingBoard=Array<Letter|null>(225).fill(null);
put(teachingBoard,'8C','MAST');put(teachingBoard,'8I','PIECE');
let draft=clickSquare(emptyDraft(),teachingBoard,7*15+6);
const steps=[{label:'Click G8',draft:structuredClone(draft)}];
for(const letter of ['E','R'] as const){const result=typeLetter(draft,teachingBoard,letter,['R'],{A:10,E:10,I:10,O:10,U:10,Y:10});assert.equal(result.error,null);draft=result.draft;steps.push({label:`Type ${letter}`,draft:structuredClone(draft)});}
const inferred=inferMove(draft,teachingBoard);
assert.deepEqual(inferred,{type:'PLACE_WORD',row:7,column:2,direction:'H',word:'MASTERPIECE'});
assert(lexicon.has('MASTERPIECE'));
await writeFile(new URL('masterpiece.json',here),JSON.stringify({beforeBoard:teachingBoard,steps,inferred},null,2)+'\n');
await writeFile(new URL('examples.json',here),JSON.stringify(examples,null,2)+'\n');

type Scene={id:string;chapter:string;title:string;kind:string;narration:string;bullets:string[];asset?:string;example?:string;minDuration?:number};
const scenes=JSON.parse(await readFile(new URL('scenes.json',here),'utf8')) as Scene[];
assert(scenes.length>=28 && scenes.length<=34);
assert.equal(new Set(scenes.map(scene=>scene.id)).size,scenes.length);
const wordCount=scenes.reduce((sum,scene)=>sum+scene.narration.trim().split(/\s+/).length,0);
assert(wordCount>=900 && wordCount<=1000,`Narration must contain 900–1000 words; found ${wordCount}`);
for(const scene of scenes){assert(scene.narration.length>0 && scene.bullets.length>0);if(scene.example)assert(examples.some(item=>item.id===scene.example));}
const coverage=JSON.parse(await readFile(new URL('coverage.json',here),'utf8')) as Record<string,string[]>;
for(const [rule,ids]of Object.entries(coverage)){assert(ids.length>0,rule);for(const id of ids)assert(scenes.some(scene=>scene.id===id),`${rule} maps to missing ${id}`);}
const letterTable=LETTERS.map(letter=>`| ${letter} | ${isVowel(letter)?'Vowel':'Consonant'} | ${LETTER_VALUES[letter]} | ${INITIAL_COUNTS[letter]} |`).join('\n');
const totalTiles=Object.values(INITIAL_COUNTS).reduce((sum,value)=>sum+value,0);
assert.equal(totalTiles,267);assert.equal(VOWELS.reduce((sum,letter)=>sum+INITIAL_COUNTS[letter],0),90);
await writeFile(new URL('letter-values.json',here),JSON.stringify(LETTERS.map(letter=>({letter,isVowel:isVowel(letter),value:LETTER_VALUES[letter],count:INITIAL_COUNTS[letter]})),null,2)+'\n');
const intro=`# BestWord tutorial transcript\n\n${scenes.length} scenes · ${wordCount} spoken words. Narration: Microsoft Zira Desktop (US English). Constructed scoring and input positions are labeled teaching examples; application clips show the actual client. Timings are finalized after narration synthesis.\n\n`;
await writeFile(new URL('script.md',here),intro+scenes.map((scene,i)=>`## ${String(i+1).padStart(2,'0')}. ${scene.title}\n\nChapter: ${scene.chapter} · Scene: ${scene.id}\n\n${scene.narration}\n\nOn screen:\n\n${scene.bullets.map(text=>`- ${text}`).join('\n')}\n`).join('\n'));
const template=await readFile(new URL('rules-reference.template.md',here),'utf8');
await writeFile(new URL('rules-reference.md',here),template.replace('{{LETTER_TABLE}}',letterTable));
const report={verifiedAt:new Date().toISOString(),status:'passed',dictionarySha256:lexicon.sha256,engineSource:fileURLToPath(new URL('packages/engine/src/index.ts',root)),sourceMethod:'production evaluatePlacement + exact shipped GADDAG; visual pillars and spans independently derived from pre-move board',scenes:scenes.length,narrationWordCount:wordCount,coverageRules:Object.keys(coverage).length,examples:examples.map(item=>({id:item.id,word:item.title,score:item.score,newTiles:item.newTiles.length,words:item.words.map(word=>({word:word.word,score:word.score,spans:word.spans,pillars:word.pillars,spanIndices:word.spanIndices}))})),masterpiece:{productionDraftFunctions:true,inferred},letterInventory:{total:totalTiles,vowels:90,consonants:177},checks:['Five published scores match production engine','Every formed word exists in exact production lexicon','No input state mutation','Tile conservation valid in source positions','Visual span counts match engine','Six new tiles / six secondary bridges for ANOPIAS','MASTERPIECE inferred by production draft functions','All 26 values and quantities imported from engine','Rule coverage references real scenes','Narration has 900–1000 words'],limitations:['Constructed score positions illustrate the specifications; not claims of reachable complete game histories.','Narration, footage, visual layout, timing, captions and full-video playback require separate production QA.']};
await writeFile(new URL('verification.json',here),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,scenes:scenes.length,narrationWordCount:wordCount,coverageRules:report.coverageRules,examples:examples.map(item=>({id:item.id,score:item.score})),masterpiece:inferred},null,2));

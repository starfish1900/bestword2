import { test, expect, type Page } from '@playwright/test';
import { isVowel, type GameView, type Letter, type PlaceWordAction, type PlacedTile } from '@bestword/contracts';
import { LETTER_VALUES } from '@bestword/engine';
import { account, findLegalPlacement } from './helpers';

async function tapLetter(page:Page,letter:Letter){
  const tile=isVowel(letter)
    ? page.locator('.vowel-tile').filter({has:page.locator('strong',{hasText:new RegExp(`^${letter}`)})})
    : page.locator('.rack-tile:not(:disabled)').filter({hasText:new RegExp(`^${letter}`)}).first();
  await expect(tile).toBeEnabled();await tile.tap();
}

// Independent calculation from visible board and proposed tiles; no engine transition/evaluator.
function scorePlacement(view:GameView,action:PlaceWordAction,tiles:PlacedTile[]){
  const before=view.game.board;const after=[...before];for(const tile of tiles)after[tile.row*15+tile.column]=tile.letter;
  const score=(indices:number[],principal:boolean)=>{
    const old=indices.flatMap((index,offset)=>before[index]?[offset]:[]);
    const first=old[0]??0,last=old.at(-1)??0;
    const spans=indices.filter((index,offset)=>offset>first&&offset<last&&!before[index]).length;
    const letters=indices.map(index=>after[index]!);
    const value=letters.reduce((total,letter)=>total+LETTER_VALUES[letter],0);
    return value*(principal?letters.filter(letter=>!isVowel(letter)).length+spans:spans>0?2:1);
  };
  const dr=action.direction==='V'?1:0,dc=action.direction==='H'?1:0;
  let total=score([...action.word].map((_,index)=>(action.row+dr*index)*15+action.column+dc*index),true);
  for(const tile of tiles){
    const indices=[tile.row*15+tile.column];let row=tile.row-dc,column=tile.column-dr;
    while(row>=0&&column>=0&&after[row*15+column]){indices.unshift(row*15+column);row-=dc;column-=dr;}
    row=tile.row+dc;column=tile.column+dr;
    while(row<15&&column<15&&after[row*15+column]){indices.push(row*15+column);row+=dc;column+=dr;}
    if(indices.length>1)total+=score(indices,false);
  }
  return total;
}

test('real 320x568 touchscreen plays rack and vowel tiles, erases and passes',async({browser,baseURL},testInfo)=>{
  const origin=baseURL!,prefix=`BW${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,13);
  const options={hasTouch:true,viewport:{width:320,height:568}};
  const alice=await account(browser,origin,`${prefix}A`,undefined,options);
  const bob=await account(browser,origin,`${prefix}B`,undefined,options);
  const errors:string[]=[];for(const player of [alice,bob])player.page.on('pageerror',error=>errors.push(error.message));
  try{
    await alice.page.getByRole('button',{name:'Create a game',exact:true}).tap();
    await expect(alice.page.locator('.your-seek')).toBeVisible();
    await bob.page.locator('.seek-row').filter({hasText:`${prefix}A`}).getByRole('button',{name:'Join',exact:true}).tap();
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());
    const gameId=bob.page.url().split('/').at(-1)!;
    const read=async(player=alice):Promise<GameView>=>{const response=await player.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&view.game.startsAt===null;}).toBe(true);
    const initial=await read(),actor=initial.you?.seat===initial.game.activeSeat?alice:bob,other=actor===alice?bob:alice;
    const before=await read(actor);const placement=await findLegalPlacement(before,tiles=>tiles.some(tile=>isVowel(tile.letter))&&tiles.some(tile=>!isVowel(tile.letter)));
    const expectedScore=scorePlacement(before,placement.action,placement.tiles);expect(expectedScore).toBeGreaterThan(0);
    // WebKit on Windows reports maxTouchPoints=0 even with hasTouch; verify
    // delivered touchstart events and the absence of keyboard events below.
    const maxTouchPoints=await actor.page.evaluate(()=>navigator.maxTouchPoints);
    await actor.page.evaluate(()=>{
      const counts={touch:0,keyboard:0};(window as unknown as {inputCounts:typeof counts}).inputCounts=counts;
      document.addEventListener('touchstart',()=>counts.touch++,{passive:true});document.addEventListener('keydown',()=>counts.keyboard++);
    });
    const first=placement.tiles[0]!;const target=actor.page.locator(`#square-${first.row*15+first.column}`);
    await target.tap();if(placement.action.direction==='V')await target.tap();
    await expect(target).toHaveAttribute('aria-label',new RegExp(`${placement.action.direction==='H'?'horizontal':'vertical'} cursor`));
    for(const tile of placement.tiles)await tapLetter(actor.page,tile.letter);
    await expect(actor.page.locator('.draft-tile')).toHaveCount(placement.tiles.length);
    await actor.page.getByRole('button',{name:'Erase last letter',exact:true}).tap();
    await expect(actor.page.locator('.draft-tile')).toHaveCount(placement.tiles.length-1);
    await tapLetter(actor.page,placement.tiles.at(-1)!.letter);await expect(actor.page.locator('.draft-tile')).toHaveCount(placement.tiles.length);
    await actor.page.screenshot({path:testInfo.outputPath('touch-draft.png')});
    await actor.page.getByRole('button',{name:'Play word',exact:true}).tap();
    await expect.poll(async()=>(await read(actor)).game.moves.length).toBe(1);
    const accepted=await read(actor);expect(accepted.game.moves[0]!.tiles).toEqual(placement.tiles);
    expect(accepted.game.moves[0]!.score).toBe(expectedScore);expect(accepted.game.players[before.you!.seat].score-before.game.players[before.you!.seat].score).toBe(expectedScore);
    for(const tile of placement.tiles)expect(accepted.game.board[tile.row*15+tile.column]).toBe(tile.letter);
    await expect(actor.page.locator('.draft-tile')).toHaveCount(0);
    const dimensions=await actor.page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
    expect(dimensions.width).toBeLessThanOrEqual(320);expect(dimensions.height).toBeLessThanOrEqual(568);
    await actor.page.screenshot({path:testInfo.outputPath('touch-accepted.png')});
    for(const player of [other,actor]){
      await expect(player.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
      await player.page.getByRole('button',{name:'Pass forever',exact:true}).tap();
      await player.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).tap();
    }
    await expect.poll(async()=>(await read()).game.status).toBe('finished');
    const ended=await read();expect(ended.game.moves.map(move=>move.action)).toEqual(['PLACE_WORD','PASS','PASS']);
    const inputs=await actor.page.evaluate(()=>(window as unknown as {inputCounts:{touch:number;keyboard:number}}).inputCounts);
    expect(inputs.touch).toBeGreaterThanOrEqual(placement.tiles.length+6);expect(inputs.keyboard).toBe(0);expect(errors).toEqual([]);
    await testInfo.attach('touch-verification',{body:JSON.stringify({gameId,word:placement.action.word,tiles:placement.tiles,expectedScore,inputs,maxTouchPoints,hasTouch:options.hasTouch,viewport:options.viewport},null,2),contentType:'application/json'});
  }finally{await alice.context.close();await bob.context.close();}
});

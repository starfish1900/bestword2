import { test, expect, type Page } from '@playwright/test';
import type { GameView, PublicGame } from '@bestword/contracts';
import { account, enterPlacement, findLegalPlacement } from './helpers';

const colors=['rgb(217, 234, 211)','rgb(248, 223, 198)'];
async function expectOrigins(page:Page,game:PublicGame,moveCount=game.moves.length){
  const origins=game.board.map(letter=>letter?'opening':null) as Array<string|number|null>;
  for(const move of game.moves)for(const tile of move.tiles)origins[tile.row*15+tile.column]=null;
  for(const move of game.moves.slice(0,moveCount))for(const tile of move.tiles)origins[tile.row*15+tile.column]=move.seat;
  const actual=await page.locator('.square').evaluateAll(squares=>squares.map(square=>({background:getComputedStyle(square).backgroundColor,label:square.getAttribute('aria-label'),className:square.className})));
  for(let index=0;index<origins.length;index++){
    const origin=origins[index],square=actual[index]!;
    if(origin==='opening'){expect(square.background).toBe('rgb(228, 229, 231)');expect(square.label).toContain('opening tile');}
    else if(typeof origin==='number'){expect(square.background).toBe(colors[origin]);expect(square.label).toContain(`placed by ${game.players[origin as 0|1].username}`);}
    else expect(square.className).not.toContain('occupied');
  }
  for(const seat of [0,1] as const)await expect(page.locator(`.player-swatch.player-${seat}`)).toHaveAttribute('aria-label',seat===0?'Pale green tiles':'Pale orange tiles');
}

async function expectUniformGrid(page:Page){
  const grid=await page.evaluate(()=>{
    const board=document.querySelector('.board-grid')!,rect=board.getBoundingClientRect(),style=getComputedStyle(board);
    const cells=[...document.querySelectorAll('[role=gridcell]')].map(cell=>{const box=cell.getBoundingClientRect(),square=cell.querySelector('.square')!,css=getComputedStyle(square);return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height,rightBorder:css.borderRightWidth,bottomBorder:css.borderBottomWidth,rightColor:css.borderRightColor,bottomColor:css.borderBottomColor,overflow:getComputedStyle(cell).overflow,occupied:square.classList.contains('occupied')};});
    return {cells,borderLeft:style.borderLeftWidth,borderTop:style.borderTopWidth,gap:style.gap,width:rect.width,height:rect.height,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,viewportWidth:innerWidth,viewportHeight:innerHeight,pixelRatio:devicePixelRatio};
  });
  // WebKit snaps a 1 CSS px border to a device pixel (0.8 CSS px at DPR 1.25).
  const borderWidth=parseFloat(grid.borderLeft);
  expect(borderWidth).toBeGreaterThanOrEqual(1/grid.pixelRatio-0.000001);expect(borderWidth).toBeLessThanOrEqual(1.000001);
  expect(borderWidth*grid.pixelRatio).toBeGreaterThanOrEqual(0.999999);expect(parseFloat(grid.borderTop)).toBeCloseTo(borderWidth,6);expect(grid.gap).toBe('0px');
  expect(grid.cells).toHaveLength(225);expect(Math.abs(grid.width-grid.height)).toBeLessThanOrEqual(1);
  for(let index=0;index<grid.cells.length;index++){
    const cell=grid.cells[index]!;expect(parseFloat(cell.rightBorder)).toBeCloseTo(borderWidth,6);expect(parseFloat(cell.bottomBorder)).toBeCloseTo(borderWidth,6);expect(cell.rightColor).toBe('rgb(155, 164, 158)');expect(cell.bottomColor).toBe(cell.rightColor);expect(cell.overflow).toBe('hidden');
    expect(Math.abs(cell.width-cell.height)).toBeLessThanOrEqual(1);
    if(index%15<14)expect(Math.abs(cell.right-grid.cells[index+1]!.left)).toBeLessThan(.05);
    if(index<210)expect(Math.abs(cell.bottom-grid.cells[index+15]!.top)).toBeLessThan(.05);
  }
  expect(grid.scrollWidth).toBeLessThanOrEqual(grid.viewportWidth);expect(grid.scrollHeight).toBeLessThanOrEqual(grid.viewportHeight);
  // Computed CSS alone cannot catch fractional borders lost during rasterization.
  // Check every separator in screenshot pixels, sampling empty cell centres so
  // letters and latest-move outlines cannot masquerade as (or cover) grid lines.
  const png=(await page.screenshot()).toString('base64');
  const visibility=await page.evaluate(async({png,cells,dpr})=>{
    const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);const data=context.getImageData(0,0,image.width,image.height).data;
    const linePixel=(x:number,y:number)=>{const index=(y*image.width+x)*4;return Math.abs(data[index]!-155)<=35&&Math.abs(data[index+1]!-164)<=35&&Math.abs(data[index+2]!-158)<=35;};
    const lines:Array<{axis:string;boundary:number;samples:number;visible:number}>=[];
    for(const axis of ['vertical','horizontal'])for(let boundary=1;boundary<15;boundary++){
      let samples=0,visible=0;
      for(let along=0;along<15;along++){
        const index=axis==='vertical'?along*15+boundary:boundary*15+along;
        const cell=cells[index]!,previous=cells[index-(axis==='vertical'?1:15)]!;
        if(cell.occupied||previous.occupied)continue;
        const x=(axis==='vertical'?cell.left:cell.left+cell.width/2)*dpr;
        const y=(axis==='horizontal'?cell.top:cell.top+cell.height/2)*dpr;
        let found=false;
        for(let offset=-3;offset<=2;offset++)found||=linePixel(Math.floor(x)+(axis==='vertical'?offset:0),Math.floor(y)+(axis==='horizontal'?offset:0));
        samples++;if(found)visible++;
      }
      lines.push({axis,boundary,samples,visible});
    }
    return lines;
  },{png,cells:grid.cells,dpr:grid.pixelRatio});
  for(const line of visibility){expect(line.samples,JSON.stringify(line)).toBeGreaterThan(0);expect(line.visible,JSON.stringify(line)).toBe(line.samples);}
}

test('opening and player tiles retain colors for both players, spectator, reload and replay; all grid boundaries remain visible',async({browser,baseURL},testInfo)=>{
  const origin=baseURL!,prefix=`BC${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,13);
  const alice=await account(browser,origin,`${prefix}A`),bob=await account(browser,origin,`${prefix}B`);
  const spectator=await browser.newContext({baseURL:origin,deviceScaleFactor:1.25,viewport:{width:1280,height:800}}),watch=await spectator.newPage();
  try{
    await alice.page.getByRole('button',{name:'Create a game',exact:true}).click();await expect(alice.page.locator('.your-seek')).toBeVisible();
    await bob.page.locator('.seek-row').filter({hasText:`${prefix}A`}).getByRole('button',{name:'Join',exact:true}).click();await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());
    const gameId=bob.page.url().split('/').at(-1)!;
    const read=async(player=alice):Promise<GameView>=>{const response=await player.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&view.game.startsAt===null;}).toBe(true);
    await watch.goto(`/game/${gameId}`);await expect(watch.locator('.game-format')).toContainText('Spectating');const initial=await read();await expectOrigins(watch,initial.game);
    for(let turn=0;turn<2;turn++){
      const view=await read(),actor=view.you!.seat===view.game.activeSeat?alice:bob;
      await expect(actor.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();const placement=await findLegalPlacement(await read(actor));await enterPlacement(actor.page,placement);
      await expect.poll(async()=>(await read()).game.moves.length).toBe(turn+1);await expect(watch.locator('.board-footnote')).toContainText(placement.action.word);
    }
    const played=await read();for(const page of [alice.page,bob.page,watch]){await expect(page.locator('.board-footnote')).toContainText(played.game.moves.at(-1)!.word!);await expectOrigins(page,played.game);}
    await watch.reload();await expect(watch.locator('.board-footnote')).toContainText(played.game.moves.at(-1)!.word!);await expectOrigins(watch,played.game);
    // Each square paints only its right and bottom borders, including E/F, M/N, 5/6 and 13/14.
    for(const [label,width,height] of [['desktop',1280,800],['portrait',390,844],['small-phone',320,568],['landscape',568,320]] as const){await watch.setViewportSize({width,height});await expectUniformGrid(watch);await watch.screenshot({path:testInfo.outputPath(`board-${label}-125percent.png`)});}
    const playing=await read(),first=playing.you!.seat===playing.game.activeSeat?alice:bob,second=first===alice?bob:alice;
    for(const player of [first,second]){await expect(player.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();await player.page.getByRole('button',{name:'Pass forever',exact:true}).click();await player.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();}
    await expect(watch.getByRole('link',{name:'Sign in to replay',exact:true})).toBeVisible();await spectator.addCookies(await alice.context.cookies());await watch.reload();await watch.getByRole('button',{name:'Explore the replay',exact:true}).click();const final=(await read()).game;await expectOrigins(watch,final,0);
    await watch.getByRole('button',{name:'Next move',exact:true}).click();await expectOrigins(watch,final,1);
    await watch.getByRole('button',{name:'Next move',exact:true}).click();await expectOrigins(watch,final,2);
    await watch.getByRole('button',{name:'Previous move',exact:true}).click();await expectOrigins(watch,final,1);
    await watch.getByRole('button',{name:'Game rules',exact:true}).click();await expect(watch.getByRole('dialog')).toContainText('at least one vowel and one consonant');await expect(watch.getByRole('dialog')).toContainText('Y is a vowel');
  }finally{await alice.context.close();await bob.context.close();await spectator.close();}
});

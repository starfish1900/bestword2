import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { isVowel, type GameView, type Letter, type PlaceWordAction, type PlacedTile } from '@bestword/contracts';
const password='BestWordTestOnly2026!';
export async function account(browser:Browser,baseURL:string,username:string,onPage?:(page:Page)=>void,contextOptions:Parameters<Browser['newContext']>[0]={}):Promise<{context:BrowserContext;page:Page}> {
  const context=await browser.newContext({baseURL,viewport:{width:1280,height:800},...contextOptions});const page=await context.newPage();
  onPage?.(page);
  try {
    // Reuse the run's pair through one UI login, without a duplicate HTTP probe.
    await page.goto('/sign-in');
    await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill(password);
    const loginResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login'&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();const login=await loginResponse;
    if(login.status()===401){
      // Only an explicit invalid-credentials response may trigger new-account setup.
      await page.goto('/sign-up');
      await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill(password);
      const registrationResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/register'&&response.request().method()==='POST');
      await page.getByRole('button',{name:'Create account',exact:true}).click();expect((await registrationResponse).ok()).toBe(true);
    }else expect(login.ok()).toBe(true);
    await expect(page).toHaveURL(`${baseURL}/`);await expect(page.getByRole('heading',{name:'Find your next game'})).toBeVisible();
    return {context,page};
  }catch(error){await context.close();throw error;}
}
let dictionary:Promise<Set<string>>|undefined;
async function words(){dictionary??=readFile(resolve('data/dictionary.txt'),'utf8').then(text=>new Set(text.split(/\r?\n/).map(item=>item.trim()).filter(Boolean)));return dictionary;}
export async function findLegalPlacement(view:GameView,accept?:(tiles:PlacedTile[])=>boolean):Promise<{action:PlaceWordAction;tiles:PlacedTile[]}> {
  if(!view.you)throw Error('A player rack is required.');
  const lexicon=await words();const board=view.game.board;const anchors=board.flatMap((letter,index)=>letter?[{letter,index}]:[]);
  const rack=view.you.rack.reduce<Record<string,number>>((counts,letter)=>{counts[letter]=(counts[letter]??0)+1;return counts;},{});
  const history=new Set(view.game.principalHistory);
  // Independent short-word search creates a real legal browser test move, not an AI feature.
  for(const word of [...lexicon].filter(word=>word.length<=8).sort((a,b)=>a.length-b.length)) {
    if(history.has(word))continue;
    for(const anchor of anchors)for(let offset=0;offset<word.length;offset++) {
      if(word[offset]!==anchor.letter)continue;
      for(const direction of ['H','V'] as const) {
        const row=Math.floor(anchor.index/15)-(direction==='V'?offset:0);const column=anchor.index%15-(direction==='H'?offset:0);
        if(row<0||column<0||row+(direction==='V'?word.length:1)>15||column+(direction==='H'?word.length:1)>15)continue;
        const endRow=row+(direction==='V'?word.length-1:0);const endCol=column+(direction==='H'?word.length-1:0);
        if((direction==='H'&&column>0&&board[row*15+column-1])||(direction==='V'&&row>0&&board[(row-1)*15+column]))continue;
        if((direction==='H'&&endCol<14&&board[endRow*15+endCol+1])||(direction==='V'&&endRow<14&&board[(endRow+1)*15+endCol]))continue;
        const used:Record<string,number>={};const tiles:PlacedTile[]=[];let valid=true;
        for(let at=0;at<word.length;at++) {
          const r=row+(direction==='V'?at:0),c=column+(direction==='H'?at:0);const letter=word[at] as Letter;const old=board[r*15+c];
          if(old){if(old!==letter){valid=false;break;}continue;}
          used[letter]=(used[letter]??0)+1;const count=isVowel(letter)?view.game.vowelsRemaining[letter]:rack[letter]??0;if(used[letter]!>count){valid=false;break;}
          let before='',after='';let rr=r-(direction==='H'?1:0),cc=c-(direction==='V'?1:0);
          while(rr>=0&&cc>=0&&board[rr*15+cc]){before=board[rr*15+cc]+before;rr-=direction==='H'?1:0;cc-=direction==='V'?1:0;}
          rr=r+(direction==='H'?1:0);cc=c+(direction==='V'?1:0);
          while(rr<15&&cc<15&&board[rr*15+cc]){after+=board[rr*15+cc];rr+=direction==='H'?1:0;cc+=direction==='V'?1:0;}
          const secondary=before+letter+after;if(secondary.length>1&&!lexicon.has(secondary)){valid=false;break;}tiles.push({row:r,column:c,letter});
        }
        if(valid&&tiles.length>=2&&(!accept||accept(tiles)))return {action:{type:'PLACE_WORD',row,column,direction,word},tiles};
      }
    }
  }
  throw Error('No legal short test move found for the generated board/rack.');
}
export async function enterPlacement(page:Page,placement:{action:PlaceWordAction;tiles:PlacedTile[]}) {
  const first=placement.tiles[0]!;const target=page.locator(`#square-${first.row*15+first.column}`);await target.click();
  const expected=placement.action.direction==='H'?'horizontal cursor':'vertical cursor';
  if(!(await target.getAttribute('aria-label'))?.includes(expected))await target.click();
  await expect(target).toHaveAttribute('aria-label',new RegExp(expected));await page.keyboard.type(placement.tiles.map(tile=>tile.letter).join(''));
  await expect(page.locator('.draft-tile')).toHaveCount(placement.tiles.length);await page.getByRole('button',{name:'Play word',exact:true}).click();
}

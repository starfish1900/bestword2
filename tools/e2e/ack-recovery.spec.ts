import { test, expect } from '@playwright/test';
import type { CommandReply, GameCommand, GameView } from '@bestword/contracts';
import { account, enterPlacement, findLegalPlacement } from './helpers';

test('ack fixture preserves a committed command through SERVICE_RECOVERING and retry',async({browser,browserName,baseURL},testInfo)=>{
  test.skip(browserName!=='chromium','Focused Chromium wire-acknowledgement fixture');
  // The server really commits. Only its first successful WebSocket acknowledgement
  // is replaced; this checks client recovery, not a real PostgreSQL network fault.
  const origin=baseURL!,prefix=`BW${process.env.BESTWORD_E2E_RUN_ID}`.slice(0,13);
  const alice=await account(browser,origin,`${prefix}A`),bob=await account(browser,origin,`${prefix}B`);
  const fixture={replaced:false,held:false,release:()=>{},originalId:'',reply:null as CommandReply|null};
  const sent:GameCommand[]=[];
  try{
    for(const player of [alice,bob]){
      await player.page.routeWebSocket('**/socket.io/**',route=>{
        const server=route.connectToServer();const commands=new Map<string,GameCommand>();
        route.onMessage(message=>{
          const frame=/^42(\d+)(\[.*)$/s.exec(String(message));
          if(frame){const [event,command]=JSON.parse(frame[2]!) as [string,GameCommand];if(event==='game:command'&&command.action.type==='PLACE_WORD'){commands.set(frame[1]!,command);sent.push(command);}}
          server.send(message);
        });
        server.onMessage(message=>{
          const frame=/^43(\d+)(\[.*)$/s.exec(String(message));const command=frame?commands.get(frame[1]!):undefined;
          if(frame&&command){
            const [reply]=JSON.parse(frame[2]!) as [CommandReply];
            if(reply.ok&&!fixture.replaced){
              fixture.replaced=true;fixture.originalId=command.commandId;
              route.send(`43${frame[1]}${JSON.stringify([{ok:false,error:{code:'SERVICE_RECOVERING',message:'Injected acknowledgement uncertainty after a real commit.'}}])}`);
              return;
            }
            if(fixture.replaced&&!fixture.held&&command.commandId===fixture.originalId){
              fixture.held=true;fixture.reply=reply;fixture.release=()=>{route.send(message);fixture.release=()=>{};};return;
            }
          }
          route.send(message);
        });
      });
      // Existing lobby sockets predate routing; reload so all game frames use the proxy.
      await player.page.reload();await expect(player.page.getByRole('heading',{name:'Find your next game'})).toBeVisible();
    }
    await alice.page.getByRole('button',{name:'Create a game',exact:true}).click();await expect(alice.page.locator('.your-seek')).toBeVisible();
    await bob.page.locator('.seek-row').filter({hasText:`${prefix}A`}).getByRole('button',{name:'Join',exact:true}).click();
    await expect(bob.page).toHaveURL(/\/game\/[\da-f-]+$/);await expect(alice.page).toHaveURL(bob.page.url());
    const gameId=bob.page.url().split('/').at(-1)!;
    const read=async(player=alice):Promise<GameView>=>{const response=await player.context.request.get(`/api/games/${gameId}`);expect(response.ok()).toBe(true);return response.json() as Promise<GameView>;};
    await expect.poll(async()=>{const view=await read();return view.game.status==='active'&&view.game.startsAt===null;}).toBe(true);
    const initial=await read(),actor=initial.you?.seat===initial.game.activeSeat?alice:bob,other=actor===alice?bob:alice;
    const placement=await findLegalPlacement(await read(actor));await enterPlacement(actor.page,placement);
    await expect.poll(()=>fixture.held,{timeout:8000}).toBe(true);
    expect(fixture.replaced).toBe(true);expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);expect(fixture.reply?.ok).toBe(true);
    const stored=await actor.page.evaluate(id=>sessionStorage.getItem(`bestword:pending:${id}`),gameId);
    expect(stored).not.toBeNull();expect(JSON.parse(stored!)).toEqual(sent[0]);
    expect((await read(actor)).game.moves).toHaveLength(1);await expect(actor.page.getByRole('button',{name:'Confirming…',exact:true})).toBeDisabled();
    fixture.release();
    await expect.poll(()=>actor.page.evaluate(id=>sessionStorage.getItem(`bestword:pending:${id}`),gameId)).toBeNull();
    const accepted=await read(actor);expect(accepted.game.moves).toHaveLength(1);expect(accepted.game.moves[0]!.word).toBe(placement.action.word);
    expect(sent).toHaveLength(2);
    for(const player of [other,actor]){
      await expect(player.page.getByRole('heading',{name:'Your move',exact:true})).toBeVisible();
      await player.page.getByRole('button',{name:'Pass forever',exact:true}).click();await player.page.getByRole('dialog').getByRole('button',{name:'Pass forever',exact:true}).click();
    }
    await expect.poll(async()=>(await read()).game.status).toBe('finished');
    await testInfo.attach('ack-fixture-verification',{body:JSON.stringify({fixture:'WebSocket acknowledgement replacement after real server commit',gameId,commandId:fixture.originalId,identicalCommandAttempts:sent.length,committedWordCount:accepted.game.moves.length,storageRetainedUntilRealRetryAck:true,storageClearedAfterSuccess:true},null,2),contentType:'application/json'});
  }finally{fixture.release();await alice.context.close();await bob.context.close();}
});

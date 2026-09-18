// Browser layout checks use explicit wire fixtures. Live-server checks are separate.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output=resolve(process.env.CLIENT_QA_OUTPUT??'apps/web/test-results/layout');await mkdir(output,{recursive:true});
const user={id:'11111111-1111-4111-8111-111111111111',username:'Juniper'};
const opponent={id:'22222222-2222-4222-8222-222222222222',username:'Lexicon'};
const gameId='33333333-3333-4333-8333-333333333333';
const board=Array(225).fill(null);
for(const [word,row,col,vertical] of [['WATERMARK',5,3,false],['CROSSWORD',2,5,true]]) [...word].forEach((letter,index)=>board[(row+(vertical?index:0))*15+col+(vertical?0:index)]=letter);
const makeView=()=>({game:{id:gameId,revision:1,rulesVersion:'bestword-1',lexiconVersion:'fixture',status:'active',board,players:[{...user,score:142,rackSize:8,passed:false,connected:true},{...opponent,score:118,rackSize:6,passed:false,connected:true}],activeSeat:0,minutes:15,clocksMs:[845000,875000],turnStartedAt:Date.now()-55000,turnDeadlineAt:Date.now()+845000,startsAt:null,serverTime:Date.now(),vowelsRemaining:{A:13,E:20,I:16,O:10,U:12,Y:8},consonantsRemaining:145,principalHistory:['WATERMARK','CROSSWORD'],moves:[],disconnectDeadlines:[null,null],pause:null,result:null,spectatorCount:3},you:{seat:0,rack:['B','R','T','S','N','L','M','G'],drawnThisTurn:2,canNoWords:true}});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});const errors=[];const report=[];
try{
  for(const [name,width,height] of [['desktop',1280,800],['phone',390,844],['small-phone',320,568],['landscape',568,320]]){
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;const response=path==='/api/session'?{user,activeGameId:gameId}:path.startsWith('/api/games/')&&!['/api/games/live','/api/games/history'].includes(path)?makeView():{items:[],nextCursor:null};await route.fulfill({json:response});});
    await page.routeWebSocket('**/socket.io/**',socket=>{socket.send(`0${JSON.stringify({sid:'layout-session',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000})}`);socket.onMessage(message=>{const text=String(message);if(text==='40')socket.send('40{"sid":"layout-namespace"}');else if(text.startsWith('42')){const at=text.indexOf('[');const id=text.slice(2,at);const [event]=JSON.parse(text.slice(at));if(id)socket.send(`43${id}${JSON.stringify(event.startsWith('game:')?[{ok:true,view:makeView()}]:[{}])}`);}});});
    await page.goto(`http://127.0.0.1:5173/game/${gameId}`);await page.getByRole('heading',{name:'Your move',exact:true}).waitFor();
    await page.screenshot({path:resolve(output,`${name}.png`)});
    const dimensions=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,board:document.querySelector('.board-grid').getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('.rack,.vowels,.submit-row,.alternative-actions')].map(element=>({name:element.className,...element.getBoundingClientRect().toJSON()}))}));
    if(dimensions.scrollWidth>width||dimensions.scrollHeight>height)throw Error(`${name} page overflow: ${JSON.stringify(dimensions)}`);
    for(const control of dimensions.controls)if(control.bottom>height||control.x<0||control.right>width)throw Error(`${name} clipped ${control.name}: ${JSON.stringify(control)}`);
    report.push({name,...dimensions});
    await page.getByRole('button',{name:'H8, empty',exact:true}).click();await page.keyboard.type('B');await page.keyboard.type('A');
    await page.getByRole('button',{name:'H8, B, 8 points, draft',exact:true}).waitFor();await page.getByRole('button',{name:'Play word',exact:true}).waitFor({state:'visible'});
    await page.keyboard.press('Backspace');await page.getByRole('button',{name:'I8, empty, horizontal cursor',exact:true}).waitFor();
    await page.getByRole('button',{name:'Pass forever',exact:true}).click();await page.getByRole('dialog').waitFor();await page.screenshot({path:resolve(output,`${name}-pass.png`)});await page.getByRole('button',{name:'Keep playing'}).click();
    await page.close();
  }
  if(errors.length)throw Error(errors.join('\n'));
  await writeFile(resolve(output,'report.json'),JSON.stringify({fixtureBased:true,checks:report,pageErrors:errors},null,2));console.log(JSON.stringify({output,viewports:report.map(item=>({name:item.name,boardWidth:item.board.width,boardHeight:item.board.height})),pageErrors:errors},null,2));
}finally{await browser.close();}

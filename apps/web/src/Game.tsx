import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { VOWELS, formatNotation, type Board, type CommandReply, type GameAction, type GameCommand, type GameView, type Letter, type PublicGame, type PublicMove, type Seat } from '@bestword/contracts';
import { api, gameRequest, gameSync, getSocket, messageOf, resetSocket, sendCommand } from './api';
import { ErrorNotice, Icon, Modal, Rules, Spinner } from './components';
import { availableCount, clearDraft, clickSquare, emptyDraft, eraseLetter, inferMove, reserved, tileIndex, typeLetter, type Draft } from './draft';
import { replayBoard, replayScores } from './replay';
import { pendingAfterReply } from './pending';
import { useApp } from './store';

const VALUES:Record<Letter,number>={A:1,B:8,C:6,D:4,E:1,F:9,G:6,H:6,I:1,J:11,K:7,L:5,M:5,N:3,O:1,P:8,Q:11,R:3,S:2,T:4,U:2,V:9,W:7,X:10,Y:2,Z:10};
const coordinate=(index:number)=>`${String.fromCharCode(65+index%15)}${Math.floor(index/15)+1}`;
function timeText(milliseconds:number) { const seconds=Math.max(0,Math.ceil(milliseconds/1000)); return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`; }
function readPending(gameId:string):GameCommand|null { try { const raw=sessionStorage.getItem(`bestword:pending:${gameId}`); return raw ? JSON.parse(raw) as GameCommand : null; } catch { return null; } }
function keepPending(gameId:string,command:GameCommand|null) { try { if(command) sessionStorage.setItem(`bestword:pending:${gameId}`,JSON.stringify(command)); else sessionStorage.removeItem(`bestword:pending:${gameId}`); } catch { /* Storage can be disabled; in-memory retry still works. */ } }
function resultText(game:PublicGame) {
  if(!game.result) return '';
  const {winner,reason}=game.result;
  if(reason==='infrastructure-aborted') return 'Game closed · no winner';
  if(reason==='start-cancelled') return 'Game cancelled · player absent';
  if(reason==='simultaneous-abandonment') return 'Game closed · no winner';
  if(winner===null) return 'A well-played draw';
  return `${game.players[winner].username} wins`;
}

export function Game() {
  const {gameId=''}=useParams(); const [searchParams]=useSearchParams();
  const {view:storedView,setView,clearView,setActiveGameId}=useApp(); const user=useApp(state=>state.user);
  const view=storedView?.game.id===gameId?storedView:null;
  const [connected,setConnected]=useState(false); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const [draft,setDraft]=useState<Draft>(emptyDraft); const [now,setNow]=useState(()=>performance.now()); const [offset,setOffset]=useState(0);
  const [pending,setPending]=useState<GameCommand|null>(()=>readPending(gameId)); const [sending,setSending]=useState(false);
  const [confirmPass,setConfirmPass]=useState(false); const [historyOpen,setHistoryOpen]=useState(false); const [help,setHelp]=useState(false); const [leaveOpen,setLeaveOpen]=useState(false);
  const [replayMode,setReplayMode]=useState(searchParams.has('replay')); const [replayIndex,setReplayIndex]=useState(0); const [autoReplay,setAutoReplay]=useState(false);
  const [copyStatus,setCopyStatus]=useState('');
  const viewRef=useRef<GameView|null>(null); const previousTurn=useRef<string|null>(null); const boardRef=useRef<HTMLDivElement>(null);
  const latestClockTime=useRef(0);
  const anchorClock=useCallback((serverTime:number)=>{
    if(serverTime<latestClockTime.current)return;
    latestClockTime.current=serverTime;
    // Local wall-clock changes must not advance deadlines or disable a valid turn.
    const localTime=performance.now();setOffset(serverTime-localTime);setNow(localTime);
  },[]);
  const receive=useCallback((next:GameView)=>{
    if(next.game.id!==gameId) return;
    if(viewRef.current && viewRef.current.game.id===gameId && (next.game.revision<viewRef.current.game.revision||(next.game.revision===viewRef.current.game.revision&&next.game.serverTime<viewRef.current.game.serverTime))) return;
    viewRef.current=next; setView(next); anchorClock(next.game.serverTime); setLoading(false);
    if(next.you) { if(next.game.status==='finished'||next.game.players[next.you.seat].passed) { if(useApp.getState().activeGameId===gameId)setActiveGameId(null); } else setActiveGameId(gameId); }
    const turn=`${next.game.moves.length}:${next.game.activeSeat}`;
    if(previousTurn.current!==null && previousTurn.current!==turn) { setDraft(emptyDraft()); setError(''); }
    previousTurn.current=turn;
    if(next.game.status==='finished') { setConfirmPass(false); setDraft(emptyDraft()); }
  },[anchorClock,gameId,setView,setActiveGameId]);
  const handleReply=useCallback((reply:CommandReply)=>{ if(reply.ok) receive(reply.view); else { if(reply.view) receive(reply.view); setError(reply.error.message); } },[receive]);
  const sync=useCallback(async()=>{
    const revision=viewRef.current?.game.revision;
    try {
      const reply=await gameSync(gameId,revision);
      if('unchanged'in reply){
        if(viewRef.current?.game.id===gameId&&viewRef.current.game.revision===revision)anchorClock(reply.serverTime);
      }else handleReply(reply);
    }catch(error){setError(messageOf(error));}
  },[anchorClock,gameId,handleReply]);
  useEffect(()=>{
    clearView(); viewRef.current=null; previousTurn.current=null; latestClockTime.current=0; setLoading(true); setDraft(emptyDraft()); setPending(readPending(gameId)); setReplayIndex(0); setAutoReplay(false); setReplayMode(searchParams.has('replay'));
    let alive=true; let reconnectTimer:number|undefined;
    void api<GameView>(`/games/${gameId}`).then(next=>{if(alive)receive(next);}).catch(error=>{if(alive){setError(messageOf(error));setLoading(false);}});
    const socket=getSocket();
    const subscribe=()=>{setConnected(true);setError('');void gameRequest('game:subscribe',gameId).then(reply=>{if(alive)handleReply(reply);}).catch(error=>{if(alive)setError(messageOf(error));});};
    const disconnected=(reason:string)=>{setConnected(false);if(reason==='io server disconnect')reconnectTimer=window.setTimeout(()=>{if(alive)socket.connect();},1500);}; const updated=(next:GameView)=>{if(alive)receive(next);};
    const connectionError=()=>setConnected(false);
    socket.on('connect',subscribe);socket.on('disconnect',disconnected);socket.on('connect_error',connectionError);socket.on('game:update',updated);
    if(socket.connected)subscribe();
    const timer=window.setInterval(()=>{if(socket.connected)void sync();},8000);
    return()=>{alive=false;window.clearInterval(timer);if(reconnectTimer!==undefined)window.clearTimeout(reconnectTimer);socket.off('connect',subscribe);socket.off('disconnect',disconnected);socket.off('connect_error',connectionError);socket.off('game:update',updated);resetSocket();};
  },[clearView,gameId,handleReply,receive,sync,user?.id]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(performance.now()),200);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{if(!autoReplay||!view)return;const timer=window.setInterval(()=>setReplayIndex(index=>{if(index>=view.game.moves.length){setAutoReplay(false);return index;}return index+1;}),1400);return()=>window.clearInterval(timer);},[autoReplay,view?.game.moves.length]);
  const game=view?.game; const you=view?.you;
  const serverNow=now+offset;
  const clockExpired=!!game&&game.status==='active'&&game.turnDeadlineAt!==null&&serverNow>=game.turnDeadlineAt;
  const canAct=!!game&&!!you&&game.status==='active'&&game.activeSeat===you.seat&&!game.players[you.seat].passed&&(game.startsAt===null||serverNow>=game.startsAt)&&connected&&!pending&&!sending&&!replayMode&&!clockExpired;
  const move=useMemo(()=>game?inferMove(draft,game.board):null,[draft,game?.board]);
  const canSubmit=canAct&&draft.tiles.length>=2&&!!move;
  const putLetter=useCallback((letter:Letter)=>{
    const current=viewRef.current;if(!canAct||!current?.you)return;
    setDraft(previous=>{const result=typeLetter(previous,current.game.board,letter,current.you!.rack,current.game.vowelsRemaining);setError(result.error??'');return result.draft;});
  },[canAct]);
  async function commit(action:GameAction,retry:GameCommand|null=null) {
    const current=viewRef.current;if(!current||sending)return;
    const command=retry??{commandId:crypto.randomUUID(),gameId,expectedRevision:current.game.revision,action};
    setPending(command);keepPending(gameId,command);setSending(true);setError('');setConfirmPass(false);
    try {const reply=await sendCommand(command);handleReply(reply);const nextPending=pendingAfterReply(command,reply);setPending(nextPending);keepPending(gameId,nextPending);if(reply.ok)setDraft(emptyDraft());}
    catch(error){setError(messageOf(error));}
    finally{setSending(false);}
  }
  const commitRef=useRef(commit);commitRef.current=commit;
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(confirmPass||historyOpen||help||leaveOpen||document.querySelector('dialog[open]')||!canAct)return;
      const target=event.target as HTMLElement|null;if(target?.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(event.metaKey||event.ctrlKey||event.altKey)return;
      if(/^[a-z]$/i.test(event.key)){event.preventDefault();putLetter(event.key.toUpperCase() as Letter);}
      else if(event.key==='Backspace'){event.preventDefault();setDraft(eraseLetter);setError('');}
      else if(event.key==='Escape'){event.preventDefault();setDraft(clearDraft);setError('');}
      else if(event.key==='Enter'){event.preventDefault();if(canSubmit&&move)void commitRef.current(move);else setError('Place at least two new tiles before submitting.');}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[canAct,canSubmit,confirmPass,help,historyOpen,leaveOpen,move,putLetter]);
  // Reuse the saved command ID after a lost acknowledgement or uncertain recovery reply.
  const retryId=useRef<string|null>(null);
  useEffect(()=>{if(connected&&pending&&!sending&&view&&retryId.current!==pending.commandId){retryId.current=pending.commandId;void commitRef.current(pending.action,pending);}},[connected,pending,sending,!!view]);
  if(loading&&!view)return <main className="game-loading"><Spinner label="Setting the table…"/>{error&&<ErrorNotice message={error}/>}</main>;
  if(!game||!view)return <main className="page game-loading"><h1>This board is unavailable.</h1>{error&&<ErrorNotice message={error}/>}<Link className="button primary" to="/">Back to lobby</Link></main>;
  const mySeat=you?.seat??0; const firstSeat:Seat=you? (you.seat===0?1:0):0;const secondSeat:Seat=you?you.seat:1;
  const displayBoard=replayMode?replayBoard(game,replayIndex):game.board;const displayScores=replayMode?replayScores(game,replayIndex):[game.players[0].score,game.players[1].score];
  const lastMove=replayMode?game.moves[replayIndex-1]:game.moves.at(-1);
  const newlyPlaced=new Set(lastMove?.tiles.map(tileIndex)??[]);
  const opponent=you?game.players[you.seat===0?1:0]:null;
  const clockValue=(seat:Seat)=>game.status==='active'&&seat===game.activeSeat&&game.turnDeadlineAt!==null?Math.min(game.clocksMs[seat],Math.max(0,game.turnDeadlineAt-serverNow)):game.clocksMs[seat];
  const initialCountdown=game.startsAt!==null&&serverNow<game.startsAt?Math.ceil((game.startsAt-serverNow)/1000):0;
  const status=replayMode?`Replay · move ${replayIndex} of ${game.moves.length}`:game.status==='finished'?resultText(game):game.status==='paused'?'Game paused · protecting your progress':initialCountdown?`Ready in ${initialCountdown}…`:game.status==='waiting'?'Waiting for both players to connect':clockExpired?'Confirming result…':you?(you.seat===game.activeSeat?'Your move':game.players[you.seat].passed?'You have passed · your score is fixed':`${game.players[game.activeSeat].username} is thinking`):`${game.players[game.activeSeat].username} to play`;
  const disconnectedSeat=game.players.findIndex((player,index)=>!player.connected&&!player.passed&&game.disconnectDeadlines[index]!==null);
  const disconnectDeadline=disconnectedSeat>=0?game.disconnectDeadlines[disconnectedSeat]:null;
  const subtitle=replayMode?(game.result?`Final result: ${resultText(game)}`:'The live game continues while you explore.'):game.status==='paused'?game.pause?.recoveryDeadlineAt?`Reconnect window: ${timeText(game.pause.recoveryDeadlineAt-serverNow)}`:'The clocks are frozen. We will reconnect automatically.':!connected?'Reconnecting. Your active clock may still be running.':disconnectDeadline?`${game.players[disconnectedSeat as Seat].username} disconnected · ${timeText(disconnectDeadline-serverNow)} to return`:you&&canAct?`${you.drawnThisTurn} consonant${you.drawnThisTurn===1?'':'s'} drawn · +30 seconds per turn`:you&&game.players[you.seat].passed?'You can leave or start a new game.':`${game.minutes} minutes + 30 seconds · ${game.spectatorCount} watching`;
  async function copyLink(){try{await navigator.clipboard.writeText(`${window.location.origin}/game/${gameId}`);setCopyStatus('Link copied');}catch{setCopyStatus('Copy the link from your address bar.');}window.setTimeout(()=>setCopyStatus(''),3000);}
  const requestLeave=(event:React.MouseEvent<HTMLAnchorElement>)=>{if(you&&!game.players[you.seat].passed&&game.status!=='finished'){event.preventDefault();setLeaveOpen(true);}};
  return <main className="game-shell">
    <div className="game-toolbar"><Link to="/" onClick={requestLeave} className="back-link">← <span>Lobby</span></Link><span className="game-format"><Icon name="clock" size={14}/>{game.minutes} + 30<span className="game-dot">·</span>{replayMode?'Replay':you?'Your table':'Spectating'}</span><div className="toolbar-actions"><button className="icon-button" aria-label="Copy spectator link" onClick={()=>void copyLink()} title={copyStatus||'Share this game'}><Icon name="link" size={17}/></button><button className="icon-button" aria-label="Move history" onClick={()=>setHistoryOpen(true)}><Icon name="history" size={17}/></button><button className="icon-button" aria-label="Game rules" onClick={()=>setHelp(true)}><Icon name="help" size={17}/></button></div></div>
    <div className="play-layout">
      <section className="arena" aria-label="Game board and players"><div className="players-strip">{([firstSeat,secondSeat] as const).map(seat=><div key={seat} className={`player-card ${game.activeSeat===seat&&game.status==='active'?'active':''} ${you?.seat===seat?'you':''}`}><span className="avatar">{game.players[seat].username[0]?.toUpperCase()}</span><div className="player-info"><strong>{game.players[seat].username}{you?.seat===seat&&<small> you</small>}</strong><span>{replayMode?'Score at this position':game.players[seat].passed?'Passed forever':!game.players[seat].connected?'Disconnected':`${game.players[seat].rackSize} on rack`}</span></div><div className="player-numbers"><strong aria-label={`${game.players[seat].username} score ${displayScores[seat]}`}>{displayScores[seat]}</strong><time className={clockValue(seat)<30000&&!game.players[seat].passed?'urgent':''}>{replayMode?'—':timeText(clockValue(seat))}</time></div></div>)}</div>
      <div className="board-container" ref={boardRef}><BoardGrid board={displayBoard} draft={replayMode?emptyDraft():draft} highlights={newlyPlaced} canAct={canAct} onSelect={index=>{if(!canAct)return;setDraft(previous=>clickSquare(previous,game.board,index));setError('');}}/></div>
      <div className="board-footnote"><span>{lastMove?.word?<><strong>{lastMove.word}</strong> +{lastMove.score}</>:replayMode?'The opening position':'Two words. Endless possibilities.'}</span><span>{replayMode ? `${replayIndex} / ${game.moves.length} moves` : `${game.consonantsRemaining} consonants in bag`}</span></div></section>
      <section className="control-panel" aria-label="Game controls"><div className={`turn-card ${canAct?'your-turn':''}`}><div className="turn-heading"><span className={`turn-dot ${game.status==='paused'||!connected?'offline':''}`}/><h1>{status}</h1></div><p>{subtitle}</p></div>
      {replayMode ? <div className="replay-controls"><span className="eyebrow">EVERY MOVE TELLS A STORY</span><h2>{replayIndex===0?'The opening board':lastMove?.word??(lastMove?.action==='PASS'?'Pass forever':'No words')}</h2><p>{replayIndex===0?'Two random words set the scene.':lastMove?`${game.players[lastMove.seat].username} · ${lastMove.notation??'Turn completed'} · +${lastMove.score} points`:''}</p><input aria-label="Replay move" type="range" min={0} max={game.moves.length} value={replayIndex} onChange={event=>{setAutoReplay(false);setReplayIndex(Number(event.target.value));}}/><div className="replay-buttons"><button className="button secondary" aria-label="First position" onClick={()=>{setReplayIndex(0);setAutoReplay(false);}}>⏮</button><button className="button secondary" aria-label="Previous move" disabled={replayIndex===0} onClick={()=>{setReplayIndex(index=>Math.max(0,index-1));setAutoReplay(false);}}>←</button><button className="button primary" onClick={()=>{if(replayIndex===game.moves.length)setReplayIndex(0);setAutoReplay(!autoReplay);}}>{autoReplay?'Pause':'Play'}</button><button className="button secondary" aria-label="Next move" disabled={replayIndex===game.moves.length} onClick={()=>{setReplayIndex(index=>Math.min(game.moves.length,index+1));setAutoReplay(false);}}>→</button><button className="button secondary" aria-label="Last position" onClick={()=>{setReplayIndex(game.moves.length);setAutoReplay(false);}}>⏭</button></div><span className="replay-count">{replayIndex} / {game.moves.length} moves</span><button className="text-button" onClick={()=>{setReplayMode(false);setAutoReplay(false);}}>{game.status==='finished'?'Back to result':'Back to live game'}</button></div> : game.status==='finished' ? <div className="result-card"><span className="result-flower" aria-hidden="true">✦</span><span className="eyebrow">A GAME WELL PLAYED</span><h2>{resultText(game)}</h2><p>{game.result?.reason==='clock'?'Decided on time.':game.result?.reason==='disconnect'?'Decided after a player disconnected.':game.result?.reason==='both-passed'?'Both players have passed. Every point counted.': 'This game ended without a scored result.'}</p><button className="button primary full" onClick={()=>{setReplayMode(true);setReplayIndex(0);}}>Explore the replay <Icon name="history"/></button><Link className="button secondary full" to="/">Find another game <Icon name="arrow"/></Link></div> : <>
      <div className="rack-area"><div className="control-label"><span>{you?'YOUR CONSONANTS':'THE PLAYERS’ RACKS'}</span><span>{you?`${you.rack.length} / 10`:'Private'}</span></div>{you ? <div className="rack" aria-label="Your consonant rack">{Array.from({length:10},(_,index)=>{const letter=you.rack[index];const countBefore=letter?you.rack.slice(0,index).filter(item=>item===letter).length:0;const used=letter?countBefore<reserved(draft,letter):false;return letter?<button key={index} className={`rack-tile ${used?'used':''}`} disabled={!canAct||used} aria-label={`Play ${letter}, ${VALUES[letter]} points${used?', reserved in draft':''}`} onClick={()=>putLetter(letter)}>{letter}<small>{VALUES[letter]}</small></button>:<span className="rack-empty" key={index} aria-hidden="true"/>;})}</div> : <div className="spectator-racks"><span>{game.players[0].username}<strong>{game.players[0].rackSize} tiles</strong></span><span>{game.players[1].username}<strong>{game.players[1].rackSize} tiles</strong></span></div>}</div>
      <div className="vowel-area"><div className="control-label"><span>SHARED VOWELS</span><span>Y is a vowel</span></div><div className="vowels">{VOWELS.map(letter=><button key={letter} className="vowel-tile" disabled={!canAct||availableCount(draft,letter,you?.rack??[],game.vowelsRemaining)<=0} aria-label={`Play vowel ${letter}, ${game.vowelsRemaining[letter]-reserved(draft,letter)} remaining`} onClick={()=>putLetter(letter)}><strong>{letter}<small>{VALUES[letter]}</small></strong><span>×{game.vowelsRemaining[letter]-reserved(draft,letter)}</span></button>)}</div></div>
      {you ? <div className="move-actions"><div className="draft-preview" aria-live="polite"><span>{move?formatNotation(move.row,move.column,move.direction,move.word):canAct?'Choose a square, then type or tap tiles.':game.players[mySeat].passed?'Your final score is safe.':'Your rack is ready for your next turn.'}</span>{draft.tiles.length>0&&<button className="text-button" onClick={()=>setDraft(clearDraft)} disabled={!!pending}>Clear</button>}</div><div className="submit-row"><button className="button secondary erase-button" aria-label="Erase last letter" disabled={!canAct||draft.tiles.length===0} onClick={()=>{setDraft(eraseLetter);setError('');}}><Icon name="backspace"/></button><button className="button primary submit-button" disabled={!canSubmit} onClick={()=>{if(move)void commit(move);}}>{sending?'Confirming…':'Play word'}<Icon name="arrow" size={18}/></button></div><div className="alternative-actions"><button className="text-button" disabled={!canAct||!you.canNoWords} title={!you.canNoWords?opponent?.passed?'Your opponent has passed. Play a word or pass forever.':'Available only when you drew a consonant this turn.':'Skip only this turn'} onClick={()=>void commit({type:'NO_WORDS'})}>No words</button><span/><button className="text-button pass-button" disabled={!canAct} onClick={()=>setConfirmPass(true)}>Pass forever</button></div></div> : <div className="spectator-note"><Icon name="watch"/><p>You have a seat with a view.<br/><span>Racks stay private. Great words don’t.</span></p>{!user&&<Link to="/sign-up" className="text-button">Join the game community <Icon name="arrow" size={15}/></Link>}</div>}
      </>}
      <div className="game-message" role="status" aria-live="polite">{error||copyStatus||(pending&&!sending?'Waiting for confirmation. Your draft is saved.':'')}{pending&&!sending&&<button className="text-button" disabled={!connected} onClick={()=>void commit(pending.action,pending)}>Retry safely</button>}</div>
      <div className="recent-moves"><div className="control-label"><span>THE STORY SO FAR</span><button className="text-button" onClick={()=>setHistoryOpen(true)}>All moves <Icon name="chevron" size={12}/></button></div>{game.moves.length===0?<p className="muted">The first move is still yours to imagine.</p>:game.moves.slice(-3).reverse().map(item=><div className="recent-move" key={item.revision}><span>{game.players[item.seat].username}</span><strong>{item.word??(item.action==='PASS'?'PASS':'NO WORDS')}</strong><em>+{item.score}</em></div>)}</div>
      </section></div>
    {confirmPass&&<Modal title="Make this your final score?" onClose={()=>setConfirmPass(false)}><p>Passing is permanent. Your score will stay at <strong>{game.players[mySeat].score}</strong>, and you will receive no more turns. {opponent?.passed?'Your opponent has already passed, so this ends the game.':'Your opponent can continue playing after you leave.'}</p><div className="modal-actions"><button className="button secondary" onClick={()=>setConfirmPass(false)}>Keep playing</button><button className="button primary" onClick={()=>void commit({type:'PASS'})}>Pass forever</button></div></Modal>}
    {leaveOpen&&<Modal title="Leave this game?" onClose={()=>setLeaveOpen(false)}><p>You are still playing. Leaving closes this game connection. After a detected disconnection, you have 25 seconds to return; your active clock keeps running.</p><div className="modal-actions"><button className="button primary" onClick={()=>setLeaveOpen(false)}>Stay in game</button><Link className="button secondary" to="/">Leave for lobby</Link></div></Modal>}
    {historyOpen&&<Modal title="Every move, every point" onClose={()=>setHistoryOpen(false)} className="history-modal"><div className="seed-words"><span className="eyebrow">OPENING WORDS</span><strong>{game.principalHistory.slice(0,2).join(' × ')}</strong></div>{game.moves.length===0?<p className="muted">No moves yet. The board is full of possibility.</p>:<ol className="full-history">{game.moves.map((item,index)=><li key={item.revision}><MoveDetails move={item} game={game} index={index}/>{(game.status==='finished'||!you)&&<button className="text-button" onClick={()=>{setReplayMode(true);setReplayIndex(index+1);setHistoryOpen(false);}}>View on board <Icon name="arrow" size={14}/></button>}</li>)}</ol>}</Modal>}
    {help&&<Rules onClose={()=>setHelp(false)}/>}
  </main>;
}
function BoardGrid({board,draft,highlights,canAct,onSelect}:{board:Board;draft:Draft;highlights:Set<number>;canAct:boolean;onSelect:(index:number)=>void}) {
  const drafted=new Map(draft.tiles.map(tile=>[tileIndex(tile),tile.letter]));
  function moveFocus(event:ReactKeyboardEvent<HTMLButtonElement>,index:number) {
    let target:number|null=null;
    if(event.key==='ArrowRight'&&index%15<14)target=index+1;
    if(event.key==='ArrowLeft'&&index%15>0)target=index-1;
    if(event.key==='ArrowDown'&&index<210)target=index+15;
    if(event.key==='ArrowUp'&&index>=15)target=index-15;
    if(target!==null){event.preventDefault();document.getElementById(`square-${target}`)?.focus();}
  }
  return <div className={`board-frame ${canAct?'interactive':''}`}><div className="column-labels" aria-hidden="true">{'ABCDEFGHIJKLMNO'.split('').map(letter=><span key={letter}>{letter}</span>)}</div><div className="row-labels" aria-hidden="true">{Array.from({length:15},(_,index)=><span key={index}>{index+1}</span>)}</div><div className="board-grid" role="grid" aria-label="BestWord 15 by 15 board" aria-rowcount={15} aria-colcount={15}>{Array.from({length:15},(_,row)=><div role="row" className="board-row" key={row}>{Array.from({length:15},(_,column)=>{const index=row*15+column;const letter=drafted.get(index)??board[index];const isDraft=drafted.has(index);const cursor=canAct&&draft.cursor===index&&!letter;return <div role="gridcell" key={index} aria-rowindex={row+1} aria-colindex={column+1}><button type="button" id={`square-${index}`} className={`square ${letter?'occupied':''} ${isDraft?'draft-tile':''} ${!isDraft&&highlights.has(index)?'last-played':''} ${cursor?'cursor':''} ${index===112?'center':''}`} aria-label={`${coordinate(index)}, ${letter?`${letter}, ${VALUES[letter]} points${isDraft?', draft':''}`:'empty'}${cursor?`, ${draft.direction==='H'?'horizontal':'vertical'} cursor`:''}`} aria-disabled={!canAct} onClick={()=>onSelect(index)} onKeyDown={event=>moveFocus(event,index)} tabIndex={index===112||cursor?0:-1}>{letter?<><span>{letter}</span><small>{VALUES[letter]}</small></>:cursor?<span className="cursor-arrow" aria-hidden="true">{draft.direction==='H'?'⇨':'⇩'}</span>:index===112?<span className="center-mark" aria-hidden="true">✦</span>:null}</button></div>;})}</div>)}</div></div>;
}
function MoveDetails({move,game,index}:{move:PublicMove;game:PublicGame;index:number}) { return <><div className="history-move-heading"><span className="move-number">{index+1}</span><div><strong>{move.word??(move.action==='PASS'?'Pass forever':'No words')}</strong><small>{game.players[move.seat].username} {move.notation?`· ${move.notation}`:''}</small></div><b>+{move.score}</b></div>{move.words.length>0&&<div className="score-breakdown">{move.words.map((word,i)=><div key={`${word.word}-${i}`}><span>{word.word}<small>{word.isPrincipal?'principal':'secondary'}{word.spans?` · ${word.spans} span${word.spans===1?'':'s'}`:''}</small></span><span>{word.letterSum} × {word.isPrincipal?word.consonants+word.spans:word.spans>0?2:1} = <strong>{word.score}</strong></span></div>)}</div>}</>; }

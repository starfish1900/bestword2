import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { GamePage, GameSummary, Seek, SeekPage, TimeControl } from '@bestword/contracts';
import { api, getSocket, messageOf, resetSocket } from './api';
import { ErrorNotice, Icon, Rules, Spinner } from './components';
import { useApp } from './store';

type Tab = 'play' | 'watch' | 'history';
const durationLabel = (minutes:number) => minutes === 5 ? 'Quick thinking' : minutes === 15 ? 'Room to explore' : 'Take your time';
export function Lobby() {
  const user = useApp(state => state.user); const activeGameId=useApp(state=>state.activeGameId); const navigate = useNavigate();
  const [tab,setTab] = useState<Tab>('play'); const [minutes,setMinutes] = useState<TimeControl>(15); const [filter,setFilter] = useState<number>(0);
  const [seeks,setSeeks] = useState<Seek[]>([]); const [live,setLive] = useState<GameSummary[]>([]); const [history,setHistory] = useState<GameSummary[]>([]);
  const [seekCursor,setSeekCursor] = useState<string|null>(null); const [liveCursor,setLiveCursor] = useState<string|null>(null); const [historyCursor,setHistoryCursor] = useState<string|null>(null);
  const [loading,setLoading] = useState(true); const [busy,setBusy] = useState<string|null>(null); const [error,setError] = useState(''); const [help,setHelp] = useState(false);
  const [connected,setConnected] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const results = await Promise.all([api<SeekPage>('/seeks'), api<GamePage>('/games/live'), api<GamePage>('/games/history')]);
      setSeeks(results[0].items); setSeekCursor(results[0].nextCursor); setLive(results[1].items); setLiveCursor(results[1].nextCursor); setHistory(results[2].items); setHistoryCursor(results[2].nextCursor); setError('');
    } catch(error) { setError(messageOf(error)); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(); const socket = getSocket(); let alive=true; let reconnectTimer:number|undefined;
    const subscribe = () => { setConnected(true); socket.emit('lobby:subscribe', () => { void refresh(); }); };
    const disconnected = (reason:string) => {setConnected(false);if(reason==='io server disconnect')reconnectTimer=window.setTimeout(()=>{if(alive)socket.connect();},1500);}; const changed = () => { void refresh(); }; const connectionError=()=>setConnected(false);
    socket.on('connect',subscribe); socket.on('disconnect',disconnected); socket.on('connect_error',connectionError); socket.on('lobby:changed',changed);
    if (socket.connected) subscribe();
    const timer = window.setInterval(() => { void refresh(); },15000);
    return () => { alive=false;window.clearInterval(timer);if(reconnectTimer!==undefined)window.clearTimeout(reconnectTimer);socket.off('connect',subscribe); socket.off('disconnect',disconnected); socket.off('connect_error',connectionError); socket.off('lobby:changed',changed); resetSocket(); };
  },[refresh,user?.id]);
  async function createSeek() {
    if (!user) { navigate('/sign-up'); return; }
    setBusy('create'); setError('');
    try { await api<{seek:Seek}>('/seeks',{minutes}); await refresh(); setTab('play'); } catch(error) { setError(messageOf(error)); } finally { setBusy(null); }
  }
  async function join(seek:Seek) {
    if (!user) { navigate('/sign-in'); return; }
    setBusy(seek.id); setError('');
    try {
      if (seek.host.id === user.id) { await api(`/seeks/${seek.id}`,undefined,'DELETE'); await refresh(); }
      else { const result = await api<{gameId:string}>(`/seeks/${seek.id}/join`,{}); navigate(`/game/${result.gameId}`); }
    } catch(error) { setError(messageOf(error)); void refresh(); } finally { setBusy(null); }
  }
  async function loadMore() {
    const cursor = tab === 'play' ? seekCursor : tab === 'watch' ? liveCursor : historyCursor; if (!cursor) return;
    setBusy('more');
    try {
      if (tab === 'play') { const page=await api<SeekPage>(`/seeks?cursor=${encodeURIComponent(cursor)}`); setSeeks(items => [...items,...page.items.filter(item => !items.some(old => old.id === item.id))]); setSeekCursor(page.nextCursor); }
      else { const page=await api<GamePage>(`/games/${tab === 'watch' ? 'live' : 'history'}?cursor=${encodeURIComponent(cursor)}`); if (tab === 'watch') { setLive(items => [...items,...page.items.filter(item => !items.some(old => old.id === item.id))]); setLiveCursor(page.nextCursor); } else { setHistory(items => [...items,...page.items.filter(item => !items.some(old => old.id === item.id))]); setHistoryCursor(page.nextCursor); } }
    } catch(error) { setError(messageOf(error)); } finally { setBusy(null); }
  }
  const openSeeks=seeks.filter(seek => !filter || seek.minutes === filter); const mySeek=seeks.find(seek => seek.host.id === user?.id);
  const myLive=live.filter(game => game.players.some(player => player.id === user?.id));
  const more=tab === 'play' ? seekCursor : tab === 'watch' ? liveCursor : historyCursor;
  return <main className="lobby-page">
    {activeGameId&&!myLive.some(item=>item.id===activeGameId)&&<div className="resume-games lobby-resume"><Link to={`/game/${activeGameId}`}><span>Your game is waiting for you.</span><span>Continue game <Icon name="arrow" size={15}/></span></Link></div>}
    <section className="lobby-hero"><div className="hero-copy"><span className="eyebrow"><span className="gold-line"/> EVERY LETTER OPENS A POSSIBILITY</span><h1>Find your<br/><em>best word.</em></h1><p>A meeting of words and wits.<br className="desktop-only"/> Build connections. Discover bridges. Make your move.</p><button className="text-button hero-how" onClick={() => setHelp(true)}>New to BestWord? Learn to play <Icon name="arrow" size={16}/></button></div><div className="hero-board" aria-hidden="true"><div className="hero-board-grid">{Array.from({length:63},(_,i) => { const words:Record<number,string>={10:'W',19:'O',28:'R',27:'B',29:'I',30:'D',31:'G',32:'E',33:'S',37:'D'}; const letter=words[i]; return <span key={i} className={letter ? `hero-tile ${i === 30 || i === 31 ? 'gold' : ''}` : 'hero-empty'}>{letter}{letter && <small>{letter === 'B' ? 8 : letter === 'W' ? 7 : letter === 'G' ? 6 : letter === 'R' ? 3 : letter === 'D' ? 4 : 1}</small>}</span>; })}</div><div className="hero-caption"><span className="tiny-cross">✦</span> WORDS CONNECT US.</div></div></section>
    <section className="lobby-body"><aside className="create-card"><span className="eyebrow">YOUR TABLE, YOUR PACE</span><h2>Start something good.</h2><p className="muted">Choose your time. Leave a seat open.</p><div className="time-options" role="group" aria-label="Time control">{([5,15,25] as const).map(value => <button key={value} className={minutes===value ? 'time-option selected' : 'time-option'} aria-pressed={minutes===value} onClick={() => setMinutes(value)}><span><strong>{value}</strong><small>min</small></span><span>{durationLabel(value)}</span>{minutes===value && <Icon name="check" size={16}/>}</button>)}</div><p className="increment"><Icon name="clock" size={15}/> +30 seconds after every turn</p>{mySeek ? <div className="your-seek"><span className="pulse-dot"/><strong>Your {mySeek.minutes} minute table is open</strong><p>Waiting for a fellow word lover.</p><button className="button secondary full" disabled={busy!==null} onClick={() => void join(mySeek)}>Cancel request</button></div> : <button className="button primary full" disabled={busy!==null} onClick={() => void createSeek()}>{busy==='create' ? 'Opening your table…' : user ? 'Create a game' : 'Join & start playing'}<Icon name="arrow"/></button>}<div className="create-footnote"><span>2 players</span><i/><span>15 × 15 possibilities</span></div></aside>
    <div className="tables-section"><div className="section-heading"><h2>Find your next game</h2><span className="live-indicator"><span className={connected?'pulse-dot':'pulse-dot offline'}/>{connected?'Live lobby':'Reconnecting'}</span></div>{myLive.length>0 && <div className="resume-games">{myLive.map(game => <Link key={game.id} to={`/game/${game.id}`}><span>Your game with <strong>{game.players.find(player => player.id!==user?.id)?.username}</strong></span><span>Return <Icon name="arrow" size={15}/></span></Link>)}</div>}<div className="lobby-tabs" role="tablist" aria-label="Game lists">{([{id:'play',label:'Open tables',count:seeks.length},{id:'watch',label:'Watch live',count:live.length},{id:'history',label:'Recent games',count:history.length}] as const).map(item => <button key={item.id} role="tab" aria-selected={tab===item.id} className={tab===item.id?'selected':''} onClick={() => setTab(item.id)}>{item.label}{item.id!=='history' && <span>{item.count}</span>}</button>)}</div>{error && <ErrorNotice message={error} onRetry={() => void refresh()}/>}{loading ? <Spinner label="Finding your next opponent…"/> : <div className="table-content" role="tabpanel">
      {tab==='play' && <><div className="table-toolbar"><span>Take a seat. Make a connection.</span><select aria-label="Filter time controls" value={filter} onChange={event=>setFilter(Number(event.target.value))}><option value={0}>All times</option><option value={5}>5 + 30</option><option value={15}>15 + 30</option><option value={25}>25 + 30</option></select></div>{openSeeks.length===0 ? <EmptyState kind="play"/> : <div className="seek-list">{openSeeks.map(seek=><div className="seek-row" key={seek.id}><span className="avatar">{seek.host.username[0]?.toUpperCase()}</span><div className="seek-person"><strong>{seek.host.username}</strong><small>{seek.host.id===user?.id?'Your open table':'Ready for a game'}</small></div><span className="time-chip"><Icon name="clock" size={14}/>{seek.minutes} + 30</span><button className={`button small ${seek.host.id===user?.id?'secondary':'join-button'}`} disabled={busy!==null} onClick={() => void join(seek)}>{busy===seek.id?'…':seek.host.id===user?.id?'Cancel':'Join'}{seek.host.id!==user?.id && <Icon name="arrow" size={15}/>}</button></div>)}</div>}</>}
      {tab==='watch' && (live.length===0 ? <EmptyState kind="watch"/> : <div className="game-list">{live.map(game=><GameRow key={game.id} game={game} replay={false}/>)}</div>)}
      {tab==='history' && (history.length===0 ? <EmptyState kind="history"/> : <div className="game-list">{history.map(game=><GameRow key={game.id} game={game} replay/>)}</div>)}
      {more && <button className="button secondary load-more" onClick={()=>void loadMore()} disabled={busy!==null}>{busy==='more'?'Loading…':'Show more'}</button>}
    </div>}</div></section><footer className="lobby-footer"><span>BestWord — a game worth thinking about.</span><button className="text-button" onClick={()=>setHelp(true)}>Rules & how to play</button></footer>{help && <Rules onClose={()=>setHelp(false)}/>}</main>;
}
function EmptyState({kind}:{kind:Tab}) { return <div className="empty-state"><span className="empty-tile">{kind==='play'?'?':kind==='watch'?<Icon name="watch" size={26}/>:<Icon name="history" size={26}/>}</span><h3>{kind==='play'?'The next game could be yours.':kind==='watch'?'Quiet boards, for a moment.':'Every game starts a story.'}</h3><p>{kind==='play'?'Open a table and invite someone to take a seat.':kind==='watch'?'Live games will appear here. Anyone can watch.':'Completed games will appear here to explore, move by move.'}</p></div>; }
function GameRow({game,replay}:{game:GameSummary;replay:boolean}) { return <Link className="game-row" to={`/game/${game.id}${replay?'?replay=1':''}`}><span className="game-row-icon"><Icon name={replay?'history':'watch'}/></span><div className="game-row-players"><strong>{game.players[0].username}<span>vs</span>{game.players[1].username}</strong><small>{replay ? game.result?.winner===null ? 'Draw / no winner' : `${game.players[game.result?.winner??0].username} won` : game.status==='paused'?'Recovery in progress':`${game.spectatorCount} watching`} · {game.minutes} + 30</small></div><span className="game-row-score">{game.scores[0]}<i>–</i>{game.scores[1]}</span><Icon name="chevron" size={17}/></Link>; }

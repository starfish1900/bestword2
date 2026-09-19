import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from '@bestword/contracts';
import { api, messageOf, onGameMatched, resetSocket, type SessionReply } from './api';
import { ErrorNotice, Icon, Logo, Modal, Rules, Spinner } from './components';
import { useApp } from './store';
import { Lobby } from './Lobby';
import { Game } from './Game';
import { authHref, safeReturnTo } from './authNavigation';

export function App() {
  const { user, sessionReady, setUser, setActiveGameId } = useApp();
  const [help, setHelp] = useState(false); const [account, setAccount] = useState(false); const [error, setError] = useState('');
  const location = useLocation(); const navigate = useNavigate();
  const isGame = location.pathname.startsWith('/game/');
  const loadSession = () => { setError(''); void api<SessionReply>('/session').then(result => { setUser(result.user); setActiveGameId(result.activeGameId??null); }).catch(error => setError(messageOf(error))); };
  useEffect(loadSession, [setUser]);
  useEffect(()=>onGameMatched(gameId=>{setActiveGameId(gameId);navigate(`/game/${gameId}`);}),[navigate,setActiveGameId]);
  async function logout() { try { await api('/auth/logout', {}); resetSocket(); setUser(null); setActiveGameId(null); setAccount(false); navigate('/'); } catch (error) { setError(messageOf(error)); } }
  return <div className={isGame ? 'app is-game' : 'app'}>
    <header className="site-header"><Logo compact={isGame} /><nav aria-label="Main navigation"><Link className="nav-link" to="/">Play<span className="desktop-only"> & watch</span></Link><button className="icon-button help-button" aria-label="How to play" onClick={() => setHelp(true)}><Icon name="help" /></button>{user ? <button className="account-button" onClick={() => setAccount(true)}><span className="avatar small">{user.username[0]?.toUpperCase()}</span><span className="desktop-only">{user.username}</span></button> : <Link className="button small secondary" to={authHref('sign-in',location.pathname+location.search)}>Sign in</Link>}</nav></header>
    {!sessionReady ? <main className="page"><Spinner label="Connecting to BestWord…" />{error && <ErrorNotice message={error} onRetry={loadSession} />}</main> : <Routes><Route path="/" element={<Lobby />} /><Route path="/sign-in" element={<Auth register={false} />} /><Route path="/sign-up" element={<Auth register />} /><Route path="/game/:gameId" element={<Game />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>}
    {help && <Rules onClose={() => setHelp(false)} />}
    {account && user && <Account user={user} onClose={() => setAccount(false)} onLogout={() => void logout()} />}
    {sessionReady && error && <div className="global-error"><ErrorNotice message={error} onRetry={() => setError('')} /></div>}
  </div>;
}
function Auth({ register }: { register: boolean }) {
  const { user, setUser, setActiveGameId } = useApp(); const navigate = useNavigate(); const [params]=useSearchParams(); const returnTo=safeReturnTo(params.get('returnTo'));
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setError(''); }, [register]);
  if (user) return <Navigate to={returnTo??'/'} replace />;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<SessionReply>(register ? '/auth/register' : '/auth/login', {username,password}); resetSocket(); setUser(result.user); setActiveGameId(result.activeGameId??null); navigate(returnTo??(result.activeGameId?`/game/${result.activeGameId}`:'/'),{replace:true}); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-art" aria-hidden="true"><span className="eyebrow">THE WORD IS YOURS</span><h1>A little wit.<br />A lot of possibility.</h1><div className="word-art"><span>B<small>8</small></span><span>E<small>1</small></span><span>S<small>2</small></span><span>T<small>4</small></span></div><p>A fresh crossword. A worthy opponent.<br />Your next great word is waiting.</p></section><section className="auth-card"><Link to="/" className="back-link">← Back to the lobby</Link><div className="auth-tabs"><Link className={!register ? 'selected' : ''} to={authHref('sign-in',returnTo??'/')}>Sign in</Link><Link className={register ? 'selected' : ''} to={authHref('sign-up',returnTo??'/')}>Create account</Link></div><span className="eyebrow">{register ? 'TAKE YOUR PLACE' : 'WELCOME BACK'}</span><h1>{register ? 'Let’s make a name for you.' : 'Your next move awaits.'}</h1><p className="muted">{register ? 'Join a thoughtful game of words. It’s free to play.' : 'Sign in to play, or explore the lobby as a guest.'}</p><form onSubmit={event => void submit(event)}><label>Username<input aria-label="Username" aria-describedby={register ? "username-hint" : undefined} name="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus required minLength={register ? 3 : 1} maxLength={15} pattern={register ? '[A-Za-z0-9]{3,15}' : undefined} spellCheck={false} autoCapitalize="none" />{register && <small id="username-hint">3–15 letters or numbers, without spaces.</small>}</label><label>Password<input aria-label="Password" aria-describedby={register ? "password-hint" : undefined} name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : 1} maxLength={128} />{register && <small id="password-hint">12–128 characters. Choose a strong password.</small>}</label>{error && <ErrorNotice message={error} />}<button className="button primary full" disabled={busy}>{busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}<Icon name="arrow" /></button></form><p className="auth-note">{register ? 'There is no password recovery. Save your password in your password manager before you play.' : 'BestWord has no email or password recovery. Your username is all other players see.'}</p></section></main>;
}
function Account({user,onClose,onLogout}:{user:User;onClose:()=>void;onLogout:()=>void}) {
  const [currentPassword,setCurrentPassword] = useState(''); const [newPassword,setNewPassword] = useState(''); const [message,setMessage] = useState(''); const [busy,setBusy] = useState(false);
  return <Modal title={user.username} onClose={onClose}><p className="muted">Your BestWord account</p><form onSubmit={event => { event.preventDefault(); setBusy(true); void api('/auth/password',{currentPassword,newPassword}).then(() => { setMessage('Password changed. Save the new password securely.'); setCurrentPassword(''); setNewPassword(''); }).catch(error => setMessage(messageOf(error))).finally(() => setBusy(false)); }}><h3>Change password</h3><label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={128}/></label><label>New password<input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required minLength={12} maxLength={128}/></label><button className="button secondary full" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>{message && <p role="status" className="muted">{message}</p>}</form><hr/><button className="button danger-quiet full" onClick={onLogout}>Sign out</button></Modal>;
}

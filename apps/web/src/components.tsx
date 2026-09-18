import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Icon({ name, size = 20 }: { name: 'arrow' | 'watch' | 'clock' | 'close' | 'backspace' | 'help' | 'check' | 'link' | 'refresh' | 'history' | 'chevron' | 'sound'; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    arrow:<><path d="M4 12h16M14 6l6 6-6 6" /></>,
    watch:<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,
    backspace:<><path d="M8 5h13v14H8l-6-7 6-7Z"/><path d="m11 9 6 6m0-6-6 6"/></>,
    help:<><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-1.5 1-2 1.5-2 3m0 2v.1"/></>,
    check:<path d="m4 12 5 5L20 6"/>,
    link:<><path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></>,
    refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></>,
    history:<><path d="M3 4v6h6M3 10a9 9 0 1 1 1 8"/><path d="M12 7v5l4 2"/></>,
    chevron:<path d="m9 5 7 7-7 7"/>,
    sound:<><path d="M3 9h4l5-4v14l-5-4H3Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Logo({ compact = false }: { compact?: boolean }) {
  return <Link className={`brand ${compact ? 'brand-compact' : ''}`} to="/" aria-label="BestWord home"><span className="brand-mark" aria-hidden="true">B<span>W</span></span><span>Best<span className="brand-word">Word</span></span></Link>;
}
export function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal ${className}`} ref={ref} aria-labelledby={id} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>{children}
  </dialog>;
}
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><span>{message}</span>{onRetry && <button className="text-button" onClick={onRetry}>Try again</button>}</div>;
}
export function Spinner({ label = 'Loading…' }: { label?: string }) { return <div className="loading-state" role="status"><span className="spinner"/>{label}</div>; }
export function Rules({ onClose }: { onClose: () => void }) {
  return <Modal title="A good word. A better move." onClose={onClose} className="rules-modal"><div className="rules-content">
    <p className="lead">Build a crossword together. Find the most valuable word for yourself.</p>
    <ol className="rule-steps"><li><strong>Draw automatically.</strong> Each turn, receive up to two consonants, with room for ten on your rack. Vowels come from the shared bag; Y is a vowel.</li><li><strong>Make a connected word.</strong> Place at least two new tiles in one line. Every word formed must be in the dictionary and have 3–15 letters. Your principal word must be new to this game.</li><li><strong>Find a bridge.</strong> Empty squares between the first and last old tiles in a word are spans. Extensions outside those pillars do not add spans.</li></ol>
    <div className="formula-card"><span>PRINCIPAL WORD</span><strong>Letter total × (consonants + spans)</strong><span>SECONDARY WORDS</span><strong>Letter total × 2 if bridged; otherwise × 1</strong></div>
    <h3>Three ways to finish a turn</h3><p><strong>Play word</strong> places your tiles. <strong>No words</strong> skips just this turn, but is available only if you drew a consonant and your opponent has not passed. <strong>Pass forever</strong> ends all your future turns and fixes your score. Both passing ends the game.</p>
    <h3>Time matters</h3><p>Only your clock runs on your turn; every completed turn adds 30 seconds. Running out of time loses, regardless of score. After a detected disconnection you have 25 seconds to return; your active clock keeps running. A player who has passed may leave freely.</p>
    <h3>Entering a word</h3><p>Click an empty square to select the start. Each click alternates horizontal ⇨ and vertical ⇩ and clears your draft. Type letters or tap rack and vowel tiles. Existing tiles are skipped automatically. Backspace erases your last letter; Enter submits. Your word includes any contiguous existing prefix or suffix.</p>
    <h3>Letter values</h3><p className="values-list">A E I O · 1 &nbsp; U Y S · 2 &nbsp; N R · 3 &nbsp; T D · 4 &nbsp; M L · 5 &nbsp; C G H · 6 &nbsp; K W · 7 &nbsp; P B · 8 &nbsp; F V · 9 &nbsp; X Z · 10 &nbsp; J Q · 11</p>
    <button className="button primary full" onClick={onClose}>Back to BestWord <Icon name="arrow" /></button>
  </div></Modal>;
}

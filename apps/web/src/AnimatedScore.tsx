import { useLayoutEffect, useRef, useState } from 'react';
import { createScoreCounter } from './scoreCounter';

interface Props {
  score: number;
  username: string;
  mode: 'live' | 'replay';
  position: number;
  resetKey: string;
  connected: boolean;
}

export function AnimatedScore({ score, username, mode, position, resetKey, connected }: Props) {
  const [shown, setShown] = useState(score);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [counter] = useState(() => createScoreCounter(score, setShown, {
    now: () => performance.now(),
    request: callback => requestAnimationFrame(callback),
    cancel: id => cancelAnimationFrame(id),
  }));
  const previous = useRef({ score, mode, position, resetKey, connected });
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    media.addEventListener('change', changed);
    return () => { media.removeEventListener('change', changed); counter.cancel(); };
  }, [counter]);
  useLayoutEffect(() => {
    const old = previous.current;
    const animate = !reduced && connected && old.connected && old.resetKey === resetKey
      && old.mode === mode && score > old.score
      && (mode === 'live' || position === old.position + 1);
    // A duplicate score update leaves any current animation running.
    if (score !== old.score || mode !== old.mode || resetKey !== old.resetKey
      || connected !== old.connected || reduced || (mode === 'replay' && position !== old.position)) {
      counter.update(score, animate);
    }
    previous.current = { score, mode, position, resetKey, connected };
  }, [score, mode, position, resetKey, connected, reduced, counter]);
  return <strong className="animated-score" data-player={username} data-score={score}><span className="score-value" aria-hidden="true">{shown}</span><span className="visually-hidden">{username} score {score}</span></strong>;
}

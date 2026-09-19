import { useEffect, useRef, useState } from 'react';
import { TUTORIAL_CHAPTERS, TUTORIAL_POSTER, TUTORIAL_VIDEO } from './tutorial';

export function TutorialVideo() {
  const ref = useRef<HTMLVideoElement>(null), requested = useRef(false), seekTo = useRef(0);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const video = ref.current;
    return () => { if(video){video.pause();video.removeAttribute('src');video.load();} };
  }, []);
  function play(seconds = 0) {
    const video = ref.current; if (!video) return;
    seekTo.current = seconds; setError('');
    if (!requested.current) { requested.current = true; setLoaded(true); video.src = TUTORIAL_VIDEO; video.load(); }
    if (video.readyState >= 1) video.currentTime = seconds;
    void video.play().catch(() => setError('Use the video’s play button to begin.'));
  }
  return <div className="tutorial-panel">
    <p>Learn the complete rules and bridge scoring in 7 minutes 34 seconds. English captions are included.</p>
    <div className="tutorial-player"><video ref={ref} controls={loaded} preload="none" poster={TUTORIAL_POSTER} playsInline aria-label="BestWord narrated tutorial" onLoadedMetadata={() => { if(ref.current)ref.current.currentTime=seekTo.current; }} onError={() => setError('The video could not load. Please try again.')} />{!loaded&&<button className="button primary tutorial-start" onClick={() => play()}>Play video tutorial</button>}</div>
    {error&&<p role="status">{error}</p>}
    <nav className="tutorial-chapters" aria-label="Tutorial chapters">{TUTORIAL_CHAPTERS.map(chapter=><button className="text-button" key={chapter.seconds} onClick={()=>play(chapter.seconds)}><span>{chapter.label}</span>{chapter.title}</button>)}</nav>
    <p className="tutorial-note">The original video is shown unchanged. Current rules also require every formed word to contain a vowel and a consonant. See the Rules tab for computer opponents and signed-in replay access.</p>
  </div>;
}

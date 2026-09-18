# BestWord tutorial frame renderer

An offline, deterministic React 19 / TypeScript / SVG composition at exactly **1920 × 1080**. It uses the repository's existing React and Vite dependencies. It does not change the production application or require a cloud service.

From the BestWord repository root:

```sh
npx vite --config tools/tutorial/visual/vite.config.ts
```

Open `http://127.0.0.1:4179`. Set `BESTWORD_TUTORIAL_PORT` to select a different port. A capture browser should use a 1920 × 1080 viewport and device scale factor 1.

Wait for `window.tutorialReady`, then call:

```ts
await window.renderFrame({
  scene,       // one entry from ../content/scenes.json
  example,     // optional matching entry from ../content/examples.json
  t: 5,        // local scene time in seconds, never ambient wall time
  duration: 15,
  progress: .3,// optional total-film progress, from 0 to 1
  asset: {     // optional real application capture
    url: '/@fs/C:/absolute/path/capture.webm',
    type: 'video',
    duration: 12,
    width: 1280,
    height: 800,
  },
});
```

The promise resolves after React, fonts, image decoding, video seeking and two paint frames. Each video remains paused, seeks to the requested scene time and holds its last frame without looping. Capture the viewport after the promise resolves. Images use `type: 'image'`.

Scene layouts are selected by `scene.kind`. `t / duration` drives every diagram reveal; there are no CSS animations or random values. Scoring diagrams consume the production engine's example output. Tile values and quantities are imported directly from the engine. The MASTERPIECE demonstration imports the real client's draft functions for click, typing, cursor skipping and word inference.

The area from **y = 940 to 1060** is intentionally left free for captions composited during encoding. The renderer does not burn in narration or subtitles.

`types.ts` describes the complete API. `renderFrame` returns the scene ID, requested scene time and actual sought media time. Missing or failed media rejects the promise instead of silently encoding an empty video.

Optional scene.visualCues timestamps independently control tile placement, pillars, spans, word focus, calculation reveals and total score. Optional scene.inputCues timestamps control the MASTERPIECE click, E, R and submit sequence. Both use scene-relative seconds; the root pipeline derives them from narration word timestamps.

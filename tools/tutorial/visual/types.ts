import type { Board, PlaceWordAction, PlacedTile, ScoredWord } from '@bestword/contracts';

export interface Scene {
  id: string;
  chapter: string;
  title: string;
  kind: 'title' | 'app' | 'rules' | 'letters' | 'draw' | 'input' | 'score' | 'actions' | 'clocks' | 'recap';
  narration: string;
  bullets: string[];
  asset?: string;
  example?: string;
  minDuration?: number;
  visualCues?: { placedAt: number; pillarsAt: number; spansAt: number; calculationsAt: number[]; focusAt: number[]; totalAt: number };
  inputCues?: { clickAt: number; typeEAt: number; typeRAt: number; submitAt: number };
}
export interface ExampleWord extends ScoredWord { indices: number[]; pillars: number[]; spanIndices: number[] }
export interface Example {
  id: string; title: string; beforeBoard: Board; action: PlaceWordAction; afterBoard: Board;
  newTiles: PlacedTile[]; words: ExampleWord[]; score: number; expectedScore: number; notation: string;
}
export interface Asset { url: string; type: 'video' | 'image'; duration?: number; width?: number; height?: number }
export interface FrameInput { scene: Scene; example?: Example; t: number; duration: number; progress?: number; asset?: Asset }
declare global { interface Window { renderFrame: (input: FrameInput) => Promise<{scene: string; t: number; mediaTime: number | null}>; tutorialReady: boolean } }

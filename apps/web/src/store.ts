import { create } from 'zustand';
import type { GameView, User } from '@bestword/contracts';
interface AppState {
  user: User | null; sessionReady: boolean; view: GameView | null; activeGameId:string|null;
  setUser: (user: User | null) => void; setView: (view: GameView) => void; clearView: () => void;
  setActiveGameId:(gameId:string|null)=>void;
}
export const useApp = create<AppState>(set => ({
  user:null, sessionReady:false, view:null, activeGameId:null,
  setActiveGameId:activeGameId=>set({activeGameId}),
  setUser: user => set({user, sessionReady:true}),
  setView: view => set(state => {
    if (state.view?.game.id === view.game.id && state.view.game.revision > view.game.revision) return state;
    return {view};
  }),
  clearView: () => set({view:null}),
}));

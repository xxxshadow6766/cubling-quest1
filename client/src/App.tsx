import { useEffect, useRef } from 'react';
import { unlockAudio } from './audio';
import { Game } from './game/Game';
import { lastInit } from './net';
import { useStore } from './store';
import { HatchOverlay } from './ui/panels/Egg';
import { Home } from './ui/Home';
import { HUD } from './ui/HUD';
import { Panels } from './ui/Panels';

export function App() {
  const screen = useStore((s) => s.screen);
  const loadingText = useStore((s) => s.loadingText);
  if (screen === 'home') return <Home />;
  if (screen === 'loading') {
    return (
      <div className="loading">
        <div className="spinner" />
        {loadingText || 'Loading…'}
      </div>
    );
  }
  return <GameView />;
}

function GameView() {
  const container = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const game = new Game(container.current!, overlay.current!);
    if (lastInit) game.init(lastInit);
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      game.dispose();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  return (
    <div className="game-root">
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      <div ref={overlay} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <HUD />
      <Panels />
      <HatchOverlay />
    </div>
  );
}

import './ui/style.css';
import { Game } from './core/game';

const host = document.getElementById('app');
if (!host) throw new Error('Missing application root');

declare global {
  interface Window { __WAYFARER__?: Game }
}

async function bootstrap(): Promise<void> {
  try {
    const game = await Game.create(host!);
    window.__WAYFARER__ = game;
    await game.start();
  } catch (error) {
    console.error('[Wayfarer bootstrap]', error);
    const message = error instanceof Error ? error.message : String(error);
    host!.innerHTML = `<div class="fatal"><span class="eyebrow">A SMALL DETOUR</span><h1>Your world needs a modern browser.</h1><p id="bootstrap-error"></p><button class="primary" id="bootstrap-retry">Try again</button><button class="text-button" id="bootstrap-compat">Try WebGL2 compatibility mode</button></div>`;
    document.getElementById('bootstrap-error')!.textContent = message;
    document.getElementById('bootstrap-retry')!.onclick = () => location.reload();
    document.getElementById('bootstrap-compat')!.onclick = () => { const url = new URL(location.href); url.searchParams.set('renderer', 'webgl'); location.href = url.href; };
  }
}
void bootstrap();

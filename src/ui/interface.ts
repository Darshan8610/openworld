import type { BackendName } from '../rendering/renderer';
import type { QualityName } from '../config';
import { BIOMES } from '../world/biomes';
import type { BiomeId } from '../world/biomes';
import type { InteractionPrompt } from '../interaction/types';
import { itemDefinition, isItemId } from '../objects/items';
import type { ItemId } from '../objects/items';

export interface UIActions {
  seed: (seed: string) => void;
  randomSeed: () => void;
  share: () => void;
  hour: (hour: number) => void;
  cycle: (enabled: boolean) => void;
  quality: (quality: QualityName) => void;
  tour: () => void;
  reset: () => void;
  lock: () => void;
  debug: (enabled: boolean) => void;
  wireframe: (enabled: boolean) => void;
  biomeDebug: (enabled: boolean) => void;
  vegetation: (enabled: boolean) => void;
  roads: (enabled: boolean) => void;
  objects: (enabled: boolean) => void;
  route: (id: string) => void;
  wind: (enabled: boolean) => void;
  detail: (enabled: boolean) => void;
  postfx: (enabled: boolean) => void;
  viewpoint: (biome: BiomeId) => void;
  stats: (enabled: boolean) => void;
}
export interface UIStats {
  x: number; y: number; z: number; heading: number; time: string; biome: string;
  fps: number; calls: number; triangles: number; geometries: number; cached: number;
  pending: number; shifts: number; backend: BackendName; touring: boolean; speed: number;
  lod: number[]; progress: number;
  vegetation: number; vegetationBatches: number; vegetationCapacity: number;
  roadsEnabled: boolean; roadTiles: number; props: number; propCapacity: number;
  routeName: string | null; routeStation: number | null;
  objects: number; objectBodies: number; objectSleeping: number;
  inventoryItems: number; interactionTarget: string | null;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id.replace(/^#/, '')) as T;

/** Small accessible development shell. Full menus/photo/mobile UI belong to Phase 8. */
export class Interface {
  private abort = new AbortController();
  private toastTimer = 0;
  private lastUpdate = 0;
  statsVisible = false;
  private promptKey = '';
  constructor(seed: string, hour: number, quality: QualityName, backend: BackendName, actions: UIActions) {
    $('app').insertAdjacentHTML('beforeend', `
      <div class="shade" aria-hidden="true"></div>
      <main class="interface" id="interface">
        <header class="topbar">
          <a class="brand" href="/" aria-label="Wayfarer home"><svg viewBox="0 0 40 34" aria-hidden="true"><path d="M3 7l9 21 8-15 8 15 9-21M14 7l6 12 6-12"/></svg><span>WAYFARER<small>A WORLD WITHOUT EDGES</small></span></a>
          <div class="top-actions"><span class="backend" id="backend"><i></i>${backend}</span><button class="icon-button" id="settings-toggle" aria-label="World settings" aria-expanded="false" aria-controls="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg></button></div>
        </header>
        <div class="compass" aria-label="Compass"><span>W</span><i></i><span>N</span><i></i><span>E</span><b id="heading">033°</b></div>
        <section class="intro" id="intro"><div class="eyebrow"><span></span> THE INFINITE WORLD PROJECT</div><h1>Take the
long way home.</h1><p>No finish line. No edge of the map.
Just you, and what’s over the next ridge.</p><button class="primary" id="explore">Explore the world <span>↗</span></button><div class="phase-note">PHASE 06 <span>·</span> A WORLD YOU CAN TOUCH</div></section>
        <aside class="settings" id="settings" aria-label="World settings" hidden>
          <div class="panel-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>World settings</h2></div><button class="icon-button" id="settings-close" aria-label="Close settings">×</button></div>
          <label class="field-label" for="seed">World seed <span>Same seed. Same world.</span></label>
          <form id="seed-form" class="seed-row"><input id="seed" name="seed" maxlength="64" autocomplete="off" spellcheck="false" required><button type="button" id="random-seed" aria-label="Generate random seed" title="Random seed">↻</button><button type="submit" class="apply">Apply</button></form>
          <div class="field-label"><label for="time">Time of day</label><output id="time-value">${formatHour(hour)}</output></div>
          <input id="time" type="range" min="0" max="23.99" step="0.01" value="${hour}" aria-label="Time of day">
          <div class="range-labels"><span>Midnight</span><span>Noon</span><span>Midnight</span></div>
          <label class="switch-row" for="cycle"><span>Let the day unfold<small>A full day in 12 minutes</small></span><input type="checkbox" id="cycle" checked role="switch"></label>
          <label class="field-label" for="quality">Graphics preset</label><select id="quality"><option value="low">Low · lighter on your device</option><option value="balanced">Balanced · recommended</option><option value="high">High · extended horizons</option><option value="ultra">Ultra · maximum detail + ambient occlusion</option></select>
          <div class="nature-heading"><span class="eyebrow">THE LIVING LANDSCAPE</span><span>05 BIOMES</span></div>
          <label class="field-label" for="biome-view">Biome overlook<span>Seed-local survey jump</span></label>
          <select id="biome-view" aria-label="Travel to biome"><option value="">Choose a climate region…</option>${BIOMES.map((biome, i) => `<option value="${i}">${biome.name}</option>`).join('')}</select>
          <label class="switch-row" for="vegetation"><span>Vegetation <kbd>V</kbd><small>Pine, spruce, aspen, birch, fern, flowers & cliffs</small></span><input type="checkbox" id="vegetation" checked role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">THE OPEN ROAD</span><span>PHASE 03</span></div>
          <label class="field-label" for="route-select">Scenic route<span>Camera survey · not driving physics</span></label>
          <select id="route-select" aria-label="Travel to scenic route"><option value="">Choose a route…</option><option value="cedar">Cedar Pass</option><option value="golden">Golden Ridge</option><option value="snowline">Snowline Run</option></select>
          <label class="switch-row" for="roads"><span>Road network <kbd>G</kbd><small>Asphalt, markings, signs & overlooks</small></span><input type="checkbox" id="roads" checked role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">THINGS TO TOUCH</span><span>PHASE 06</span></div>
          <label class="switch-row" for="objects"><span>World objects <kbd>O</kbd><small>Caches, lamps, gates, valves & pickups</small></span><input type="checkbox" id="objects" checked role="switch"></label>
          <div class="pack" id="pack" aria-live="polite"><span class="eyebrow">PACK <b id="pack-count">EMPTY</b></span><ul id="pack-list"></ul></div>
          <label class="switch-row" for="wind"><span>Wind in the canopy<small>Procedural, height-weighted motion</small></span><input type="checkbox" id="wind" checked role="switch"></label>
          <label class="switch-row" for="detail"><span>Terrain surface detail<small>Triplanar grass, rock & snow</small></span><input type="checkbox" id="detail" checked role="switch"></label>
          <label class="switch-row" for="postfx"><span>Cinematic post<small>Bloom, FXAA & vignette (off on Low)</small></span><input type="checkbox" id="postfx" checked role="switch"></label>
          <label class="switch-row" for="biome-debug"><span>Biome map <kbd>B</kbd><small>Inspect the climate regions</small></span><input type="checkbox" id="biome-debug" role="switch"></label>
          <label class="switch-row" for="lod"><span>Show terrain LOD<small>Color by geometry detail</small></span><input type="checkbox" id="lod" role="switch"></label>
          <label class="switch-row" for="wireframe"><span>Wireframe</span><input type="checkbox" id="wireframe" role="switch"></label>
          <label class="switch-row" for="show-stats"><span>Performance overlay <kbd>F3</kbd></span><input type="checkbox" id="show-stats" role="switch"></label>
          <div class="panel-buttons"><button id="reset">Reset viewpoint</button><button id="share">Copy world link ↗</button></div>
          <p class="panel-note">Phase 6 adds interactive world objects: caches, containers, gates, lamps, valves, benches and pickups with hold-to-confirm context actions and persistent state. The walking character arrives in Phase 5; interaction currently targets from the survey rig.</p>
        </aside>
        <div class="biome-legend" id="biome-legend" hidden><span class="eyebrow">CLIMATE OVERLAY</span>${BIOMES.map((biome) => `<span><i style="background:#${biome.color.toString(16).padStart(6, '0')}"></i>${biome.name}</span>`).join('')}</div>
        <pre class="performance" id="performance" aria-label="Performance statistics" hidden></pre>
        <footer class="bottom-hud"><div class="location"><span class="eyebrow"><i></i> <span id="location-name">VALLEY MEADOWS</span></span><div class="coordinates" id="coordinates">E 0.000 <span>/</span> N 0.000</div><div class="location-meta"><span id="altitude">ALT 420 M</span><span>SEED <b id="seed-label"></b></span></div></div>
          <div class="controls-hint"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> fly</span><span><kbd>Q</kbd><kbd>E</kbd> altitude</span><span><kbd>⇧</kbd> boost</span><span><kbd>E</kbd> interact</span><span>Drag to look</span></div>
          <div class="travel"><button id="tour" aria-pressed="true"><span class="tour-dot"></span><span id="tour-label">Scenic flight</span><span id="tour-state">ON</span></button><div class="clock"><span id="clock">16:24</span><span id="speed">110 M/S CRUISE</span></div></div>
        </footer>
        <div class="reticle" id="reticle" aria-hidden="true">+</div>
        <div class="interaction" id="interaction" role="status" aria-live="polite" hidden>
          <span class="interaction-key" id="interaction-key">E</span>
          <div class="interaction-copy"><span class="interaction-target" id="interaction-target"></span><span class="interaction-action" id="interaction-action"></span></div>
          <i class="interaction-progress" id="interaction-progress"></i>
        </div>
      </main>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
      <div class="loading" id="loading"><div class="loading-brand">WAYFARER</div><div class="loading-line"><span id="loading-progress"></span></div><p id="loading-text">Finding your next horizon…</p><span class="loading-meta">PROCEDURAL TERRAIN · SEEDED & INFINITE</span></div>
      <div class="fatal" id="fatal" hidden><span class="eyebrow">A SMALL DETOUR</span><h1>We couldn’t open this world.</h1><p id="fatal-message"></p><button class="primary" id="retry">Try again</button><button class="text-button" id="compatibility">Try WebGL2 compatibility mode</button></div>
    `);
    $<HTMLInputElement>('#seed').value = seed;
    $<HTMLSelectElement>('#quality').value = quality;
    $('#seed-label').textContent = seed;
    const on = (id: string, event: string, fn: EventListener) => $(id).addEventListener(event, fn, { signal: this.abort.signal });
    const settings = (open: boolean) => { $('#settings').hidden = !open; $('#settings-toggle').setAttribute('aria-expanded', String(open)); document.body.classList.toggle('settings-open', open); };
    on('settings-toggle', 'click', () => settings($('#settings').hasAttribute('hidden')));
    on('settings-close', 'click', () => { settings(false); $<HTMLButtonElement>('#settings-toggle').focus(); });
    on('explore', 'click', () => { this.dismissIntro(); actions.lock(); this.toast('WASD to fly · Q descend to the roadside · E to interact · Shift to boost · Esc to release mouse'); });
    on('seed-form', 'submit', (event) => { event.preventDefault(); actions.seed($<HTMLInputElement>('#seed').value); });
    on('random-seed', 'click', () => actions.randomSeed());
    on('share', 'click', () => actions.share());
    on('time', 'input', () => { const value = Number($<HTMLInputElement>('#time').value); actions.hour(value); $('#time-value').textContent = formatHour(value); });
    on('cycle', 'change', () => actions.cycle($<HTMLInputElement>('#cycle').checked));
    on('quality', 'change', () => actions.quality($<HTMLSelectElement>('#quality').value as QualityName));
    on('tour', 'click', () => actions.tour());
    on('reset', 'click', () => { actions.reset(); this.toast('Back to where the journey began'); });
    on('lod', 'change', () => actions.debug($<HTMLInputElement>('#lod').checked));
    on('wireframe', 'change', () => actions.wireframe($<HTMLInputElement>('#wireframe').checked));
    on('biome-debug', 'change', () => actions.biomeDebug($<HTMLInputElement>('#biome-debug').checked));
    on('postfx', 'change', () => actions.postfx($<HTMLInputElement>('#postfx').checked));
    on('vegetation', 'change', () => actions.vegetation($<HTMLInputElement>('#vegetation').checked));
    on('roads', 'change', () => actions.roads($<HTMLInputElement>('#roads').checked));
    on('objects', 'change', () => actions.objects($<HTMLInputElement>('#objects').checked));
    on('route-select', 'change', () => { const value = $<HTMLSelectElement>('#route-select').value; if (value) { actions.route(value); $<HTMLSelectElement>('#route-select').value = ''; } });
    on('biome-view', 'change', () => { const value = $<HTMLSelectElement>('#biome-view').value; if (value !== '') { actions.viewpoint(Number(value) as BiomeId); $<HTMLSelectElement>('#biome-view').value = ''; } });
    on('wind', 'change', () => actions.wind($<HTMLInputElement>('#wind').checked));
    on('detail', 'change', () => actions.detail($<HTMLInputElement>('#detail').checked));
    on('show-stats', 'change', () => this.showStats($<HTMLInputElement>('#show-stats').checked));
    on('retry', 'click', () => location.reload());
    on('compatibility', 'click', () => { const url = new URL(location.href); url.searchParams.set('renderer', 'webgl'); location.href = url.href; });
    window.addEventListener('keydown', (event) => { if (event.code === 'Escape') settings(false); }, { signal: this.abort.signal });
    document.addEventListener('pointerlockchange', () => { document.body.classList.toggle('pointer-locked', document.pointerLockElement !== null); }, { signal: this.abort.signal });
  }

  syncDebug(lod: boolean, biome: boolean): void {
    $<HTMLInputElement>('#lod').checked = lod;
    $<HTMLInputElement>('#biome-debug').checked = biome;
    $('#biome-legend').hidden = !biome;
  }
  syncPost(enabled: boolean): void { $<HTMLInputElement>('#postfx').checked = enabled; }
  syncObjects(enabled: boolean): void { $<HTMLInputElement>('#objects').checked = enabled; }

  /** Interaction prompt; called at 120 Hz, so it only touches the DOM on change. */
  setPrompt(prompt: InteractionPrompt | null): void {
    const element = $<HTMLDivElement>('#interaction');
    if (!prompt) {
      if (!element.hidden) element.hidden = true;
      this.promptKey = '';
      return;
    }
    const key = `${prompt.objectId}|${prompt.actionLabel}|${prompt.holdSeconds > 0}`;
    if (key !== this.promptKey) {
      this.promptKey = key;
      element.hidden = false;
      $('#interaction-key').textContent = prompt.holdSeconds > 0 ? 'HOLD' : prompt.key;
      $('#interaction-target').textContent = prompt.targetLabel;
      $('#interaction-action').textContent = prompt.actionLabel;
    }
    const progress = $<HTMLElement>('#interaction-progress');
    progress.style.transform = prompt.holdSeconds > 0 ? `scaleX(${prompt.progress.toFixed(3)})` : 'scaleX(0)';
  }

  /** Player pack readout; generic items only, no story content. */
  setPack(stacks: readonly { itemId: string; count: number }[]): void {
    const known = stacks.filter((stack) => isItemId(stack.itemId));
    const total = known.reduce((sum, stack) => sum + stack.count, 0);
    $('#pack-count').textContent = total === 0 ? 'EMPTY' : `${total} ITEM${total === 1 ? '' : 'S'}`;
    $('#pack-list').innerHTML = known
      .map((stack) => `<li><span>${itemDefinition(stack.itemId as ItemId).label}</span><b>${stack.count}</b></li>`)
      .join('');
  }
  syncNature(vegetation: boolean, wind: boolean, roads = true): void {
    $<HTMLInputElement>('#vegetation').checked = vegetation;
    $<HTMLInputElement>('#wind').checked = wind;
    $<HTMLInputElement>('#roads').checked = roads;
  }

  dismissIntro(): void { $('#intro').classList.add('dismissed'); }
  showStats(enabled: boolean): void { this.statsVisible = enabled; $('#performance').hidden = !enabled; $<HTMLInputElement>('#show-stats').checked = enabled; }
  toggleHUD(): void { $('#interface').classList.toggle('hud-hidden'); }
  setLoading(progress: number): void {
    $('#loading-progress').style.width = `${Math.round(progress * 100)}%`;
    $('#loading-text').textContent = progress < 1 ? `Finding your next horizon… ${Math.round(progress * 100)}%` : 'Your world is ready.';
  }
  ready(backend: BackendName): void { $('#loading').classList.add('loaded'); $('#backend').innerHTML = `<i></i>${backend}`; }
  beginLoading(): void { $('#loading').classList.remove('loaded'); this.setLoading(0); }
  setSeed(seed: string): void { $<HTMLInputElement>('#seed').value = seed; $('#seed-label').textContent = seed; }
  syncTime(hour: number, cycling: boolean): void { $<HTMLInputElement>('#time').value = String(hour); $('#time-value').textContent = formatHour(hour); $<HTMLInputElement>('#cycle').checked = cycling; }
  toast(message: string): void { clearTimeout(this.toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); this.toastTimer = window.setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
  fatal(message: string): void { $('#loading').classList.add('loaded'); $('#fatal-message').textContent = message; $('#fatal').hidden = false; }

  update(stats: UIStats, now: number): void {
    if (now - this.lastUpdate < 180) return;
    this.lastUpdate = now;
    $('#coordinates').innerHTML = `E ${(stats.x / 1000).toFixed(3)} <span>/</span> N ${(-stats.z / 1000).toFixed(3)} <small>km</small>`;
    $('#location-name').textContent = stats.biome.toUpperCase();
    $('#altitude').textContent = `ALT ${Math.round(stats.y).toLocaleString()} M`;
    $('#heading').textContent = `${String(Math.round(stats.heading)).padStart(3, '0')}°`;
    $('#clock').textContent = stats.time;
    $('#speed').textContent = `${Math.round(stats.speed)} M/S ${stats.touring ? 'CRUISE' : 'FLIGHT'}`;
    $('#tour-label').textContent = stats.routeName ? 'Route survey' : stats.touring ? 'Scenic flight' : 'Free flight';
    $('#tour-state').textContent = stats.routeName ? 'ON' : stats.touring ? 'ON' : 'MANUAL';
    $('#tour').setAttribute('aria-pressed', String(stats.touring || !!stats.routeName));
    if (stats.routeName) $('#speed').textContent = `${Math.round(stats.speed * 3.6)} KM/H · ${stats.routeName}`;
    if ($<HTMLInputElement>('#cycle').checked && document.activeElement !== $<HTMLInputElement>('#time')) {
      $<HTMLInputElement>('#time').value = String(Number(stats.time.slice(0, 2)) + Number(stats.time.slice(3)) / 60);
      $('#time-value').textContent = stats.time;
    }
    if (this.statsVisible) $('#performance').textContent = [
      `${stats.backend}  /  ${stats.fps.toFixed(0)} FPS`,
      `Frame       ${(1000 / Math.max(1, stats.fps)).toFixed(1)} ms`,
      `Draw calls  ${stats.calls}`,
      `Triangles   ${Math.round(stats.triangles).toLocaleString()}`,
      `Geometries  ${stats.geometries}`,
      `Tiles       ${stats.cached} cached / ${stats.pending} queued`,
      `Origin      ${stats.shifts} rebases`,
      `Plants      ${stats.vegetation.toLocaleString()} / ${stats.vegetationCapacity.toLocaleString()} slots`,
      `Batches     ${stats.vegetationBatches} instanced`,
      `Road tiles  ${stats.roadTiles}`,
      `Props       ${stats.props.toLocaleString()} / ${stats.propCapacity.toLocaleString()} slots`,
      `Objects     ${stats.objects} streamed · ${stats.objectBodies} bodies (${stats.objectSleeping} asleep)`,
      `Inventory   ${stats.inventoryItems} items`,
      `Target      ${stats.interactionTarget ?? '—'}`,
      `LOD 0–5     ${stats.lod.join(' · ')}`,
    ].join('\n');
  }
  dispose(): void { this.abort.abort(); clearTimeout(this.toastTimer); }
}
function formatHour(hour: number): string { return `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`; }

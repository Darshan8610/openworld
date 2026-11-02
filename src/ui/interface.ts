import type { BackendName } from '../rendering/renderer';
import type { QualityName } from '../config';
import { BIOMES } from '../world/biomes';
import type { BiomeId } from '../world/biomes';
import type { InteractionPrompt } from '../interaction/types';
import type { ConversationView } from '../npc/types';
import type { WeatherKind } from '../environment/weather';
import { itemDefinition, isItemId } from '../objects/items';
import type { ItemId } from '../objects/items';
import type { AccessibilityPreferences } from './preferences';
import { DEFAULT_AUDIO_SETTINGS } from '../audio/types';
import type { AudioSettings } from '../audio/types';
import { MenuState } from './menu';
import type { Overlay } from './menu';
import type { Caption } from './captions';

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
  /** Phase 8: population toggle and conversation replies. */
  npcs: (enabled: boolean) => void;
  dialogueTopic: (index: number) => void;
  dialogueEnd: () => void;
  route: (id: string) => void;
  wind: (enabled: boolean) => void;
  detail: (enabled: boolean) => void;
  postfx: (enabled: boolean) => void;
  viewpoint: (biome: BiomeId) => void;
  stats: (enabled: boolean) => void;
  /** Phase 4: physics simulation, collider debug overlay, sandbox prop. */
  physics: (enabled: boolean) => void;
  physicsDebug: (enabled: boolean) => void;
  dropCrate: () => void;
  mode: (mode: 'character' | 'survey') => void;
  firstPerson: (enabled: boolean) => void;
  sensitivity: (value: number) => void;
  shoulder: () => void;
  respawn: () => void;
  /** Phase 12: audio mix, accessibility, menus. */
  volume: (bus: 'master' | 'ambience' | 'effects' | 'ui', value: number) => void;
  mute: (muted: boolean) => void;
  captions: (enabled: boolean) => void;
  accessibility: (key: 'reducedMotion' | 'highContrast' | 'largeText' | 'interactionHold', value: boolean) => void;
  restart: () => void;
  title: () => void;
  uiSound: (sound: 'click' | 'hover' | 'confirm' | 'back' | 'error') => void;
  /** Phase 9: water surface streaming and the weather override. */
  water: (enabled: boolean) => void;
  weather: (kind: WeatherKind | null) => void;
  /** Phase 11: corner minimap. */
  minimap: (enabled: boolean) => void;
  /** Phase 13: adaptive quality stepping (never above the chosen preset). */
  adaptiveQuality: (enabled: boolean) => void;
}
export interface UIStats {
  x: number; y: number; z: number; heading: number; time: string; biome: string;
  fps: number; calls: number; triangles: number; geometries: number; cached: number;
  /** Phase 13: bounded profiler window + adaptive-preset state. */
  frameP95Ms: number; frameAvgMs: number; adaptiveQuality: string;
  pending: number; shifts: number; backend: BackendName; touring: boolean; speed: number;
  lod: number[]; progress: number;
  vegetation: number; vegetationBatches: number; vegetationCapacity: number;
  roadsEnabled: boolean; roadTiles: number; props: number; propCapacity: number;
  routeName: string | null; routeStation: number | null;
  physicsEnabled: boolean; physicsBodies: number; physicsColliders: number;
  physicsStepMs: number; physicsOverBudget: boolean; physicsGroundTiles: number;
  physicsProps: number;
  entityFull: number; entityReduced: number; entityBackground: number; entityDormant: number;
  mode: 'character' | 'survey';
  stance: string; animation: string; movement: string; firstPerson: boolean;
  rigSource: string; rigJoints: number; rigClips: number;
  objects: number; objectBodies: number; objectSleeping: number;
  inventoryItems: number; interactionTarget: string | null;
  npcActive: number; npcFull: number; npcReduced: number; npcBackground: number;
  npcRigs: number; npcRigCapacity: number; npcNearest: string | null;
  npcSearches: number; npcTruncated: boolean;
  audioState: string; audioVoices: number; audioCapacity: number; audioDropped: number;
  audioZone: string; audioSteps: number;
  /** Phase 9: hydrology, weather and particles. */
  waterEnabled: boolean; waterTiles: number; waterBodies: number; waterTriangles: number;
  waterBudget: number; underwater: boolean; seaState: number;
  weatherKind: WeatherKind; weatherLabel: string; weatherPinned: WeatherKind | null;
  rain: number; snow: number; wetness: number; snowCover: number; windSpeed: number;
  particles: number; particleCapacity: number;
  bodiesInWater: number; floatingBodies: number;
}

/** Title-screen fields: seed and preset before the world is entered. */
/** Seeds and backend names reach the markup: escape them rather than trusting input. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function menuFieldsMarkup(seed: string, quality: QualityName): string {
  const option = (value: QualityName, label: string) =>
    `<option value="${value}"${value === quality ? ' selected' : ''}>${label}</option>`;
  return `          <div class="menu-fields">
            <label class="field-label" for="menu-seed">World seed <span>Same seed. Same world.</span></label>
            <form id="menu-seed-form" class="seed-row"><input id="menu-seed" name="seed" maxlength="64" autocomplete="off" spellcheck="false" value="${escapeHtml(seed)}" required><button type="button" id="menu-random" aria-label="Generate random seed" title="Random seed">↻</button><button type="submit" class="apply">Apply</button></form>
            <label class="field-label" for="menu-quality">Graphics preset</label>
            <select id="menu-quality">${option('low', 'Low · lighter on your device')}${option('balanced', 'Balanced · recommended')}${option('high', 'High · extended horizons')}${option('ultra', 'Ultra · maximum detail + ambient occlusion')}</select>
          </div>`;
}

/** Pause menu: the only overlay that stops simulation. */
export function pauseMarkup(): string {
  return `      <div class="pause" id="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title" hidden>
        <div class="pause-panel">
          <span class="eyebrow"><i></i> SIMULATION PAUSED</span>
          <h2 id="pause-title">Take a breath.</h2>
          <p class="pause-note">The world is holding still — nothing is lost. Audio is muted while you are here.</p>
          <div class="pause-actions">
            <button class="primary" id="pause-resume">Resume <span>↩</span></button>
            <button id="pause-settings">World settings</button>
            <button id="pause-share">Copy world link</button>
            <button id="pause-mute">Mute sound</button>
            <button id="pause-restart">Restart world</button>
            <button id="pause-title-button">Back to title</button>
          </div>
          <div class="pause-controls">
            <span class="eyebrow">CONTROLS</span>
            <ul>
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</li>
              <li><kbd>Space</kbd> jump · <kbd>Shift</kbd> sprint · <kbd>Ctrl</kbd> crouch</li>
              <li><kbd>E</kbd> interact / talk · <kbd>1</kbd>–<kbd>4</kbd> reply</li>
              <li><kbd>C</kbd> survey camera · <kbd>F</kbd> first person</li>
              <li><kbd>N</kbd> people · <kbd>O</kbd> objects · <kbd>V</kbd> vegetation</li>
              <li><kbd>J</kbd> water · <kbd>U</kbd> weather · <kbd>M</kbd> map · <kbd>Q</kbd> vehicle</li>
              <li><kbd>F3</kbd> performance · <kbd>Esc</kbd> pause</li>
            </ul>
          </div>
          <p class="pause-hint"><kbd>Esc</kbd> resume · <kbd>Tab</kbd> move focus</p>
        </div>
      </div>`;
}

/** Sound section of the settings panel. */
export function audioSettingsMarkup(settings: AudioSettings): string {
  const percent = (value: number): string => `${Math.round(value * 100)}%`;
  const slider = (id: string, label: string, value: number): string =>
    `<div class="field-label"><label for="${id}">${label}</label><output id="${id}-value">${percent(value)}</output></div>
          <input id="${id}" type="range" min="0" max="1" step="0.01" value="${value}" aria-label="${label} volume">`;
  return `          <div class="nature-heading"><span class="eyebrow">SOUND</span><span id="audio-status">SYNTHESISED · WEB AUDIO</span></div>
          ${slider('volume-master', 'Master', settings.master)}
          ${slider('volume-ambience', 'Ambience', settings.ambience)}
          ${slider('volume-effects', 'World & footsteps', settings.effects)}
          ${slider('volume-ui', 'Interface', settings.ui)}
          <label class="switch-row" for="mute"><span>Mute all sound<small>Machine-local; nothing is downloaded</small></span><input type="checkbox" id="mute" role="switch"${settings.muted ? ' checked' : ''}></label>
          <label class="switch-row" for="captions"><span>Sound captions<small>Text for doors, pickups and greetings</small></span><input type="checkbox" id="captions" role="switch"${settings.captions ? ' checked' : ''}></label>`;
}

/** Accessibility section of the settings panel. */
export function accessibilitySettingsMarkup(prefs: AccessibilityPreferences): string {
  const row = (id: string, title: string, note: string, checked: boolean): string =>
    `<label class="switch-row" for="${id}"><span>${title}<small>${note}</small></span><input type="checkbox" id="${id}" role="switch"${checked ? ' checked' : ''}></label>`;
  return `          <div class="nature-heading"><span class="eyebrow">ACCESSIBILITY</span><span>PHASE 12</span></div>
          ${row('a11y-motion', 'Reduce motion', 'Stills wind, the day cycle and camera sway', prefs.reducedMotion)}
          ${row('a11y-contrast', 'High contrast', 'Stronger text and panel edges', prefs.highContrast)}
          ${row('a11y-text', 'Larger interface text', 'HUD, menus and panel copy', prefs.largeText)}
          ${row('a11y-hold', 'Hold to confirm', 'Off: a single press activates', prefs.interactionHold)}`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id.replace(/^#/, '')) as T;

/**
 * The whole interface shell as one string. Exported so DOM integrity can be
 * tested without a browser: every id the class looks up must exist here.
 */
export function interfaceMarkup(
  hour: number,
  backend: BackendName,
  seed = '',
  quality: QualityName = 'balanced',
  audio: AudioSettings = DEFAULT_AUDIO_SETTINGS,
  accessibility: AccessibilityPreferences = { reducedMotion: false, highContrast: false, largeText: false, interactionHold: true },
): string {
  return `      <div class="shade" aria-hidden="true"></div>
      <main class="interface" id="interface">
        <header class="topbar">
          <a class="brand" href="/" aria-label="Wayfarer home"><svg viewBox="0 0 40 34" aria-hidden="true"><path d="M3 7l9 21 8-15 8 15 9-21M14 7l6 12 6-12"/></svg><span>WAYFARER<small>A WORLD WITHOUT EDGES</small></span></a>
          <div class="top-actions"><span class="backend" id="backend"><i></i>${escapeHtml(backend)}</span><button class="icon-button" id="settings-toggle" aria-label="World settings" aria-expanded="false" aria-controls="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg></button></div>
        </header>
        <div class="compass" aria-label="Compass"><span>W</span><i></i><span>N</span><i></i><span>E</span><b id="heading">033°</b></div>
        <section class="intro game-menu" id="intro">
          <div class="game-menu-fog" aria-hidden="true"></div>
          <div class="game-menu-kicker eyebrow"><span></span> BLACKWOOD VALLEY · NIGHT ONE</div>
          <h1 class="game-menu-title">Echoes of<br>Blackwood Valley</h1>
          <p class="game-menu-tag">A psychological thriller inside one square kilometre. Two hours. One night.<br>Nobody is answering the radio.</p>
          <div class="menu-actions game-menu-actions">
            <button class="primary game-menu-item" id="explore">New game <span>↵</span></button>
            <button class="text-button game-menu-item" id="menu-settings">Settings</button>
            <button class="text-button game-menu-item" id="menu-share">Copy world link</button>
          </div>
          ${menuFieldsMarkup(seed, quality)}
          <p class="menu-status" id="menu-status">Preparing the terrain…</p>
          <div class="game-menu-footer"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>E</kbd> interact · <kbd>Esc</kbd> pause<i></i>DESKTOP BUILD v1.0</div>
        </section>
        <aside class="settings" id="settings" aria-label="World settings" hidden>
          <div class="panel-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>World settings</h2></div><button class="icon-button" id="settings-close" aria-label="Close settings">×</button></div>
          <label class="field-label" for="seed">World seed <span>Same seed. Same world.</span></label>
          <form id="seed-form" class="seed-row"><input id="seed" name="seed" maxlength="64" autocomplete="off" spellcheck="false" required><button type="button" id="random-seed" aria-label="Generate random seed" title="Random seed">↻</button><button type="submit" class="apply">Apply</button></form>
          <div class="field-label"><label for="time">Time of day</label><output id="time-value">${formatHour(hour)}</output></div>
          <input id="time" type="range" min="0" max="23.99" step="0.01" value="${hour}" aria-label="Time of day">
          <div class="range-labels"><span>Midnight</span><span>Noon</span><span>Midnight</span></div>
          <label class="switch-row" for="cycle"><span>Let the day unfold<small>A full day in 12 minutes</small></span><input type="checkbox" id="cycle" checked role="switch"></label>
          <label class="field-label" for="quality">Graphics preset</label><select id="quality"><option value="low">Low · lighter on your device</option><option value="balanced">Balanced · recommended</option><option value="high">High · extended horizons</option><option value="ultra">Ultra · maximum detail + ambient occlusion</option></select>
          <div class="nature-heading"><span class="eyebrow">THE PLAYER</span><span>PHASE 05</span></div>
          <label class="switch-row" for="walk-mode"><span>Walk the world <kbd>C</kbd><small>On foot. Off: free-flight survey camera</small></span><input type="checkbox" id="walk-mode" checked role="switch"></label>
          <label class="switch-row" for="first-person"><span>First-person camera <kbd>F</kbd></span><input type="checkbox" id="first-person" role="switch"></label>
          <div class="field-label"><label for="sensitivity">Look sensitivity</label><output id="sensitivity-value">1.00×</output></div>
          <input id="sensitivity" type="range" min="0.3" max="2.5" step="0.05" value="1" aria-label="Look sensitivity">
          <div class="panel-buttons"><button id="shoulder">Swap shoulder</button><button id="respawn">Return to spawn</button></div>
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
          <label class="switch-row" for="npcs"><span>People <kbd>N</kbd><small>Schedules, pathfinding & conversations</small></span><input type="checkbox" id="npcs" checked role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">PEOPLE ON THE ROAD</span><span>PHASE 08</span></div>
          <p class="panel-note">NPCs live on the verges: they follow a daily schedule, pathfind over the real terrain, investigate what they notice and answer questions about what the simulation already knows.</p>
          <div class="pack" id="pack" aria-live="polite"><span class="eyebrow">PACK <b id="pack-count">EMPTY</b></span><ul id="pack-list"></ul></div>
          <label class="switch-row" for="wind"><span>Wind in the canopy<small>Procedural, height-weighted motion</small></span><input type="checkbox" id="wind" checked role="switch"></label>
          <label class="switch-row" for="detail"><span>Terrain surface detail<small>Triplanar grass, rock & snow</small></span><input type="checkbox" id="detail" checked role="switch"></label>
          <label class="switch-row" for="postfx"><span>Cinematic post<small>Bloom, FXAA & vignette (off on Low)</small></span><input type="checkbox" id="postfx" checked role="switch"></label>
          <label class="switch-row" for="biome-debug"><span>Biome map <kbd>B</kbd><small>Inspect the climate regions</small></span><input type="checkbox" id="biome-debug" role="switch"></label>
          <label class="switch-row" for="lod"><span>Show terrain LOD<small>Color by geometry detail</small></span><input type="checkbox" id="lod" role="switch"></label>
          <label class="switch-row" for="wireframe"><span>Wireframe</span><input type="checkbox" id="wireframe" role="switch"></label>
          <label class="switch-row" for="show-stats"><span>Performance overlay <kbd>F3</kbd></span><input type="checkbox" id="show-stats" role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">MAP & NAVIGATION</span><span>PHASE 11</span></div>
          <label class="switch-row" for="minimap"><span>Corner minimap<small>North-up · roads appear as surveyed</small></span><input type="checkbox" id="minimap" checked role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">RELEASE & PERFORMANCE</span><span>PHASE 13</span></div>
          <label class="switch-row" for="adaptive-quality"><span>Adaptive quality<small>Steps down on sustained frame misses · never above your preset</small></span><input type="checkbox" id="adaptive-quality" checked role="switch"></label>
          <div class="nature-heading"><span class="eyebrow">WATER & WEATHER</span><span>PHASE 09</span></div>
          <label class="switch-row" for="water"><span>Water surfaces <kbd>J</kbd><small id="water-status">Lakes, rivers & seas · buoyancy on</small></span><input type="checkbox" id="water" checked role="switch"></label>
          <label class="field-label" for="weather-select">Weather<output id="weather-value">Auto</output></label>
          <select id="weather-select" aria-label="Weather"><option value="auto">Following the front · automatic</option><option value="clear">Clear</option><option value="cloudy">Cloudy</option><option value="overcast">Overcast</option><option value="rain">Rain</option><option value="heavy-rain">Heavy rain</option><option value="storm">Thunderstorm</option><option value="fog">Fog</option><option value="snow">Snow</option><option value="blizzard">Blizzard</option><option value="windy">Windy</option></select>
          <div class="nature-heading"><span class="eyebrow">SIMULATION</span><span>PHASE 04</span></div>
          <label class="switch-row" for="physics"><span>Physics<small id="physics-status">Starting rigid-body engine…</small></span><input type="checkbox" id="physics" checked role="switch"></label>
          <label class="switch-row" for="physics-debug"><span>Collider debug <kbd>K</kbd><small>Physics wireframes · developer view</small></span><input type="checkbox" id="physics-debug" role="switch"></label>
          <div class="panel-buttons"><button id="reset">Reset viewpoint</button><button id="share">Copy world link ↗</button></div>
          <div class="panel-buttons"><button id="drop-crate">Drop test crate <kbd>X</kbd></button></div>
          ${audioSettingsMarkup(audio)}
          ${accessibilitySettingsMarkup(accessibility)}
          <p class="panel-note">Phase 9 adds water: lakes, rivers and seas carved into the same deterministic terrain, a wave surface the renderer and the physics share, buoyancy for props and swimming for the player, a weather front that drifts across the world, and pooled precipitation and splash particles.</p>
          <p class="panel-note">Phase 4 adds the physics engine and streamed terrain colliders, Phase 5 puts you on foot with a third-person camera and ground physics, and Phase 6 adds interactive world objects — caches, containers, gates, lamps, valves, benches and pickups — with hold-to-confirm context actions and persistent state.</p>
        </aside>
        <div class="biome-legend" id="biome-legend" hidden><span class="eyebrow">CLIMATE OVERLAY</span>${BIOMES.map((biome) => `<span><i style="background:#${biome.color.toString(16).padStart(6, '0')}"></i>${biome.name}</span>`).join('')}</div>
        <pre class="performance" id="performance" aria-label="Performance statistics" hidden></pre>
        <footer class="bottom-hud"><div class="location"><span class="eyebrow"><i></i> <span id="location-name">VALLEY MEADOWS</span></span><div class="coordinates" id="coordinates">E 0.000 <span>/</span> N 0.000</div><div class="location-meta"><span id="altitude">ALT 420 M</span><span id="weather-chip">CLEAR</span><span>SEED <b id="seed-label"></b></span></div></div>
          <div class="controls-hint" id="controls-hint"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span><span><kbd>Space</kbd> jump</span><span><kbd>⇧</kbd> sprint</span><span><kbd>Ctrl</kbd> crouch</span><span><kbd>Alt</kbd> walk</span><span>Drag to look</span></div>
          <div class="travel"><span class="player-state" id="player-state"><span id="player-mode">ON FOOT</span><i></i><span id="player-stance">STANDING</span></span><button id="tour" aria-pressed="true"><span class="tour-dot"></span><span id="tour-label">Scenic flight</span><span id="tour-state">ON</span></button><div class="clock"><span id="clock">16:24</span><span id="speed">110 M/S CRUISE</span></div></div>
        </footer>
        <div class="reticle" id="reticle" aria-hidden="true">+</div>
        <div class="dialogue" id="dialogue" role="dialog" aria-label="Conversation" hidden>
          <div class="dialogue-head"><span class="eyebrow">IN CONVERSATION</span><b id="dialogue-name"></b><button class="dialogue-close" id="dialogue-close" type="button" aria-label="End conversation">×</button></div>
          <p id="dialogue-line">Choose a reply.</p>
          <ul id="dialogue-topics"></ul>
          <span class="dialogue-hint"><kbd>1</kbd>–<kbd>4</kbd> reply · <kbd>Esc</kbd> leave</span>
        </div>
        <div class="interaction" id="interaction" role="status" aria-live="polite" hidden>
          <span class="interaction-key" id="interaction-key">E</span>
          <div class="interaction-copy"><span class="interaction-target" id="interaction-target"></span><span class="interaction-action" id="interaction-action"></span></div>
          <i class="interaction-progress" id="interaction-progress"></i>
        </div>
      </main>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
      <div class="captions" id="captions-feed" role="status" aria-live="polite" aria-label="Sound captions" hidden></div>
      <div class="letterbox" id="letterbox" hidden aria-hidden="true"><i class="letterbox-top"></i><i class="letterbox-bottom"></i><span class="letterbox-hint"><kbd>Esc</kbd> skip · <kbd>Space</kbd> skip</span></div>
      <div class="story-subtitle" id="story-subtitle" role="status" aria-live="polite" hidden><b id="story-subtitle-speaker"></b><span id="story-subtitle-text"></span></div>
      <div class="mission-banner" id="mission-banner" role="status" aria-live="polite" hidden><span class="mission-banner-kind" id="mission-banner-kind"></span><b id="mission-banner-title"></b><span id="mission-banner-detail"></span></div>
      <div class="clue-overlay" id="clue-overlay" role="dialog" aria-label="Field note" hidden><div class="clue-card"><span class="eyebrow" id="clue-kind">FIELD NOTE</span><h2 id="clue-title"></h2><p id="clue-body"></p><button class="primary" id="clue-close" type="button">Close <span>×</span></button></div></div>
      <div class="credits-overlay" id="credits-overlay" role="dialog" aria-label="Credits" hidden><div class="credits-card"><span class="eyebrow">ECHOES OF BLACKWOOD VALLEY</span><h1>The valley keeps its silence.</h1><p>Jack Mercer walks out of the fog as morning light breaks through the pines. The diner answering machine plays to an empty office — this time, on the last tape, nobody answers back.</p><p class="credits-thanks">Thanks for playing.</p></div></div>
${pauseMarkup()}
      <div class="loading" id="loading"><div class="loading-brand">WAYFARER</div><div class="loading-line"><span id="loading-progress"></span></div><p id="loading-text">Finding your next horizon…</p><span class="loading-meta">PROCEDURAL TERRAIN · SEEDED & INFINITE</span></div>
      <div class="fatal" id="fatal" hidden><span class="eyebrow">A SMALL DETOUR</span><h1>We couldn’t open this world.</h1><p id="fatal-message"></p><button class="primary" id="retry">Try again</button><button class="text-button" id="compatibility">Try WebGL2 compatibility mode</button></div>`;
}

/** Small accessible development shell. Full menus/photo/mobile UI belong to Phase 8. */
export class Interface {
  private abort = new AbortController();
  private toastTimer = 0;
  private missionBannerTimer = 0;
  private lastUpdate = 0;
  statsVisible = false;
  private promptKey = '';
  private dialogueKey = '';
  /** Overlay state machine shared by the title, pause menu and settings. */
  private readonly menu = new MenuState('title');
  private audioSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
  private introDismissed = false;
  private captionSignature = '';
  private settingsReturnFocus: HTMLElement | null = null;
  /** Notified whenever the overlay changes; the game pauses/resumes from this. */
  onOverlayChange?: (overlay: Overlay) => void;
  constructor(seed: string, hour: number, quality: QualityName, backend: BackendName, private readonly actions: UIActions) {
    $('app').insertAdjacentHTML('beforeend', interfaceMarkup(hour, backend, seed, quality));
    $<HTMLInputElement>('#seed').value = seed;
    $<HTMLSelectElement>('#quality').value = quality;
    $<HTMLInputElement>('#menu-seed').value = seed;
    $<HTMLSelectElement>('#menu-quality').value = quality;
    $('#seed-label').textContent = seed;
    const on = (id: string, event: string, fn: EventListener) => $(id).addEventListener(event, fn, { signal: this.abort.signal });
    on('settings-toggle', 'click', () => (this.menu.current === 'settings' ? this.closeSettings() : this.openSettings()));
    on('settings-close', 'click', () => this.closeSettings());
    on('menu-settings', 'click', () => this.openSettings());
    on('menu-share', 'click', () => actions.share());
    on('menu-seed-form', 'submit', (event) => { event.preventDefault(); actions.seed($<HTMLInputElement>('#menu-seed').value); });
    on('menu-random', 'click', () => actions.randomSeed());
    on('menu-quality', 'change', () => actions.quality($<HTMLSelectElement>('#menu-quality').value as QualityName));
    // Console-style menu: ↑/↓ cycle the main items while the title is up.
    document.addEventListener('keydown', (event) => {
      if (this.overlay !== 'title' || (event.code !== 'ArrowDown' && event.code !== 'ArrowUp')) return;
      const items = [...document.querySelectorAll<HTMLButtonElement>('.game-menu-item')];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.code === 'ArrowDown' ? 1 : -1;
      const next = items[(index + step + items.length) % items.length] ?? items[0]!;
      next.focus();
      this.actions.uiSound('hover');
    }, { signal: this.abort.signal });
    on('explore', 'click', () => { this.enterWorld(); actions.lock(); actions.uiSound('confirm'); this.toast('WASD to move · Space to jump · E to interact · C for the survey camera · Esc to pause'); });
    on('pause-resume', 'click', () => this.resume());
    on('pause-settings', 'click', () => this.openSettings());
    on('pause-share', 'click', () => actions.share());
    on('pause-mute', 'click', () => actions.mute(!this.audioSettings.muted));
    on('pause-restart', 'click', () => actions.restart());
    on('pause-title-button', 'click', () => actions.title());
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
    on('npcs', 'change', () => actions.npcs($<HTMLInputElement>('#npcs').checked));
    on('dialogue-close', 'click', () => actions.dialogueEnd());
    on('clue-close', 'click', () => { $<HTMLDivElement>('#clue-overlay').hidden = true; });
    on('dialogue-topics', 'click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button[data-topic]') as HTMLButtonElement | null;
      if (!button) return;
      actions.dialogueTopic(Number(button.dataset.topic ?? '0'));
    });
    on('water', 'change', () => actions.water($<HTMLInputElement>('#water').checked));
    on('minimap', 'change', () => actions.minimap($<HTMLInputElement>('#minimap').checked));
    on('adaptive-quality', 'change', () => actions.adaptiveQuality($<HTMLInputElement>('#adaptive-quality').checked));
    on('weather-select', 'change', () => {
      const value = $<HTMLSelectElement>('#weather-select').value;
      actions.weather(value === 'auto' ? null : value as WeatherKind);
    });
    on('route-select', 'change', () => { const value = $<HTMLSelectElement>('#route-select').value; if (value) { actions.route(value); $<HTMLSelectElement>('#route-select').value = ''; } });
    on('biome-view', 'change', () => { const value = $<HTMLSelectElement>('#biome-view').value; if (value !== '') { actions.viewpoint(Number(value) as BiomeId); $<HTMLSelectElement>('#biome-view').value = ''; } });
    on('wind', 'change', () => actions.wind($<HTMLInputElement>('#wind').checked));
    on('detail', 'change', () => actions.detail($<HTMLInputElement>('#detail').checked));
    on('show-stats', 'change', () => this.showStats($<HTMLInputElement>('#show-stats').checked));
    on('physics', 'change', () => actions.physics($<HTMLInputElement>('#physics').checked));
    on('physics-debug', 'change', () => actions.physicsDebug($<HTMLInputElement>('#physics-debug').checked));
    on('drop-crate', 'click', () => actions.dropCrate());
    on('walk-mode', 'change', () => actions.mode($<HTMLInputElement>('#walk-mode').checked ? 'character' : 'survey'));
    on('first-person', 'change', () => actions.firstPerson($<HTMLInputElement>('#first-person').checked));
    on('sensitivity', 'input', () => {
      const value = Number($<HTMLInputElement>('#sensitivity').value);
      $('#sensitivity-value').textContent = `${value.toFixed(2)}×`;
      actions.sensitivity(value);
    });
    for (const [id, bus] of [['volume-master', 'master'], ['volume-ambience', 'ambience'], ['volume-effects', 'effects'], ['volume-ui', 'ui']] as const) {
      on(id, 'input', () => {
        const value = Number($<HTMLInputElement>(`#${id}`).value);
        $(`#${id}-value`).textContent = `${Math.round(value * 100)}%`;
        actions.volume(bus, value);
      });
    }
    on('mute', 'change', () => actions.mute($<HTMLInputElement>('#mute').checked));
    on('captions', 'change', () => actions.captions($<HTMLInputElement>('#captions').checked));
    for (const [id, key] of [['a11y-motion', 'reducedMotion'], ['a11y-contrast', 'highContrast'], ['a11y-text', 'largeText'], ['a11y-hold', 'interactionHold']] as const) {
      on(id, 'change', () => actions.accessibility(key, $<HTMLInputElement>(`#${id}`).checked));
    }
    // Interface feedback for every button, so menus are audible as well as visible.
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button');
      if (!button || (button as HTMLButtonElement).disabled) return;
      actions.uiSound(button.classList.contains('primary') ? 'confirm' : 'click');
    }, { signal: this.abort.signal });
    on('shoulder', 'click', () => actions.shoulder());
    on('respawn', 'click', () => actions.respawn());
    on('retry', 'click', () => location.reload());
    on('compatibility', 'click', () => { const url = new URL(location.href); url.searchParams.set('renderer', 'webgl'); location.href = url.href; });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape') this.escape();
      if (event.code === 'Tab') this.trapFocus(event);
    }, { signal: this.abort.signal });
    document.addEventListener('pointerlockchange', () => { document.body.classList.toggle('pointer-locked', document.pointerLockElement !== null); }, { signal: this.abort.signal });
    // The world starts behind the title screen; the HUD is inert until entry.
    this.applyOverlay('title');
  }


  /* ---- overlays and menus ------------------------------------------------- */

  get overlay(): Overlay { return this.menu.current; }
  get paused(): boolean { return this.menu.paused; }
  get onTitle(): boolean { return this.menu.onTitle; }

  /** Leave the title screen and give the world the keyboard. */
  enterWorld(): void {
    this.dismissIntro();
    this.applyOverlay(this.menu.enterWorld().to);
  }

  togglePause(): void { this.applyOverlay(this.menu.togglePause().to); }

  resume(): void { this.applyOverlay(this.menu.resume().to); }

  openSettings(): void {
    this.settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.applyOverlay(this.menu.openSettings().to);
  }

  closeSettings(): void {
    const change = this.menu.closeSettings();
    this.applyOverlay(change.to);
    if (change.to === 'none') this.settingsReturnFocus?.focus?.();
  }

  backToTitle(): void {
    this.restoreIntro();
    this.applyOverlay(this.menu.backToTitle().to);
  }

  /** Escape steps out one level; returns true when the interface consumed it. */
  escape(): boolean {
    if (this.menu.current === 'settings') { this.closeSettings(); return true; }
    if (this.menu.current === 'pause') { this.resume(); return true; }
    return false;
  }

  private applyOverlay(overlay: Overlay): void {
    const settingsOpen = overlay === 'settings';
    $('#settings').hidden = !settingsOpen;
    $('#settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
    $('#pause').hidden = overlay !== 'pause';
    // Only the pause menu hides the HUD from assistive tech. The title screen's
    // own controls (seed, quality, Enter the world) live inside the shell, so the
    // shell must stay interactive and exposed while it is shown.
    const modal = overlay === 'pause';
    const shell = $('#interface') as HTMLElement & { inert?: boolean };
    shell.inert = modal;
    shell.setAttribute('aria-hidden', String(modal));
    document.body.classList.toggle('paused', overlay === 'pause');
    document.body.classList.toggle('title-screen', overlay === 'title');
    document.body.classList.toggle('settings-open', settingsOpen);
    if (overlay === 'pause') $<HTMLButtonElement>('#pause-resume').focus({ preventScroll: true });
    else if (settingsOpen) $<HTMLButtonElement>('#settings-close').focus({ preventScroll: true });
    else if (overlay === 'none') $('#explore')?.blur?.();
    this.onOverlayChange?.(overlay);
  }

  /** Cycle Tab inside the open overlay so focus cannot wander behind it. */
  private trapFocus(event: KeyboardEvent): void {
    const overlay = this.menu.current;
    if (overlay !== 'pause' && overlay !== 'settings') return;
    const root = $(overlay === 'pause' ? '#pause' : '#settings');
    const focusable = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault(); first.focus();
    } else if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault(); last.focus();
    }
  }

  /* ---- audio and accessibility state -------------------------------------- */

  syncAudio(settings: AudioSettings): void {
    this.audioSettings = settings;
    for (const [id, value] of [['volume-master', settings.master], ['volume-ambience', settings.ambience], ['volume-effects', settings.effects], ['volume-ui', settings.ui]] as const) {
      $<HTMLInputElement>(`#${id}`).value = String(value);
      $(`#${id}-value`).textContent = `${Math.round(value * 100)}%`;
    }
    $<HTMLInputElement>('#mute').checked = settings.muted;
    $<HTMLInputElement>('#captions').checked = settings.captions;
    const muteButton = $('#pause-mute');
    if (muteButton) muteButton.textContent = settings.muted ? 'Unmute sound' : 'Mute sound';
  }

  syncPreferences(preferences: AccessibilityPreferences): void {
    $<HTMLInputElement>('#a11y-motion').checked = preferences.reducedMotion;
    $<HTMLInputElement>('#a11y-contrast').checked = preferences.highContrast;
    $<HTMLInputElement>('#a11y-text').checked = preferences.largeText;
    $<HTMLInputElement>('#a11y-hold').checked = preferences.interactionHold;
  }

  /** Shown in the SOUND section: whether audio is running and how it is made. */
  setAudioStatus(text: string): void { $('#audio-status').textContent = text; }

  setMenuStatus(text: string): void { $('#menu-status').textContent = text; }

  /**
   * Sound captions. Called every frame; the DOM is only touched when the visible
   * set changes.
   */
  setCaptions(captions: readonly Caption[]): void {
    const signature = captions.map((caption) => caption.id).join(',');
    if (signature === this.captionSignature) return;
    this.captionSignature = signature;
    const element = $<HTMLDivElement>('#captions-feed');
    if (captions.length === 0) { element.hidden = true; element.textContent = ''; return; }
    element.hidden = false;
    element.innerHTML = captions
      .map((caption) => `<span class="caption">${caption.text}${caption.direction ? ` <i>· ${caption.direction}</i>` : ''}</span>`)
      .join('');
  }

  syncDebug(lod: boolean, biome: boolean): void {
    $<HTMLInputElement>('#lod').checked = lod;
    $<HTMLInputElement>('#biome-debug').checked = biome;
    $('#biome-legend').hidden = !biome;
  }
  syncPost(enabled: boolean): void { $<HTMLInputElement>('#postfx').checked = enabled; }
  /** Enable or disable the physics controls once the engine resolves. */
  setPhysicsAvailable(available: boolean): void {
    $<HTMLInputElement>('#physics').disabled = !available;
    $<HTMLInputElement>('#physics-debug').disabled = !available;
    $<HTMLButtonElement>('#drop-crate').disabled = !available;
    $('#physics-status').textContent = available
      ? 'Rapier · rigid bodies on streamed terrain'
      : 'Unavailable in this browser · the world still streams';
  }
  syncPhysics(enabled: boolean, debug: boolean): void {
    $<HTMLInputElement>('#physics').checked = enabled;
    $<HTMLInputElement>('#physics-debug').checked = debug;
  }
  /** Reflect the active view in the panel and the HUD chrome. */
  syncCamera(mode: 'character' | 'survey', firstPerson: boolean): void {
    $<HTMLInputElement>('#walk-mode').checked = mode === 'character';
    $<HTMLInputElement>('#first-person').checked = firstPerson;
    $<HTMLInputElement>('#first-person').disabled = mode !== 'character';
    document.body.classList.toggle('mode-survey', mode === 'survey');
    const hint = $('#controls-hint');
    hint.innerHTML = mode === 'character'
      ? '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span><span><kbd>Space</kbd> jump</span><span><kbd>⇧</kbd> sprint</span><span><kbd>Ctrl</kbd> crouch</span><span><kbd>Alt</kbd> walk</span><span><kbd>C</kbd> survey camera</span>'
      : '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> fly</span><span><kbd>Q</kbd><kbd>E</kbd> altitude</span><span><kbd>⇧</kbd> boost</span><span><kbd>C</kbd> on foot</span><span>Drag to look</span>';
  }
  syncObjects(enabled: boolean): void { $<HTMLInputElement>('#objects').checked = enabled; }
  syncNpcs(enabled: boolean): void { $<HTMLInputElement>('#npcs').checked = enabled; }

  /**
   * Conversation panel. Called every frame, so the DOM is only rebuilt when the
   * open conversation or its last answer actually changes.
   */
  setDialogue(view: ConversationView | null): void {
    const element = $<HTMLDivElement>('#dialogue');
    if (!view) {
      if (!element.hidden) element.hidden = true;
      this.dialogueKey = '';
      return;
    }
    const key = `${view.npcId}|${view.line ?? 'open'}`;
    if (key === this.dialogueKey) return;
    this.dialogueKey = key;
    element.hidden = false;
    $('#dialogue-name').textContent = view.npcLabel;
    $('#dialogue-line').textContent = view.line ?? 'Choose a reply.';
    if (!view.line) {
      $('#dialogue-topics').innerHTML = view.topics
        .map((topic, index) => `<li><button type="button" data-topic="${index}"><kbd>${index + 1}</kbd><span>${topic.label}</span></button></li>`)
        .join('');
    }
  }

  /** Reflect water streaming and the weather mode in the panel. */
  syncWater(enabled: boolean, weather: WeatherKind | null): void {
    $<HTMLInputElement>('#water').checked = enabled;
    $<HTMLSelectElement>('#weather-select').value = weather ?? 'auto';
    $('#weather-value').textContent = weather ? weather.replace('-', ' ') : 'Auto';
    $('#water-status').textContent = enabled
      ? 'Lakes, rivers & seas · buoyancy on'
      : 'Surface hidden · physics queries still answer';
  }

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

  dismissIntro(): void {
    if (this.introDismissed) return;
    this.introDismissed = true;
    $('#intro').classList.add('dismissed');
  }

  restoreIntro(): void {
    this.introDismissed = false;
    $('#intro').classList.remove('dismissed');
    $<HTMLButtonElement>('#explore').focus({ preventScroll: true });
  }
  showStats(enabled: boolean): void { this.statsVisible = enabled; $('#performance').hidden = !enabled; $<HTMLInputElement>('#show-stats').checked = enabled; }
  toggleHUD(): void { $('#interface').classList.toggle('hud-hidden'); }
  setLoading(progress: number): void {
    $('#loading-progress').style.width = `${Math.round(progress * 100)}%`;
    $('#loading-text').textContent = progress < 1 ? `Finding your next horizon… ${Math.round(progress * 100)}%` : 'Your world is ready.';
  }
  ready(backend: BackendName): void {
    $('#loading').classList.add('loaded');
    $('#backend').innerHTML = `<i></i>${backend}`;
    this.setMenuStatus('Your world is ready. Enter whenever you like.');
  }
  beginLoading(): void { $('#loading').classList.remove('loaded'); this.setLoading(0); }
  setSeed(seed: string): void { $<HTMLInputElement>('#seed').value = seed; $('#seed-label').textContent = seed; }
  syncTime(hour: number, cycling: boolean): void { $<HTMLInputElement>('#time').value = String(hour); $('#time-value').textContent = formatHour(hour); $<HTMLInputElement>('#cycle').checked = cycling; }
  toast(message: string): void { clearTimeout(this.toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); this.toastTimer = window.setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
  fatal(message: string): void { $('#loading').classList.add('loaded'); $('#fatal-message').textContent = message; $('#fatal').hidden = false; }

  // ---- Story campaign (Echoes of Blackwood Valley) --------------------------

  /** Subtle banner on mission start / objective update / act completion. */
  missionBanner(kind: 'mission' | 'objective' | 'act', title: string, detail: string): void {
    clearTimeout(this.missionBannerTimer);
    const banner = $<HTMLDivElement>('#mission-banner');
    $('#mission-banner-kind').textContent = kind === 'act' ? 'CHAPTER' : kind === 'objective' ? 'OBJECTIVE' : 'MISSION';
    $('#mission-banner-title').textContent = title;
    $('#mission-banner-detail').textContent = detail;
    banner.hidden = false;
    banner.classList.remove('visible');
    // Force a reflow so the entrance animation replays on rapid updates.
    void banner.offsetWidth;
    banner.classList.add('visible');
    this.missionBannerTimer = window.setTimeout(() => {
      banner.classList.remove('visible');
      window.setTimeout(() => { banner.hidden = true; }, 400);
    }, kind === 'act' ? 5200 : 3800);
  }

  setLetterbox(on: boolean): void { $<HTMLDivElement>('#letterbox').hidden = !on; }

  setSubtitle(text: string | null, speaker?: string | null): void {
    const element = $<HTMLDivElement>('#story-subtitle');
    if (text === null) { element.hidden = true; return; }
    $('#story-subtitle-speaker').textContent = speaker ? `${speaker} ·` : '';
    $('#story-subtitle-text').textContent = text;
    element.hidden = false;
  }

  setHudVisible(visible: boolean): void { document.body.classList.toggle('story-cinematic', !visible); }

  showClue(clue: { title: string; body: string; kind: string }): void {
    $('#clue-kind').textContent = clue.kind === 'cassette' ? 'AUDIO PLAYED' : clue.kind === 'log' ? 'RECORDING' : 'FIELD NOTE';
    $('#clue-title').textContent = clue.title;
    $('#clue-body').textContent = clue.body;
    $<HTMLDivElement>('#clue-overlay').hidden = false;
  }

  setCredits(on: boolean): void { $<HTMLDivElement>('#credits-overlay').hidden = !on; }

  update(stats: UIStats, now: number): void {
    if (now - this.lastUpdate < 180) return;
    this.lastUpdate = now;
    $('#coordinates').innerHTML = `E ${(stats.x / 1000).toFixed(3)} <span>/</span> N ${(-stats.z / 1000).toFixed(3)} <small>km</small>`;
    $('#location-name').textContent = stats.biome.toUpperCase();
    $('#altitude').textContent = `ALT ${Math.round(stats.y).toLocaleString()} M`;
    $('#heading').textContent = `${String(Math.round(stats.heading)).padStart(3, '0')}°`;
    $('#weather-chip').textContent = stats.weatherLabel.toUpperCase();
    $('#clock').textContent = stats.time;
    $('#speed').textContent = `${Math.round(stats.speed)} M/S ${stats.touring ? 'CRUISE' : 'FLIGHT'}`;
    const onFoot = stats.mode === 'character';
    $('#tour-label').textContent = stats.routeName ? 'Route survey' : stats.touring ? 'Scenic flight' : 'Free flight';
    $('#tour-state').textContent = stats.routeName ? 'ON' : stats.touring ? 'ON' : 'MANUAL';
    $('#tour').setAttribute('aria-pressed', String(stats.touring || !!stats.routeName));
    // The HUD adapts to the view: no flight telemetry while walking, no walk
    // telemetry while flying the survey camera.
    $('#player-mode').textContent = onFoot ? (stats.firstPerson ? 'FIRST PERSON' : 'ON FOOT') : 'SURVEY CAM';
    $('#player-stance').textContent = onFoot
      ? `${stats.stance.toUpperCase()} · ${(stats.animation === 'idle' ? 'STANDING' : stats.animation.toUpperCase())}`
      : 'FREE FLIGHT';
    if (onFoot) $('#speed').textContent = `${Math.round(stats.speed * 3.6)} KM/H · ${stats.movement.toUpperCase()}`;
    else if (stats.routeName) $('#speed').textContent = `${Math.round(stats.speed * 3.6)} KM/H · ${stats.routeName}`;
    else $('#speed').textContent = `${Math.round(stats.speed)} M/S ${stats.touring ? 'CRUISE' : 'FLIGHT'}`;
    if ($<HTMLInputElement>('#cycle').checked && document.activeElement !== $<HTMLInputElement>('#time')) {
      $<HTMLInputElement>('#time').value = String(Number(stats.time.slice(0, 2)) + Number(stats.time.slice(3)) / 60);
      $('#time-value').textContent = stats.time;
    }
    if (this.statsVisible) $('#performance').textContent = [
      `${stats.backend}  /  ${stats.fps.toFixed(0)} FPS`,
      `Frame       ${(1000 / Math.max(1, stats.fps)).toFixed(1)} ms`,
      `Frame p95   ${stats.frameP95Ms.toFixed(1)} ms · avg ${stats.frameAvgMs.toFixed(1)} ms`,
      `Adaptive    ${stats.adaptiveQuality}`,
      `Draw calls  ${stats.calls}`,
      `Triangles   ${Math.round(stats.triangles).toLocaleString()}`,
      `Geometries  ${stats.geometries}`,
      `Tiles       ${stats.cached} cached / ${stats.pending} queued`,
      `Origin      ${stats.shifts} rebases`,
      `Plants      ${stats.vegetation.toLocaleString()} / ${stats.vegetationCapacity.toLocaleString()} slots`,
      `Batches     ${stats.vegetationBatches} instanced`,
      `Player      ${stats.mode.toUpperCase()} · ${stats.stance.toUpperCase()} · ${stats.animation}`,
      `Rig         ${stats.rigSource} · ${stats.rigJoints} joints · ${stats.rigClips} clips`,
      `Road tiles  ${stats.roadTiles}`,
      `Props       ${stats.props.toLocaleString()} / ${stats.propCapacity.toLocaleString()} slots`,
      `Physics     ${stats.physicsEnabled ? `${stats.physicsBodies} bodies / ${stats.physicsColliders} colliders · ${stats.physicsStepMs.toFixed(2)} ms${stats.physicsOverBudget ? ' (over budget)' : ''}` : 'off'}`,
      `Ground      ${stats.physicsGroundTiles} streamed colliders`,
      `Entities    ${stats.entityFull} full / ${stats.entityReduced} reduced / ${stats.entityBackground} back / ${stats.entityDormant} dormant`,
      `Test props  ${stats.physicsProps}`,
      `Objects     ${stats.objects} streamed · ${stats.objectBodies} bodies (${stats.objectSleeping} asleep)`,
      `Inventory   ${stats.inventoryItems} items`,
      `Target      ${stats.interactionTarget ?? '—'}`,
      `People      ${stats.npcActive} streamed · ${stats.npcFull} full / ${stats.npcReduced} reduced / ${stats.npcBackground} back`,
      `Rigs        ${stats.npcRigs} / ${stats.npcRigCapacity} skinned NPCs`,
      `NPC paths   ${stats.npcSearches} searches${stats.npcTruncated ? ' · population budget reached' : ''}`,
      `Nearest NPC ${stats.npcNearest ?? '—'}`,
      `Audio       ${stats.audioState} · ${stats.audioVoices}/${stats.audioCapacity} voices · ${stats.audioDropped} dropped`,
      `Ambience    ${stats.audioZone} zone · ${stats.audioSteps} footsteps`,
      `Weather     ${stats.weatherLabel}${stats.weatherPinned ? ' (pinned)' : ''} · rain ${(stats.rain * 100).toFixed(0)}% · snow ${(stats.snow * 100).toFixed(0)}%`,
      `Wind        ${stats.windSpeed.toFixed(1)} m/s · sea state ${stats.seaState.toFixed(2)}`,
      `Ground      wetness ${(stats.wetness * 100).toFixed(0)}% · snow cover ${(stats.snowCover * 100).toFixed(0)}%`,
      `Water       ${stats.waterEnabled ? `${stats.waterTiles} tiles / ${stats.waterBudget} · ${Math.round(stats.waterTriangles).toLocaleString()} tris · ${stats.waterBodies} bodies` : 'off'}${stats.underwater ? ' · UNDERWATER' : ''}`,
      `Particles   ${stats.particles} / ${stats.particleCapacity} · ${stats.bodiesInWater} bodies in water (${stats.floatingBodies} floating)`,
      `LOD 0–5     ${stats.lod.join(' · ')}`,
    ].join('\n');
  }
  dispose(): void { this.abort.abort(); clearTimeout(this.toastTimer); clearTimeout(this.missionBannerTimer); }
}
function formatHour(hour: number): string { return `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`; }

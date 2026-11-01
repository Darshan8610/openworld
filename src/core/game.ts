import { Scene, Fog, Vector3 } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import { createRenderer, resizeRenderer } from '../rendering/renderer';
import { PostProcessing } from '../rendering/post-processing';
import type { RenderingContext } from '../rendering/renderer';
import { FloatingOrigin } from './floating-origin';
import { FixedLoop } from './fixed-loop';
import { Input } from './input';
import { SurveyCamera } from './survey-camera';
import { WaterManager } from '../world/water-manager';
import { BuoyancySolver } from '../physics/buoyancy';
import { WeatherSystem } from '../environment/weather';
import type { WeatherKind } from '../environment/weather';
import { ParticleSystem } from '../effects/particles';
import { TerrainManager } from '../world/terrain-manager';
import { VegetationManager } from '../world/vegetation-manager';
import { RoadManager } from '../world/road-manager';
import { SCENIC_ROUTES, RoadNetwork } from '../world/road-network';
import { BIOMES } from '../world/biomes';
import type { BiomeId } from '../world/biomes';
import { findBiomeViewpoint, findRouteStation } from '../world/viewpoints';
import { SkySystem } from '../world/sky';
import { CharacterSystem } from '../character/character-system';
import { Interface } from '../ui/interface';
import { normalizeSeed, randomSeed } from '../utils/random';
import { clamp } from '../utils/math';
import { EventBus } from '../game/events';
import { WorldManager } from '../game/world-manager';
import { PhysicsWorld } from '../physics/physics-world';
import { PhysicsGroundStreamer } from '../physics/ground-streamer';
import { PhysicsDebugRenderer } from '../physics/debug-renderer';

/** The player walks the world; the survey camera stays as an inspection tool. */
export type ViewMode = 'character' | 'survey';
import { GameEventBus } from './events';
import type { WorldPoint } from './coordinates';
import { WorldQueries } from '../world/world-queries';
import { PropPhysicsWorld } from '../physics/prop-physics';
import type { GroundContact } from '../physics/rigid-body';
import { Inventory } from '../interaction/inventory';
import { InteractionManager } from '../interaction/manager';
import { ObjectSystem } from '../objects/object-system';
import { ObjectStateStore } from '../persistence/object-store';
import type { PersistedObjects } from '../persistence/object-store';
import type { ItemStack } from '../objects/items';
import { clearObjectGeometryCache } from '../rendering/object-geometry';
import type { ActorView } from '../interaction/types';

/** Actor state the rig updates every fixed step; structurally an `ActorView`. */
interface MutableActor extends ActorView {
  position: WorldPoint;
  forward: WorldPoint;
  yaw: number;
}

/** Composition root: subsystem ownership and lifecycle are explicit. */
export class Game {
  private readonly scene = new Scene();
  private readonly origin = new FloatingOrigin();
  private readonly loop = new FixedLoop();
  private readonly context: RenderingContext;
  private readonly input: Input;
  private readonly terrain: TerrainManager;
  private readonly vegetation: VegetationManager;
  private readonly roads: RoadManager;
  private readonly rig: SurveyCamera;
  private readonly character: CharacterSystem;
  private readonly sky: SkySystem;
  private readonly post: PostProcessing;
  private readonly ui: Interface;
  private readonly abort = new AbortController();
  private readonly unsubscribeOrigin: () => void;
  /** Phase 4 world layer: entities, unified queries, physics, ordered streaming. */
  private readonly worldEvents = new EventBus();
  private readonly world: WorldManager;
  private physics?: PhysicsWorld;
  private physicsDebug?: PhysicsDebugRenderer;
  private physicsError?: string;
  private quality: QualityName;
  private seed: string;
  private ready = false;
  private disposed = false;
  private compileStarted = false;
  private resetVersion = 0;
  private loadTime = 0;
  private readonly localPosition = new Vector3();
  private readonly activePosition = new Vector3();
  private mode: ViewMode = 'character';
  /** Typed game-event layer shared by objects, interaction, audio and missions. */
  private readonly events = new GameEventBus();
  private readonly store = new ObjectStateStore();
  private inventory!: Inventory;
  private queries!: WorldQueries;
  /** Phase 9: hydrology surface streaming, water forces, weather and particles. */
  private water!: WaterManager;
  private buoyancy!: BuoyancySolver;
  private weather!: WeatherSystem;
  private particles!: ParticleSystem;
  /** Presentation clock for wave phase; identical driver for water and physics. */
  private simTime = 0;
  private weatherKind: WeatherKind = 'clear';
  /** Countdown between swimmer wake splashes (fixed clock). */
  private wakeTimer = 0;
  private underwater = false;
  private readonly cameraWorld = new Vector3();
  private readonly wind = { x: 0, z: 0 };
  private propPhysics!: PropPhysicsWorld;
  private interaction!: InteractionManager;
  private objects!: ObjectSystem;
  private objectsEnabled = true;
  private interactPressed = false;
  private saveDirty = false;
  private lastSave = 0;
  private restoreNotice: string | null = null;
  private readonly actor: MutableActor = {
    id: 'player', yaw: 0,
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
  };
  private readonly groundSample = (x: number, z: number, out: GroundContact): GroundContact => {
    const sample = this.queries.groundFast(x, z);
    out.height = sample.height;
    out.nx = sample.nx; out.ny = sample.ny; out.nz = sample.nz;
    out.surface = sample.surface;
    return out;
  };

  private constructor(context: RenderingContext, seed: string, quality: QualityName, hour: number, position: Vector3) {
    this.context = context; this.seed = seed; this.quality = quality;
    this.scene.name = 'Wayfarer / Phase 9';
    this.scene.fog = new Fog(0xb6c8cf, QUALITY[quality].viewDistance * 0.36, QUALITY[quality].viewDistance);
    this.input = new Input(context.canvas);
    this.terrain = new TerrainManager(this.origin, seed, quality, (error) => this.fail(error));
    this.vegetation = new VegetationManager(this.terrain, this.origin, quality);
    this.roads = new RoadManager(this.terrain, this.origin, quality, seed);
    if (new URLSearchParams(location.search).get('roads') === '0') this.roads.setEnabled(false);
    if (new URLSearchParams(location.search).get('vegetation') === '0') this.vegetation.setEnabled(false);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.vegetation.setWind(false);
    this.buildGameplayLayer(seed);
    if (new URLSearchParams(location.search).get('objects') === '0') { this.objectsEnabled = false; this.objects.setEnabled(false); }
    if (new URLSearchParams(location.search).get('water') === '0') this.water.setEnabled(false);
    this.rig = new SurveyCamera(this.input, this.origin, this.terrain, this.roads);
    this.rig.position.copy(position); this.rig.previous.copy(position); this.rig.home.copy(position);
    this.origin.update(position);
    // The playable character is the primary view; the survey rig stays parked on
    // the scenic route so switching (C) never loses the route context.
    this.character = new CharacterSystem({
      scene: this.scene,
      terrain: this.terrain,
      origin: this.origin,
      input: this.input,
      quality,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    // Swimming reads the same water surface the renderer draws, waves included.
    this.character.setWater(this.water.swimQuery);
    this.character.onEvent = (event) => this.handleCharacterEvent(event);
    this.character.spawnAt(position.x, position.z);
    this.sky = new SkySystem(context.renderer, this.scene, seed, quality);
    this.sky.setHour(hour);
    this.post = new PostProcessing(context.renderer, this.scene, this.character.camera, quality);
    const postParam = new URLSearchParams(location.search).get('postfx');
    if (postParam !== null) this.post.setEnabled(postParam !== '0');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.sky.cycling = false; this.rig.touring = false; }
    this.scene.add(this.terrain.group, this.vegetation.group, this.roads.group, this.objects.group);
    this.scene.add(this.water.group, this.particles.group);
    this.world = new WorldManager({
      origin: this.origin, terrain: this.terrain, vegetation: this.vegetation, roads: this.roads, events: this.worldEvents,
      water: this.water, buoyancy: this.buoyancy,
      condition: () => this.weather.state,
    });
    this.scene.add(this.world.props);
    this.unsubscribeOrigin = this.origin.onChange((delta) => {
      this.terrain.rebase(delta);
      this.vegetation.rebase();
      this.roads.rebase(delta);
      this.objects.rebase(this.origin.absolute);
      this.water.rebase();
      this.particles.rebase();
      this.events.emit('world:originRebased', {
        x: this.origin.absolute.x, y: this.origin.absolute.y, z: this.origin.absolute.z, shifts: this.origin.shifts,
      });
    });
    this.ui = new Interface(seed, hour, quality, context.backend, {
      seed: (value) => this.changeSeed(normalizeSeed(value)),
      randomSeed: () => this.changeSeed(randomSeed()),
      share: () => { void this.share(); },
      hour: (value) => { this.sky.setHour(value); this.sky.cycling = false; this.ui.syncTime(value, false); },
      cycle: (value) => { this.sky.cycling = value; },
      quality: (value) => this.setQuality(value),
      tour: () => { this.toggleTour(); this.ui.dismissIntro(); },
      reset: () => { this.respawnPlayer(); this.ui.dismissIntro(); },
      lock: () => { void this.input.lock(); },
      debug: (value) => { this.terrain.setDebug(value); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); },
      wireframe: (value) => this.terrain.setWireframe(value),
      biomeDebug: (value) => { this.terrain.setBiomeDebug(value); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); },
      vegetation: (value) => { this.vegetation.setEnabled(value); this.updateURL(); },
      roads: (value) => { this.roads.setEnabled(value); this.updateURL(); },
      objects: (value) => { this.objectsEnabled = value; this.objects.setEnabled(value); this.updateURL(); },
      water: (value) => { this.water.setEnabled(value); this.updateURL(); },
      weather: (value) => { this.weather.setOverride(value); this.updateURL(); },
      route: (value) => this.travelRoute(value),
      wind: (value) => this.vegetation.setWind(value),
      detail: (value) => this.terrain.material.setDetail(value),
      postfx: (value) => { this.post.setEnabled(value); this.updateURL(); },
      viewpoint: (value) => this.travelTo(value),
      stats: (value) => this.ui.showStats(value),
      physics: (value) => { this.world.setEnabled(value); this.updateURL(); },
      physicsDebug: (value) => { this.physicsDebug?.setVisible(value); },
      dropCrate: () => this.dropCrate(),
      mode: (value) => this.setMode(value),
      firstPerson: (value) => { this.character.setFirstPerson(value); this.ui.syncCamera(this.mode, this.character.isFirstPerson); },
      sensitivity: (value) => this.character.setSensitivity(value),
      shoulder: () => this.character.toggleShoulder(),
      respawn: () => this.respawnPlayer(),
    });
    this.ui.syncTime(hour, this.sky.cycling);
    this.ui.syncNature(this.vegetation.vegetationEnabled, this.vegetation.windEnabled, this.roads.roadsEnabled);
    this.ui.syncPost(this.post.isEnabled);
    this.ui.setPhysicsAvailable(false);
    this.ui.syncCamera(this.mode, this.character.isFirstPerson);
    this.ui.syncObjects(this.objects.objectsEnabled);
    this.ui.setPack(this.inventory.stacks());
    this.events.on('inventory:changed', ({ items }) => this.ui.setPack(items));
    this.events.on('object:stateChanged', () => { this.saveDirty = true; });
    this.events.on('inventory:changed', () => { this.saveDirty = true; });
    if (this.restoreNotice) this.ui.toast(this.restoreNotice);
    this.input.onShortcut = (code) => {
      if (code === 'F3') this.ui.showStats(!this.ui.statsVisible);
      if (code === 'KeyH') this.ui.toggleHUD();
      if (code === 'KeyL') { this.terrain.setDebug(!this.terrain.debug); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); }
      if (code === 'KeyB') { this.terrain.setBiomeDebug(!this.terrain.biomeDebug); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); }
      if (code === 'KeyE') this.interactPressed = true;
      if (code === 'KeyO') { this.objectsEnabled = !this.objectsEnabled; this.objects.setEnabled(this.objectsEnabled); this.ui.syncObjects(this.objectsEnabled); this.updateURL(); }
      if (code === 'KeyV') { this.vegetation.setEnabled(!this.vegetation.vegetationEnabled); this.ui.syncNature(this.vegetation.vegetationEnabled, this.vegetation.windEnabled, this.roads.roadsEnabled); this.updateURL(); }
      if (code === 'KeyT') { this.toggleTour(); this.ui.dismissIntro(); }
      if (code === 'KeyG') { if (this.rig.routeFollowing) this.rig.routeFollowing = false; else { const r = this.roads.routeAt(this.rig.position); this.rig.startRoute(r.corridor, r.station); } this.ui.dismissIntro(); this.updateURL(); }
      // Phase 4 keeps the developer physics sandbox on X; C is the Phase 5 view toggle.
      if (code === 'KeyK') { const debug = this.physicsDebug; if (debug) { debug.setVisible(!debug.visible); this.ui.syncPhysics(this.world.isEnabled, debug.visible); } }
      if (code === 'KeyX') this.dropCrate();
      if (code === 'KeyR') { if (this.mode === 'character') this.respawnPlayer(); else this.rig.reset(); }

      if (code === 'KeyJ') { this.water.setEnabled(!this.water.isEnabled); this.ui.syncWater(this.water.isEnabled, this.weather.overridden); }
      if (code === 'KeyN') {
        const kinds: (WeatherKind | null)[] = [null, 'clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'blizzard'];
        const next = kinds[(kinds.indexOf(this.weather.overridden) + 1) % kinds.length] ?? null;
        this.weather.setOverride(next);
        this.ui.syncWater(this.water.isEnabled, next);
        this.ui.toast(next ? `Weather pinned · ${next}` : 'Weather follows the front');
      }
      if (code === 'KeyP') { this.sky.cycling = !this.sky.cycling; this.ui.syncTime(this.sky.hour, this.sky.cycling); }
      if (code === 'KeyC') this.setMode(this.mode === 'character' ? 'survey' : 'character');
      if (code === 'KeyF') { this.character.toggleFirstPerson(); this.ui.syncCamera(this.mode, this.character.isFirstPerson); }
      if (code === 'KeyZ') this.character.toggleShoulder();
    };
    window.addEventListener('resize', () => { resizeRenderer(this.context, this.quality); this.rig.resize(); this.character.resize(); }, { signal: this.abort.signal });
    document.addEventListener('visibilitychange', () => { this.loop.reset(); this.input.clear(); }, { signal: this.abort.signal });
    context.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.fail(new Error('The graphics context was lost. Reload to restore the world.')); }, { signal: this.abort.signal });
    context.renderer.onDeviceLost = () => this.fail(new Error('The graphics device was lost. Close other GPU-heavy tabs and reload.'));
    window.addEventListener('pagehide', (event) => { if (!event.persisted) this.dispose(); }, { signal: this.abort.signal });
    this.updateURL();
  }

  static async create(host: HTMLElement): Promise<Game> {
    const params = new URLSearchParams(location.search);
    const seed = normalizeSeed(params.get('seed') || randomSeed());
    let quality: QualityName = 'ultra';
    try { const saved = localStorage.getItem('wayfarer.quality'); if (saved && saved in QUALITY) quality = saved as QualityName; } catch { /* Private browsing can deny storage. */ }
    if (matchMedia('(pointer: coarse)').matches && !params.has('quality')) quality = 'low';
    const requestedQuality = params.get('quality');
    if (requestedQuality && requestedQuality in QUALITY) quality = requestedQuality as QualityName;
    const hour = params.has('hour') && Number.isFinite(Number(params.get('hour'))) ? clamp(Number(params.get('hour')), 0, 23.99) : CONFIG.sky.initialHour;
    const coordinate = (key: string) => { const value = Number(params.get(key)); return params.has(key) && Number.isFinite(value) ? clamp(value, -1e12, 1e12) : 0; };
    const position = new Vector3(coordinate('x'), 450, coordinate('z'));
    const route = SCENIC_ROUTES.find((r) => r.id === params.get('route')) ?? (!params.has('x') && !params.has('z') ? SCENIC_ROUTES[0] : undefined);
    if (route) {
      const network = new RoadNetwork(seed, () => 0);
      const station = findRouteStation(seed, route.corridor, route.biome, route.station);
      const point = network.point(route.corridor, station);
      position.set(point.x, 450, point.z);
    } else if (!params.has('x') && !params.has('z')) {
      const vista = findBiomeViewpoint(seed, 1);
      position.set(vista.x, vista.y + 110, vista.z);
    }
    const context = await createRenderer(host, quality, params.get('renderer') === 'webgl');
    const game = new Game(context, seed, quality, hour, position);
    if (params.get('mode') === 'survey') game.mode = 'survey';
    if (route) { const station = findRouteStation(seed, route.corridor, route.biome, route.station); game.rig.startRoute(route.corridor, station); game.updateURL(); }
    // An external humanoid is optional; without one the labelled placeholder rig
    // is used, and a failed load keeps the game playable.
    const characterUrl = params.get('character');
    if (characterUrl) await game.character.loadAsset(characterUrl);
    game.ui.syncCamera(game.mode, game.character.isFirstPerson);
    game.ui.syncWater(game.water.isEnabled, game.weather.overridden);
    return game;
  }

  async start(): Promise<void> {
    // Physics loads in the background: the world must render even if the WASM
    // engine is unavailable (older browsers, blocked downloads, tight memory).
    void this.initPhysics();
    await this.context.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  private async initPhysics(): Promise<void> {
    if (new URLSearchParams(location.search).get('physics') === '0') {
      this.physicsError = 'disabled by URL';
      this.worldEvents.emit('physics:unavailable', { message: this.physicsError });
      return;
    }
    try {
      const physics = await PhysicsWorld.create({ origin: this.origin, events: this.worldEvents });
      if (this.disposed) { physics.dispose(); return; }
      const debug = new PhysicsDebugRenderer(physics);
      this.scene.add(debug.object);
      this.physics = physics;
      this.physicsDebug = debug;
      this.world.setPhysics(physics, new PhysicsGroundStreamer(physics, this.terrain), debug);
      this.ui.setPhysicsAvailable(true);
      this.ui.syncPhysics(this.world.isEnabled, debug.visible);
    } catch (error) {
      this.physicsError = error instanceof Error ? error.message : String(error);
      this.worldEvents.emit('physics:unavailable', { message: this.physicsError });
      console.warn('[Wayfarer physics]', this.physicsError);
      this.ui.setPhysicsAvailable(false);
      this.ui.toast('Physics unavailable — the world still streams normally');
    }
  }

  /** Active camera for rendering, sky and compilation. */
  private get activeCamera(): PerspectiveCamera {
    return this.mode === 'character' ? this.character.camera : this.rig.camera;
  }

  /** Canonical world position the streaming systems follow. */
  private resolveActivePosition(): Vector3 {
    if (this.mode === 'character' && this.character.ready) this.activePosition.copy(this.character.position);
    else this.activePosition.copy(this.rig.position);
    return this.activePosition;
  }

  /** Render whichever view is active; the character owns interpolation. */
  private renderActive(alpha: number, dt: number): void {
    if (this.mode === 'character' && this.character.ready) this.character.render(dt, alpha);
    else this.rig.render(alpha);
  }

  private frame(timestamp: number): void {
    if (this.disposed || document.hidden) return;
    try {
      this.loop.tick(timestamp, (dt) => {
        if (!this.ready) return;
        // Weather and the water surface are advanced on the fixed clock: buoyancy,
        // swimming and the wave phase must never depend on the render rate.
        this.stepEnvironment(dt);
        if (this.mode === 'character') this.character.fixedUpdate(dt);
        else this.rig.fixedUpdate(dt);
        this.stepWake(dt);
        this.propPhysics.step(dt, this.groundSample);
        this.updateInteraction(dt);
      }, (alpha, dt) => {
        const focus = this.resolveActivePosition();
        this.cameraWorld.copy(this.activeCamera.position).add(this.origin.absolute);
        this.world.update(dt, focus, this.cameraWorld);
        this.presentEnvironment(dt);
        if (!this.ready) {
          this.loadTime += dt;
          // Spawn as soon as the local grid exists; keep loading distant roots behind the overlay.
          this.rig.spawn();
          this.ui.setLoading(this.terrain.wanted ? this.terrain.ready / this.terrain.wanted : 0);
          if (this.terrain.wanted > 0 && this.terrain.ready === this.terrain.wanted && !this.compileStarted) {
            this.compileStarted = true;
            const version = this.resetVersion;
            this.renderActive(1, 0);
            this.sky.update(0, this.origin.toLocal(this.activePosition, this.localPosition), this.activeCamera);
            // Pipeline compilation completes before the loading screen is dismissed.
            void this.context.renderer.compileAsync(this.scene, this.activeCamera).then(() => {
              if (this.disposed || version !== this.resetVersion) return;
              this.ready = true;
              this.scene.userData.ready = true;
              this.world.setReady(true);
              this.worldEvents.emit('world:ready', { seed: this.seed, backend: this.context.backend, physics: !!this.physics });
              this.sky.update(0, this.origin.toLocal(this.activePosition, this.localPosition), this.activeCamera, true);
              this.ui.ready(this.context.backend);
              this.loop.reset();
              if (this.context.fallbackReason) this.ui.toast(`Using WebGL2 compatibility mode · ${this.context.backend}`);
            }).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
          }
          if (this.terrain.lastError) this.fail(this.terrain.lastError);
          if (this.loadTime > 90 && !this.compileStarted) this.fail(new Error('Terrain generation timed out. Try the Low graphics preset or reload.'));
        }
        this.renderActive(this.ready ? alpha : 1, dt);
        this.objects.update(dt, focus, this.origin.absolute, alpha);
        this.origin.toLocal(focus, this.localPosition);
        if (this.ready) this.sky.update(dt, this.localPosition, this.activeCamera);
        this.applyAtmosphere();
        this.context.renderer.info.reset();
        this.post.setCamera(this.activeCamera);
        this.post.render(this.scene, this.activeCamera);
        if (this.saveDirty && this.ready && timestamp - this.lastSave > 4000) this.flushSave(timestamp);
        const stats = this.terrain.stats;
        const vegetation = this.vegetation.stats;
        const roads = this.roads.stats;
        const worldStats = this.world.stats;
        const objects = this.objects.stats;
        const propPhysics = this.propPhysics.stats;
        const route = this.mode === 'survey' && this.rig.routeFollowing ? this.roads.routeAt(this.rig.position) : null;
        const biome = BIOMES[this.terrain.biomeAt(focus.x, focus.z)] ?? BIOMES[0];
        const character = this.character.snapshot();
        const heading = this.mode === 'character'
          ? ((-this.character.cameraRig.yaw * 180 / Math.PI) % 360 + 360) % 360
          : this.rig.heading;
        const lod = Array(6).fill(0) as number[];
        for (const mesh of this.terrain.group.children) {
          if (mesh.visible) {
            const level = Number(mesh.name.split(':')[0]!.replace('terrain ', ''));
            lod[level] = (lod[level] || 0) + 1;
          }
        }
        this.ui.update({
          x: focus.x, y: focus.y, z: focus.z,
          heading, time: this.sky.timeLabel, biome: biome.name,
          fps: this.loop.fps, calls: this.context.renderer.info.render.drawCalls,
          triangles: this.context.renderer.info.render.triangles,
          geometries: this.context.renderer.info.memory.geometries,
          cached: stats.cached, pending: stats.pending, shifts: this.origin.shifts,
          backend: this.context.backend, touring: this.mode === 'survey' && this.rig.touring,
          speed: this.mode === 'character' ? character.speed : this.rig.velocity.length(), lod,
          mode: this.mode, stance: character.stance, animation: character.animation,
          movement: character.mode, firstPerson: character.firstPerson,
          rigSource: character.rig.source, rigJoints: character.rig.joints, rigClips: character.rig.clips,
          vegetation: vegetation.instances, vegetationBatches: vegetation.batches, vegetationCapacity: vegetation.capacity,
          roadsEnabled: roads.roadsEnabled, roadTiles: roads.roadTiles, props: roads.props, propCapacity: roads.propCapacity,
          routeName: route ? `${route.name} · ${route.number}` : null, routeStation: route ? route.kilometre : null,
          objects: objects.active, objectBodies: propPhysics.bodies, objectSleeping: propPhysics.sleeping,
          inventoryItems: this.inventory.total, interactionTarget: this.interaction.targetId,
          progress: this.terrain.wanted ? this.terrain.ready / this.terrain.wanted : 0,
          physicsEnabled: this.world.isEnabled && !!this.physics,
          physicsBodies: worldStats.physics?.bodies ?? 0,
          physicsColliders: worldStats.physics?.colliders ?? 0,
          physicsStepMs: worldStats.physics?.stepMs ?? 0,
          physicsOverBudget: worldStats.physics?.overBudget ?? false,
          physicsGroundTiles: worldStats.ground?.tiles ?? 0,
          entityFull: worldStats.entities.full, entityReduced: worldStats.entities.reduced,
          entityBackground: worldStats.entities.background, entityDormant: worldStats.entities.dormant,
          physicsProps: worldStats.props,
          waterEnabled: this.water.isEnabled,
          waterTiles: worldStats.water?.tiles ?? 0,
          waterBodies: worldStats.water?.bodiesNear ?? 0,
          waterTriangles: worldStats.water?.triangles ?? 0,
          waterBudget: worldStats.water?.budget ?? 0,
          underwater: this.underwater,
          seaState: this.weather.state.seaState,
          weatherKind: this.weather.state.kind,
          weatherLabel: this.weather.state.label,
          weatherPinned: this.weather.overridden,
          rain: this.weather.state.rain,
          snow: this.weather.state.snow,
          wetness: this.weather.state.wetness,
          snowCover: this.weather.state.snowCover,
          windSpeed: this.weather.state.windSpeed,
          particles: this.particles.stats.active,
          particleCapacity: this.particles.stats.capacity,
          bodiesInWater: this.buoyancy.stats.bodiesInWater,
          floatingBodies: this.buoyancy.stats.floating,
        }, timestamp);
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  /**
   * Swimming wake: a swimmer moving through the water trails small splashes. This
   * runs on the fixed clock and is rate-limited by distance and time, so the pool
   * budget is never spent on a stationary swimmer.
   */
  private stepWake(dt: number): void {
    if (this.mode !== 'character' || !this.character.swimming) { this.wakeTimer = 0; return; }
    this.wakeTimer -= dt;
    if (this.wakeTimer > 0) return;
    const position = this.character.position;
    const moving = this.character.controllerSpeed > 0.8;
    this.wakeTimer = moving ? 0.22 : 0.9;
    const surface = this.water.surfaceAt(position.x, position.z, this.simTime);
    if (surface === undefined) return;
    this.particles.splash(position.x, surface, position.z, {
      strength: moving ? 0.32 : 0.16,
      spray: true,
    });
  }

  /**
   * Fixed-step environment: the weather front and the sea state the physics reads.
   * Runs before the character and props so a body entering water this step sees
   * the same surface elevation the renderer will draw.
   */
  private stepEnvironment(dt: number): void {
    if (!this.weather || !this.queries) return;
    this.simTime += dt;
    const focus = this.resolveActivePosition();
    const climate = this.queries.climateAt(focus.x, focus.z);
    const weather = this.weather.update(dt, this.sky.hour, focus.x, focus.z, {
      temperature: climate.temperature,
      moisture: climate.moisture,
      height: this.queries.height(focus.x, focus.z),
    });
    this.queries.field.water.setActivity(weather.seaState);
    if (weather.kind !== this.weatherKind) {
      const previous = this.weatherKind;
      this.weatherKind = weather.kind;
      this.events.emit('world:weatherChanged', { kind: weather.kind, label: weather.label, previous });
      if (previous === 'clear' && weather.kind !== 'clear') {
        this.ui?.toast(`Weather turning · ${weather.label.toLowerCase()}`);
      }
    }
  }

  /** Per-frame presentation: sky, water shading, precipitation and splash state. */
  private presentEnvironment(dt: number): void {
    if (!this.weather || !this.water) return;
    const state = this.weather.state;
    this.sky.setWeather(state);
    this.weather.windVector(this.wind);
    this.water.material.setActivity(state.seaState);
    this.water.material.setRain(state.rain);
    this.water.material.setWind(this.wind.x * 0.35, this.wind.z * 0.35);
    this.water.material.setSun(this.sky.sunDirection, this.sky.sun.color, this.sky.sun.intensity);
    this.particles.setPrecipitation(state.rain, state.snow);
    this.particles.update(dt, this.cameraWorld, this.wind.x, this.wind.z);
    this.underwater = this.water.isUnderwater;
    // The sky is hidden from below the waterline; the surface and fog take over.
    this.sky.group.visible = !this.underwater;
  }

  /**
   * Atmosphere: fog follows the weather's visibility, and the camera going under
   * the surface switches to a short, tinted water fog. One place decides this, so
   * the fog can never disagree with the wave surface the player is inside.
   */
  private applyAtmosphere(): void {
    const fog = this.scene.fog as Fog;
    const viewDistance = QUALITY[this.quality].viewDistance;
    if (this.underwater) {
      const water = CONFIG.water.underwater;
      fog.color.setRGB(water.tintR, water.tintG, water.tintB);
      fog.near = 0.2;
      fog.far = Math.max(18, viewDistance * water.fogScale);
      return;
    }
    fog.color.copy(this.sky.horizon);
    const scale = this.weather?.state.fogScale ?? 1;
    fog.far = viewDistance * scale;
    fog.near = fog.far * 0.36;
  }

  /**
   * Swap views without moving the player. Switching to the survey rig drops it at
   * the player's position; switching back respawns the character where the rig is
   * standing, so neither view teleports across the world.
   */
  private setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    if (mode === 'survey') {
      this.rig.position.copy(this.character.ready ? this.character.position : this.rig.position);
      this.rig.previous.copy(this.rig.position);
      this.rig.velocity.set(0, 0, 0);
      this.rig.spawned = false;
      this.rig.routeFollowing = false;
      this.rig.touring = false;
    } else {
      this.character.spawnAt(this.rig.position.x, this.rig.position.z);
    }
    this.mode = mode;
    this.input.clear();
    this.ui.syncCamera(this.mode, this.character.isFirstPerson);
    this.ui.toast(mode === 'character' ? 'On foot — WASD to move, Space to jump, C for the survey camera' : 'Survey camera — WASD flies, C returns to the character');
    this.updateURL();
  }

  /** Return the player to the current spawn point without regenerating the world. */
  private respawnPlayer(): void {
    if (this.mode !== 'character') this.setMode('character');
    this.character.respawn();
    this.origin.update(this.character.position);
    this.ui.toast('Returned to the trailhead');
  }

  /**
   * Build the gameplay layer (world queries, prop physics, inventory,
   * interaction, streamed objects) for a seed. Rebuilt on seed change so every
   * system holds queries for exactly one world.
   */
  private buildGameplayLayer(seed: string): void {
    const restored = this.store.load(seed);
    let saved: PersistedObjects = {};
    let inventory: readonly ItemStack[] = [];
    if (restored.status === 'ok') {
      saved = restored.save.objects;
      inventory = restored.save.inventory;
    } else if (restored.status === 'invalid') {
      console.warn('[Wayfarer] object save ignored:', restored.reason);
      this.restoreNotice = `Saved world state was ignored: ${restored.reason}`;
    }
    this.inventory = new Inventory(this.events);
    if (inventory.length > 0) this.inventory.restore(inventory);
    this.queries = new WorldQueries(seed);
    // One water field per world: terrain carving (workers use their own instance
    // of the same deterministic field), queries, rendering and physics all read it.
    const waterField = this.queries.field.water;
    this.water = new WaterManager(waterField, this.origin, this.quality);
    this.buoyancy = new BuoyancySolver(waterField);
    this.weather = new WeatherSystem(seed, { override: this.weatherOverrideFromURL() });
    this.particles = new ParticleSystem(this.origin, QUALITY[this.quality].particleBudget);
    this.particles.setColliders(
      (x, z) => this.queries.height(x, z),
      (x, z) => waterField.sampleAt(x, z)?.surfaceY,
    );
    this.propPhysics = new PropPhysicsWorld({ maxBodies: QUALITY[this.quality].physicsBodies, fixedStep: CONFIG.physics.fixedStep });
    this.interaction = new InteractionManager({
      inventory: this.inventory,
      physics: this.propPhysics,
      queries: this.queries,
      events: this.events,
      notify: (message) => { this.ui?.toast(message); },
    }, {
      maxRange: CONFIG.objects.interactionRange,
      coneRadians: (CONFIG.objects.coneDegrees * Math.PI) / 180,
      proximityRadius: 2.3,
    });
    this.objects = new ObjectSystem({
      seed,
      queries: this.queries,
      physics: this.propPhysics,
      events: this.events,
      inventory: this.inventory,
      interaction: this.interaction,
      notify: (message) => { this.ui?.toast(message); },
      budget: QUALITY[this.quality].objectBudget,
      savedState: saved,
    });
    this.objects.setEnabled(this.objectsEnabled);
    this.attachWaterForces();
  }

  /**
   * Prop bodies get their water forces from the shared solver, applied inside the
   * prop solver's own substep loop. Re-attached whenever the gameplay layer is
   * rebuilt for a new seed/quality.
   */
  private attachWaterForces(): void {
    const solver = this.buoyancy;
    const time = () => this.simTime;
    this.propPhysics.forceField = (body, dt) => solver.applyToPropBody(body, dt, time());
    // A prop that crosses the waterline throws a splash scaled by impact speed.
    solver.onEntry = (entry) => {
      const strength = Math.min(2.2, 0.35 + entry.speed * 0.3);
      this.particles?.splash(entry.x, entry.y, entry.z, { strength });
      this.events.emit('world:propEnteredWater', {
        id: entry.id, bodyId: entry.bodyId, x: entry.x, y: entry.y, z: entry.z, speed: entry.speed,
      });
    };
  }

  /** `?weather=fog` pins a condition; any other value lets the front roam. */
  private weatherOverrideFromURL(): WeatherKind | null {
    const value = new URLSearchParams(location.search).get('weather');
    if (!value || value === 'auto') return null;
    const kinds: WeatherKind[] = ['clear', 'partly-cloudy', 'cloudy', 'overcast', 'rain', 'heavy-rain', 'storm', 'fog', 'snow', 'blizzard', 'windy'];
    return kinds.includes(value as WeatherKind) ? value as WeatherKind : null;
  }

  /** Character events that water owns: splashes and the entry/exit events. */
  private handleCharacterEvent(event: { type: string }): void {
    if (event.type === 'character/water-entered') {
      const position = this.character.position;
      this.particles?.splash(position.x, position.y + 0.4, position.z, { strength: 1.4 });
      const sample = this.queries?.field.water.sampleAt(position.x, position.z);
      this.events.emit('player:enteredWater', { x: position.x, y: position.y, z: position.z });
      if (sample) this.events.emit('world:waterEntered', { bodyId: sample.bodyId, kind: sample.kind, x: position.x, y: position.y, z: position.z });
    } else if (event.type === 'character/water-exited') {
      const position = this.character.position;
      this.particles?.splash(position.x, position.y + 0.2, position.z, { strength: 0.7, spray: true });
      this.events.emit('player:exitedWater', { x: position.x, y: position.y, z: position.z });
    }
  }

  /** Swap the whole gameplay layer when the world seed changes. */
  private rebuildGameplayLayer(seed: string): void {
    this.saveDirty = false;
    this.interaction.clear();
    this.propPhysics.clear();
    this.objects.dispose();
    this.water?.dispose();
    this.particles?.dispose();
    this.buildGameplayLayer(seed);
    this.scene.add(this.water.group, this.particles.group);
    // Swimming must follow the new world's hydrology, not the previous field.
    if (this.character) this.character.setWater(this.water.swimQuery);
    this.world.setWater(this.water);
    this.world.setBuoyancy(this.buoyancy);
    // The world manager and the physics hooks hold no stale water references.
    this.world.setWater(this.water);
    this.world.setBuoyancy(this.buoyancy);
    // Swimming must follow the new world's hydrology, not the previous field.
    this.character?.setWater(this.water.swimQuery);
    this.scene.add(this.objects.group);
    this.ui.syncObjects(this.objects.objectsEnabled);
    this.ui.setPack(this.inventory.stacks());
    this.ui.setPrompt(null);
  }

  /**
   * Fixed-step interaction pass: aim, prompt, hold-to-confirm, dispatch.
   * The aiming actor is whoever is looking: the character on foot, the survey
   * rig while flying, so a prompt always matches the camera that produced it.
   */
  private updateInteraction(dt: number): void {
    const onFoot = this.mode === 'character' && this.character.ready;
    const position = onFoot ? this.character.position : this.rig.position;
    const yaw = onFoot ? this.character.cameraRig.yaw : this.rig.yaw;
    const pitch = onFoot ? this.character.cameraRig.pitch : this.rig.pitch;
    const eye = onFoot ? CONFIG.character.eyeHeight : 0;
    const cosPitch = Math.cos(pitch);
    this.actor.position.x = position.x;
    this.actor.position.y = position.y + eye;
    this.actor.position.z = position.z;
    this.actor.forward.x = -Math.sin(yaw) * cosPitch;
    this.actor.forward.y = Math.sin(pitch);
    this.actor.forward.z = -Math.cos(yaw) * cosPitch;
    this.actor.yaw = yaw;
    const pressed = this.interactPressed;
    this.interactPressed = false;
    const prompt = this.interaction.update(dt, this.actor, { pressed, down: this.input.down('KeyE') });
    this.ui.setPrompt(prompt);
    this.objects.focusTarget(this.interaction.targetId);
  }

  /** Persist only the object/inventory diff; never overwrite an unknown format. */
  private flushSave(timestamp = 0): void {
    if (!this.objects) return;
    const result = this.store.save(this.seed, this.objects.serializeState(), this.inventory.stacks());
    this.saveDirty = false;
    this.lastSave = timestamp;
    if (result.status === 'ok') return;
    console.warn('[Wayfarer] object save skipped:', result.reason);
    if (result.status === 'refused') this.ui?.toast(`Save not written: ${result.reason}`);
  }

  private toggleTour(): void {
    if (this.rig.routeFollowing || this.rig.touring) { this.rig.routeFollowing = false; this.rig.touring = false; }
    else this.rig.touring = true;
    this.updateURL();
  }

  /**
   * Developer sandbox: spawn a real rigid body in front of the survey camera.
   * Used to prove terrain physics, contact response and origin rebasing in-app.
   */
  private dropCrate(): void {
    if (!this.physics || !this.world.isReady) { this.ui.toast('Physics is still initialising'); return; }
    // Drop in front of whatever the player is looking through: the character on
    // foot, the survey rig while flying.
    const onFoot = this.mode === 'character' && this.character.ready;
    const from = onFoot ? this.character.position : this.rig.position;
    const yaw = onFoot ? this.character.cameraRig.yaw : this.rig.yaw;
    const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const position = from.clone().addScaledVector(forward, 7);
    const ground = this.world.query.heightAt(position.x, position.z);
    position.y = (ground ?? from.y) + 7;
    if (!this.world.spawnCrate(position)) { this.ui.toast('Test prop budget reached'); return; }
    this.ui.toast(`Dropped test crate · ${this.world.sandboxPropCount} active`);
  }

  private beginLoading(): void {
    this.ready = false; this.compileStarted = false; this.loadTime = 0;
    this.world.setReady(false);
    this.resetVersion++;
    this.scene.userData.ready = false;
    this.input.clear(); this.ui.beginLoading(); this.loop.reset();
  }

  private changeSeed(seed: string): void {
    this.beginLoading();
    this.seed = seed;
    this.origin.reset();
    this.terrain.reset(seed, this.quality);
    this.vegetation.reset();
    this.roads.reset(seed);
    this.world.reset();
    this.sky.reseed(seed);
    this.rebuildGameplayLayer(seed);
    const cedar = SCENIC_ROUTES[0]!;
    const station = findRouteStation(seed, cedar.corridor, cedar.biome, cedar.station);
    const point = this.roads.point(cedar.corridor, station);
    this.rig.home.set(point.x, 450, point.z);
    this.rig.startRoute(cedar.corridor, station);
    this.character.spawnAt(point.x, point.z);
    this.ui.setSeed(seed);
    this.updateURL();
  }

  private setQuality(quality: QualityName): void {
    if (quality === this.quality) return;
    this.beginLoading();
    this.quality = quality;
    this.terrain.reset(this.seed, quality);
    this.vegetation.setQuality(quality);
    this.roads.setQuality(quality);
    this.sky.setQuality(quality);
    this.post.setQuality(quality);
    this.objects.setQuality(quality);
    this.water.setQuality(quality);
    this.propPhysics.setCapacity(QUALITY[quality].physicsBodies);
    this.ui.syncPost(this.post.isEnabled);
    this.ui.syncCamera(this.mode, this.character.isFirstPerson);
    this.ui.syncObjects(this.objects.objectsEnabled);
    this.ui.setPack(this.inventory.stacks());
    this.ui.syncPhysics(this.world.isEnabled, this.world.debugVisible);
    resizeRenderer(this.context, quality);
    const fog = this.scene.fog as Fog;
    fog.near = QUALITY[quality].viewDistance * 0.36; fog.far = QUALITY[quality].viewDistance;
    try { localStorage.setItem('wayfarer.quality', quality); } catch { /* Storage is optional. */ }
    this.updateURL();
  }

  private travelRoute(id: string): void {
    const route = SCENIC_ROUTES.find((r) => r.id === id);
    if (!route) return;
    this.beginLoading();
    const station = findRouteStation(this.seed, route.corridor, route.biome, route.station);
    this.rig.startRoute(route.corridor, station);
    this.origin.update(this.rig.position);
    this.vegetation.rebase();
    // A route survey is a camera tool; the character inherits the same station so
    // pressing C puts the player on that road instead of stranding them.
    this.character.spawnAt(this.rig.position.x, this.rig.position.z);
    this.mode = 'survey';
    this.ui.syncCamera(this.mode, this.character.isFirstPerson);
    this.objects.rebase(this.origin.absolute);
    this.ui.toast(`Route survey · ${route.name}`);
    this.updateURL();
  }

  private travelTo(biome: BiomeId): void {
    const radius = biome >= 3 ? 9000 : 6000;
    const from = this.resolveActivePosition();
    const vista = findBiomeViewpoint(this.seed, biome, from.x, from.z, radius);
    this.beginLoading();
    this.rig.position.set(vista.x, vista.y + 110, vista.z);
    this.rig.previous.copy(this.rig.position);
    this.rig.velocity.set(0, 0, 0);
    this.rig.spawned = false;
    this.rig.touring = this.mode === 'survey';
    this.rig.routeFollowing = false;
    this.character.spawnAt(vista.x, vista.z);
    this.origin.update(this.rig.position);
    this.vegetation.rebase();
    this.objects.rebase(this.origin.absolute);
    this.ui.toast(`Travelling to ${BIOMES[biome].name.toLowerCase()}`);
    this.updateURL();
  }

  private updateURL(): void {
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    const focus = this.resolveActivePosition();
    url.searchParams.set('x', focus.x.toFixed(1));
    url.searchParams.set('z', focus.z.toFixed(1));
    url.searchParams.set('hour', this.sky.hour.toFixed(2));
    url.searchParams.set('quality', this.quality);
    url.searchParams.set('vegetation', this.vegetation.vegetationEnabled ? '1' : '0');
    url.searchParams.set('roads', this.roads.roadsEnabled ? '1' : '0');
    url.searchParams.set('objects', this.objectsEnabled ? '1' : '0');
    if (this.water) url.searchParams.set('water', this.water.isEnabled ? '1' : '0');
    if (this.weather?.overridden) url.searchParams.set('weather', this.weather.overridden);
    else url.searchParams.delete('weather');
    if (this.rig.routeFollowing) { const route = SCENIC_ROUTES.find((r) => r.corridor === this.rig.routeCorridor); if (route) url.searchParams.set('route', route.id); else url.searchParams.delete('route'); } else url.searchParams.delete('route');
    url.searchParams.set('postfx', this.post.isEnabled ? '1' : '0');
    if (this.world.isEnabled) url.searchParams.delete('physics'); else url.searchParams.set('physics', '0');
    url.searchParams.set('mode', this.mode);
    history.replaceState(null, '', url);
  }

  private async share(): Promise<void> {
    this.updateURL();
    try { await navigator.clipboard.writeText(location.href); this.ui.toast('World link copied — seed, location, time and quality included'); }
    catch { this.ui.toast('Copy the address bar to share this exact world and viewpoint'); }
  }

  private fail(error: Error): void {
    console.error('[Wayfarer]', error);
    this.ready = false;
    void this.context.renderer.setAnimationLoop(null);
    // Runtime WebGPU failure: fall back once to WebGL2, preserving the shared URL.
    if (this.context.backend === 'WebGPU') {
      try {
        if (!sessionStorage.getItem('wayfarer.webgpu-failed')) {
          sessionStorage.setItem('wayfarer.webgpu-failed', '1');
          this.updateURL();
          const url = new URL(location.href);
          url.searchParams.set('renderer', 'webgl');
          location.replace(url);
          return;
        }
      } catch { /* Storage may be unavailable; show the error instead. */ }
    }
    this.ui?.fatal(error.message);
  }

  /** Test/inspection hook. Read-only snapshots; no production cheats or hidden UI. */
  snapshot() {
    const focus = this.resolveActivePosition();
    return { ready: this.ready, seed: this.seed, backend: this.context.backend,
      mode: this.mode, character: this.character.snapshot(),
      characterPosition: this.character.position.toArray(),
      position: focus.toArray(), origin: this.origin.absolute.toArray(),
      shifts: this.origin.shifts, hour: this.sky.hour, ...this.terrain.stats,
      quality: this.quality, biome: BIOMES[this.terrain.biomeAt(focus.x, focus.z)]!.name,
      biomeDebug: this.terrain.biomeDebug, vegetationEnabled: this.vegetation.vegetationEnabled,
      windEnabled: this.vegetation.windEnabled, detailEnabled: this.terrain.material.detailEnabled, postfxEnabled: this.post.isEnabled, vegetation: this.vegetation.stats,
      roads: this.roads.stats, world: this.world.stats,
      routeFollowing: this.rig.routeFollowing, route: this.rig.routeFollowing ? this.roads.routeAt(this.rig.position) : null,
      objects: { ...this.objects.stats, list: this.objects.list() },
      physics: this.propPhysics.stats,
      water: { ...this.water.stats, seaState: this.queries.field.water.seaState, bodies: this.queries.field.water.cachedBasins },
      weather: this.weather.snapshot(),
      particles: this.particles.stats,
      buoyancy: this.buoyancy.stats,
      underwater: this.underwater,
      inventory: { stacks: this.inventory.stacks(), total: this.inventory.total },
      interaction: { targetId: this.interaction.targetId, prompt: this.interaction.currentPrompt, providers: this.interaction.providerCount },
      objectsEnabled: this.objectsEnabled,
      touring: this.rig.touring, speed: this.rig.velocity.length(),
      fps: this.loop.fps, drawCalls: this.context.renderer.info.render.drawCalls,
      gpuBytes: this.context.renderer.info.memory.total };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(); this.unsubscribeOrigin();
    void this.context.renderer.setAnimationLoop(null);
    if (this.saveDirty) this.flushSave();
    this.input.dispose(); this.ui.dispose(); this.world.dispose();
    this.physicsDebug?.dispose();
    this.physics?.dispose();
    this.character.dispose(); this.terrain.dispose(); this.vegetation.dispose(); this.roads.dispose(); this.sky.dispose(); this.post.dispose();
    this.objects.dispose(); this.interaction.clear(); this.propPhysics.clear(); this.events.clear();
    this.water.dispose(); this.particles.dispose();
    clearObjectGeometryCache();
    this.context.renderer.dispose(); this.context.canvas.remove();
  }
}

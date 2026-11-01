import { Scene, Fog, Vector3 } from 'three/webgpu';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import { createRenderer, resizeRenderer } from '../rendering/renderer';
import { PostProcessing } from '../rendering/post-processing';
import type { RenderingContext } from '../rendering/renderer';
import { FloatingOrigin } from './floating-origin';
import { FixedLoop } from './fixed-loop';
import { Input } from './input';
import { SurveyCamera } from './survey-camera';
import { TerrainManager } from '../world/terrain-manager';
import { VegetationManager } from '../world/vegetation-manager';
import { RoadManager } from '../world/road-manager';
import { SCENIC_ROUTES, RoadNetwork } from '../world/road-network';
import { BIOMES } from '../world/biomes';
import type { BiomeId } from '../world/biomes';
import { findBiomeViewpoint, findRouteStation } from '../world/viewpoints';
import { SkySystem } from '../world/sky';
import { Interface } from '../ui/interface';
import { normalizeSeed, randomSeed } from '../utils/random';
import { clamp } from '../utils/math';
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
  private readonly sky: SkySystem;
  private readonly post: PostProcessing;
  private readonly ui: Interface;
  private readonly abort = new AbortController();
  private readonly unsubscribeOrigin: () => void;
  private quality: QualityName;
  private seed: string;
  private ready = false;
  private disposed = false;
  private compileStarted = false;
  private resetVersion = 0;
  private loadTime = 0;
  private readonly localPosition = new Vector3();
  /** Typed game-event layer shared by objects, interaction, audio and missions. */
  private readonly events = new GameEventBus();
  private readonly store = new ObjectStateStore();
  private inventory!: Inventory;
  private queries!: WorldQueries;
  private physics!: PropPhysicsWorld;
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
    this.scene.name = 'Wayfarer / Phase 3';
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
    this.rig = new SurveyCamera(this.input, this.origin, this.terrain, this.roads);
    this.rig.position.copy(position); this.rig.previous.copy(position); this.rig.home.copy(position);
    this.origin.update(position);
    this.sky = new SkySystem(context.renderer, this.scene, seed, quality);
    this.sky.setHour(hour);
    this.post = new PostProcessing(context.renderer, this.scene, this.rig.camera, quality);
    const postParam = new URLSearchParams(location.search).get('postfx');
    if (postParam !== null) this.post.setEnabled(postParam !== '0');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.sky.cycling = false; this.rig.touring = false; }
    this.scene.add(this.terrain.group, this.vegetation.group, this.roads.group, this.objects.group);
    this.unsubscribeOrigin = this.origin.onChange((delta) => {
      this.terrain.rebase(delta);
      this.vegetation.rebase();
      this.roads.rebase(delta);
      this.objects.rebase(this.origin.absolute);
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
      reset: () => { this.rig.reset(); this.ui.dismissIntro(); },
      lock: () => { void this.input.lock(); },
      debug: (value) => { this.terrain.setDebug(value); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); },
      wireframe: (value) => this.terrain.setWireframe(value),
      biomeDebug: (value) => { this.terrain.setBiomeDebug(value); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); },
      vegetation: (value) => { this.vegetation.setEnabled(value); this.updateURL(); },
      roads: (value) => { this.roads.setEnabled(value); this.updateURL(); },
      objects: (value) => { this.objectsEnabled = value; this.objects.setEnabled(value); this.updateURL(); },
      route: (value) => this.travelRoute(value),
      wind: (value) => this.vegetation.setWind(value),
      detail: (value) => this.terrain.material.setDetail(value),
      postfx: (value) => { this.post.setEnabled(value); this.updateURL(); },
      viewpoint: (value) => this.travelTo(value),
      stats: (value) => this.ui.showStats(value),
    });
    this.ui.syncTime(hour, this.sky.cycling);
    this.ui.syncNature(this.vegetation.vegetationEnabled, this.vegetation.windEnabled, this.roads.roadsEnabled);
    this.ui.syncPost(this.post.isEnabled);
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
      if (code === 'KeyR') this.rig.reset();
      if (code === 'KeyP') { this.sky.cycling = !this.sky.cycling; this.ui.syncTime(this.sky.hour, this.sky.cycling); }
    };
    window.addEventListener('resize', () => { resizeRenderer(this.context, this.quality); this.rig.resize(); }, { signal: this.abort.signal });
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
    if (route) { const station = findRouteStation(seed, route.corridor, route.biome, route.station); game.rig.startRoute(route.corridor, station); game.updateURL(); }
    return game;
  }

  async start(): Promise<void> {
    await this.context.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  private frame(timestamp: number): void {
    if (this.disposed || document.hidden) return;
    try {
      this.loop.tick(timestamp, (dt) => {
        if (!this.ready) return;
        this.rig.fixedUpdate(dt);
        this.physics.step(dt, this.groundSample);
        this.updateInteraction(dt);
      }, (alpha, dt) => {
        this.terrain.update(this.rig.position, dt);
        this.vegetation.update(this.rig.position, dt);
        this.roads.update(this.rig.position, dt);
        if (!this.ready) {
          this.loadTime += dt;
          // Spawn as soon as the local grid exists; keep loading distant roots behind the overlay.
          this.rig.spawn();
          this.ui.setLoading(this.terrain.wanted ? this.terrain.ready / this.terrain.wanted : 0);
          if (this.terrain.wanted > 0 && this.terrain.ready === this.terrain.wanted && !this.compileStarted) {
            this.compileStarted = true;
            const version = this.resetVersion;
            this.rig.render(1);
            this.sky.update(0, this.origin.toLocal(this.rig.position, this.localPosition), this.rig.camera);
            // Pipeline compilation completes before the loading screen is dismissed.
            void this.context.renderer.compileAsync(this.scene, this.rig.camera).then(() => {
              if (this.disposed || version !== this.resetVersion) return;
              this.ready = true;
              this.scene.userData.ready = true;
              this.sky.update(0, this.origin.toLocal(this.rig.position, this.localPosition), this.rig.camera, true);
              this.ui.ready(this.context.backend);
              this.loop.reset();
              if (this.context.fallbackReason) this.ui.toast(`Using WebGL2 compatibility mode · ${this.context.backend}`);
            }).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
          }
          if (this.terrain.lastError) this.fail(this.terrain.lastError);
          if (this.loadTime > 90 && !this.compileStarted) this.fail(new Error('Terrain generation timed out. Try the Low graphics preset or reload.'));
        }
        this.rig.render(this.ready ? alpha : 1);
        this.objects.update(dt, this.rig.position, this.origin.absolute, alpha);
        this.origin.toLocal(this.rig.position, this.localPosition);
        if (this.ready) this.sky.update(dt, this.localPosition, this.rig.camera);
        const fog = this.scene.fog as Fog;
        fog.color.copy(this.sky.horizon);
        this.context.renderer.info.reset();
        this.post.render(this.scene, this.rig.camera);
        if (this.saveDirty && this.ready && timestamp - this.lastSave > 4000) this.flushSave(timestamp);
        const stats = this.terrain.stats;
        const vegetation = this.vegetation.stats;
        const roads = this.roads.stats;
        const objects = this.objects.stats;
        const physics = this.physics.stats;
        const route = this.rig.routeFollowing ? this.roads.routeAt(this.rig.position) : null;
        const biome = BIOMES[this.terrain.biomeAt(this.rig.position.x, this.rig.position.z)] ?? BIOMES[0];
        const lod = Array(6).fill(0) as number[];
        for (const mesh of this.terrain.group.children) {
          if (mesh.visible) {
            const level = Number(mesh.name.split(':')[0]!.replace('terrain ', ''));
            lod[level] = (lod[level] || 0) + 1;
          }
        }
        this.ui.update({
          x: this.rig.position.x, y: this.rig.position.y, z: this.rig.position.z,
          heading: this.rig.heading, time: this.sky.timeLabel, biome: biome.name,
          fps: this.loop.fps, calls: this.context.renderer.info.render.drawCalls,
          triangles: this.context.renderer.info.render.triangles,
          geometries: this.context.renderer.info.memory.geometries,
          cached: stats.cached, pending: stats.pending, shifts: this.origin.shifts,
          backend: this.context.backend, touring: this.rig.touring, speed: this.rig.velocity.length(), lod,
          vegetation: vegetation.instances, vegetationBatches: vegetation.batches, vegetationCapacity: vegetation.capacity,
          roadsEnabled: roads.roadsEnabled, roadTiles: roads.roadTiles, props: roads.props, propCapacity: roads.propCapacity,
          routeName: route ? `${route.name} · ${route.number}` : null, routeStation: route ? route.kilometre : null,
          objects: objects.active, objectBodies: physics.bodies, objectSleeping: physics.sleeping,
          inventoryItems: this.inventory.total, interactionTarget: this.interaction.targetId,
          progress: this.terrain.wanted ? this.terrain.ready / this.terrain.wanted : 0,
        }, timestamp);
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
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
    this.physics = new PropPhysicsWorld({ maxBodies: QUALITY[this.quality].physicsBodies, fixedStep: CONFIG.physics.fixedStep });
    this.interaction = new InteractionManager({
      inventory: this.inventory,
      physics: this.physics,
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
      physics: this.physics,
      events: this.events,
      inventory: this.inventory,
      interaction: this.interaction,
      notify: (message) => { this.ui?.toast(message); },
      budget: QUALITY[this.quality].objectBudget,
      savedState: saved,
    });
    this.objects.setEnabled(this.objectsEnabled);
  }

  /** Swap the whole gameplay layer when the world seed changes. */
  private rebuildGameplayLayer(seed: string): void {
    this.saveDirty = false;
    this.interaction.clear();
    this.physics.clear();
    this.objects.dispose();
    this.buildGameplayLayer(seed);
    this.scene.add(this.objects.group);
    this.ui.syncObjects(this.objects.objectsEnabled);
    this.ui.setPack(this.inventory.stacks());
    this.ui.setPrompt(null);
  }

  /** Fixed-step interaction pass: aim, prompt, hold-to-confirm, dispatch. */
  private updateInteraction(dt: number): void {
    const cosPitch = Math.cos(this.rig.pitch);
    this.actor.position.x = this.rig.position.x;
    this.actor.position.y = this.rig.position.y;
    this.actor.position.z = this.rig.position.z;
    this.actor.forward.x = -Math.sin(this.rig.yaw) * cosPitch;
    this.actor.forward.y = Math.sin(this.rig.pitch);
    this.actor.forward.z = -Math.cos(this.rig.yaw) * cosPitch;
    this.actor.yaw = this.rig.yaw;
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

  private beginLoading(): void {
    this.ready = false; this.compileStarted = false; this.loadTime = 0;
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
    this.sky.reseed(seed);
    this.rebuildGameplayLayer(seed);
    const vista = findBiomeViewpoint(seed, 1);
    this.rig.home.set(vista.x, vista.y + 110, vista.z);
    this.rig.reset();
    const cedar = SCENIC_ROUTES[0]!;
    const station = findRouteStation(seed, cedar.corridor, cedar.biome, cedar.station);
    const point = this.roads.point(cedar.corridor, station);
    this.rig.home.set(point.x, 450, point.z);
    this.rig.startRoute(cedar.corridor, station);
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
    this.physics.setCapacity(QUALITY[quality].physicsBodies);
    this.ui.syncPost(this.post.isEnabled);
    this.ui.syncObjects(this.objects.objectsEnabled);
    this.ui.setPack(this.inventory.stacks());
    this.events.on('inventory:changed', ({ items }) => this.ui.setPack(items));
    this.events.on('object:stateChanged', () => { this.saveDirty = true; });
    this.events.on('inventory:changed', () => { this.saveDirty = true; });
    if (this.restoreNotice) this.ui.toast(this.restoreNotice);
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
    this.objects.rebase(this.origin.absolute);
    this.ui.toast(`Route survey · ${route.name}`);
    this.updateURL();
  }

  private travelTo(biome: BiomeId): void {
    const radius = biome >= 3 ? 9000 : 6000;
    const vista = findBiomeViewpoint(this.seed, biome, this.rig.position.x, this.rig.position.z, radius);
    this.beginLoading();
    this.rig.position.set(vista.x, vista.y + 110, vista.z);
    this.rig.previous.copy(this.rig.position);
    this.rig.velocity.set(0, 0, 0);
    this.rig.spawned = false;
    this.rig.touring = true;
    this.rig.routeFollowing = false;
    this.origin.update(this.rig.position);
    this.vegetation.rebase();
    this.objects.rebase(this.origin.absolute);
    this.ui.toast(`Travelling to ${BIOMES[biome].name.toLowerCase()}`);
    this.updateURL();
  }

  private updateURL(): void {
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('x', this.rig.position.x.toFixed(1));
    url.searchParams.set('z', this.rig.position.z.toFixed(1));
    url.searchParams.set('hour', this.sky.hour.toFixed(2));
    url.searchParams.set('quality', this.quality);
    url.searchParams.set('vegetation', this.vegetation.vegetationEnabled ? '1' : '0');
    url.searchParams.set('roads', this.roads.roadsEnabled ? '1' : '0');
    url.searchParams.set('objects', this.objectsEnabled ? '1' : '0');
    if (this.rig.routeFollowing) { const route = SCENIC_ROUTES.find((r) => r.corridor === this.rig.routeCorridor); if (route) url.searchParams.set('route', route.id); else url.searchParams.delete('route'); } else url.searchParams.delete('route');
    url.searchParams.set('postfx', this.post.isEnabled ? '1' : '0');
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
    return { ready: this.ready, seed: this.seed, backend: this.context.backend,
      position: this.rig.position.toArray(), origin: this.origin.absolute.toArray(),
      shifts: this.origin.shifts, hour: this.sky.hour, ...this.terrain.stats,
      quality: this.quality, biome: BIOMES[this.terrain.biomeAt(this.rig.position.x, this.rig.position.z)]!.name,
      biomeDebug: this.terrain.biomeDebug, vegetationEnabled: this.vegetation.vegetationEnabled,
      windEnabled: this.vegetation.windEnabled, detailEnabled: this.terrain.material.detailEnabled, postfxEnabled: this.post.isEnabled, vegetation: this.vegetation.stats,
      roads: this.roads.stats, routeFollowing: this.rig.routeFollowing, route: this.rig.routeFollowing ? this.roads.routeAt(this.rig.position) : null,
      objects: { ...this.objects.stats, list: this.objects.list() },
      physics: this.physics.stats,
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
    this.input.dispose(); this.ui.dispose(); this.terrain.dispose(); this.vegetation.dispose(); this.roads.dispose(); this.sky.dispose(); this.post.dispose();
    this.objects.dispose(); this.interaction.clear(); this.physics.clear(); this.events.clear();
    clearObjectGeometryCache();
    this.context.renderer.dispose(); this.context.canvas.remove();
  }
}

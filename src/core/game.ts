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
import { BuildingManager } from '../world/buildings/manager';
import { BuildingExperience } from '../world/buildings/experience';
import { TerrainField } from '../world/terrain-field';
import type { BuildingStorage } from '../world/buildings/state';

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
  private readonly buildings: BuildingManager;
  private readonly buildingExperience: BuildingExperience;
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

  private constructor(context: RenderingContext, seed: string, quality: QualityName, hour: number, position: Vector3) {
    this.context = context; this.seed = seed; this.quality = quality;
    this.scene.name = 'Wayfarer / Phase 7 architecture';
    this.scene.fog = new Fog(0xb6c8cf, QUALITY[quality].viewDistance * 0.36, QUALITY[quality].viewDistance);
    this.input = new Input(context.canvas);
    this.terrain = new TerrainManager(this.origin, seed, quality, (error) => this.fail(error));
    this.vegetation = new VegetationManager(this.terrain, this.origin, quality);
    this.roads = new RoadManager(this.terrain, this.origin, quality, seed);
    if (new URLSearchParams(location.search).get('roads') === '0') this.roads.setEnabled(false);
    if (new URLSearchParams(location.search).get('vegetation') === '0') this.vegetation.setEnabled(false);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.vegetation.setWind(false);
    this.rig = new SurveyCamera(this.input, this.origin, this.terrain, this.roads);
    this.rig.position.copy(position); this.rig.previous.copy(position); this.rig.home.copy(position);
    this.origin.update(position);
    let buildingStorage: BuildingStorage | undefined;
    try { buildingStorage = window.localStorage; } catch (error) { console.warn('[Buildings] Browser storage unavailable; door state is session-only.', error); }
    this.buildings = new BuildingManager({
      seed, quality, origin: this.origin, terrain: this.terrain, storage: buildingStorage,
      onReservationsChanged: () => this.vegetation.invalidateReservations(),
    });
    this.vegetation.setReservationQuery((x, z) => this.buildings.field.isAuthoredReserved(x, z));
    this.sky = new SkySystem(context.renderer, this.scene, seed, quality);
    this.sky.setHour(hour);
    this.post = new PostProcessing(context.renderer, this.scene, this.rig.camera, quality);
    const postParam = new URLSearchParams(location.search).get('postfx');
    if (postParam !== null) this.post.setEnabled(postParam !== '0');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.sky.cycling = false; this.rig.touring = false; }
    this.scene.add(this.terrain.group, this.vegetation.group, this.roads.group, this.buildings.group);
    this.unsubscribeOrigin = this.origin.onChange((delta) => { this.terrain.rebase(delta); this.vegetation.rebase(); this.roads.rebase(delta); this.buildings.rebase(); });
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
      route: (value) => this.travelRoute(value),
      wind: (value) => this.vegetation.setWind(value),
      detail: (value) => this.terrain.material.setDetail(value),
      postfx: (value) => { this.post.setEnabled(value); this.updateURL(); },
      viewpoint: (value) => this.travelTo(value),
      stats: (value) => this.ui.showStats(value),
    });
    this.buildingExperience = new BuildingExperience(this.buildings, this.rig, this.terrain, { loading: () => this.beginLoading(), changed: () => this.updateURL(), toast: (message) => this.ui.toast(message) });
    this.ui.syncTime(hour, this.sky.cycling);
    this.ui.syncNature(this.vegetation.vegetationEnabled, this.vegetation.windEnabled, this.roads.roadsEnabled);
    this.ui.syncPost(this.post.isEnabled);
    this.input.onShortcut = (code) => {
      if (code === 'F3') this.ui.showStats(!this.ui.statsVisible);
      if (code === 'KeyH') this.ui.toggleHUD();
      if (code === 'KeyL') { this.terrain.setDebug(!this.terrain.debug); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); }
      if (code === 'KeyB') { this.terrain.setBiomeDebug(!this.terrain.biomeDebug); this.ui.syncDebug(this.terrain.debug, this.terrain.biomeDebug); }
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
    const requestedBuilding = params.get('building');
    const building = requestedBuilding ? new TerrainField(seed).buildings.getById(requestedBuilding) : undefined;
    const route = building ? undefined : (SCENIC_ROUTES.find((r) => r.id === params.get('route')) ?? (!params.has('x') && !params.has('z') ? SCENIC_ROUTES[0] : undefined));
    if (route) {
      const network = new RoadNetwork(seed, () => 0);
      const station = findRouteStation(seed, route.corridor, route.biome, route.station);
      const point = network.point(route.corridor, station);
      position.set(point.x, 450, point.z);
    } else if (building) {
      position.set(building.position.x, building.position.y + 1.65, building.position.z);
    } else if (!params.has('x') && !params.has('z')) {
      const vista = findBiomeViewpoint(seed, 1);
      position.set(vista.x, vista.y + 110, vista.z);
    }
    const context = await createRenderer(host, quality, params.get('renderer') === 'webgl');
    const game = new Game(context, seed, quality, hour, position);
    if (route) { const station = findRouteStation(seed, route.corridor, route.biome, route.station); game.rig.startRoute(route.corridor, station); game.updateURL(); }
    if (building) game.buildingExperience.visit(building);
    return game;
  }

  async start(): Promise<void> {
    await this.context.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  private frame(timestamp: number): void {
    if (this.disposed || document.hidden) return;
    try {
      this.loop.tick(timestamp, (dt) => {
        if (this.ready) { this.rig.fixedUpdate(dt); this.buildings.fixedUpdate(dt, this.rig.position); }
      }, (alpha, dt) => {
        this.terrain.update(this.rig.position, dt);
        this.vegetation.update(this.rig.position, dt);
        this.roads.update(this.rig.position, dt);
        this.buildings.update(this.rig.position, dt, this.sky.hour);
        this.buildingExperience.update(timestamp);
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
        this.origin.toLocal(this.rig.position, this.localPosition);
        if (this.ready) this.sky.update(dt, this.localPosition, this.rig.camera);
        const fog = this.scene.fog as Fog;
        fog.color.copy(this.sky.horizon);
        this.context.renderer.info.reset();
        this.post.render(this.scene, this.rig.camera);
        const stats = this.terrain.stats;
        const vegetation = this.vegetation.stats;
        const roads = this.roads.stats;
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
          progress: this.terrain.wanted ? this.terrain.ready / this.terrain.wanted : 0,
        }, timestamp);
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private toggleTour(): void {
    if (this.rig.inspecting) this.buildingExperience.stop();
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
    this.buildingExperience.stop();
    this.seed = seed;
    this.buildings.reset(seed);
    this.origin.reset();
    this.terrain.reset(seed, this.quality);
    this.vegetation.reset();
    this.roads.reset(seed);
    this.sky.reseed(seed);
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
    this.buildings.setQuality(quality);
    this.sky.setQuality(quality);
    this.post.setQuality(quality);
    this.ui.syncPost(this.post.isEnabled);
    resizeRenderer(this.context, quality);
    const fog = this.scene.fog as Fog;
    fog.near = QUALITY[quality].viewDistance * 0.36; fog.far = QUALITY[quality].viewDistance;
    try { localStorage.setItem('wayfarer.quality', quality); } catch { /* Storage is optional. */ }
    this.updateURL();
  }

  private travelRoute(id: string): void {
    const route = SCENIC_ROUTES.find((r) => r.id === id);
    if (!route) return;
    this.buildingExperience.stop();
    this.beginLoading();
    const station = findRouteStation(this.seed, route.corridor, route.biome, route.station);
    this.rig.startRoute(route.corridor, station);
    this.origin.update(this.rig.position);
    this.vegetation.rebase();
    this.ui.toast(`Route survey · ${route.name}`);
    this.updateURL();
  }

  private travelTo(biome: BiomeId): void {
    this.buildingExperience.stop();
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
    if (this.rig.routeFollowing) { const route = SCENIC_ROUTES.find((r) => r.corridor === this.rig.routeCorridor); if (route) url.searchParams.set('route', route.id); else url.searchParams.delete('route'); } else url.searchParams.delete('route');
    url.searchParams.set('postfx', this.post.isEnabled ? '1' : '0');
    const building = this.buildingExperience?.activeBuilding;
    if (building) url.searchParams.set('building', building); else url.searchParams.delete('building');
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
      windEnabled: this.vegetation.windEnabled, detailEnabled: this.terrain.material.detailEnabled, postfxEnabled: this.post.isEnabled, inspecting: this.rig.inspecting, buildings: this.buildings.snapshot(), vegetation: this.vegetation.stats,
      roads: this.roads.stats, routeFollowing: this.rig.routeFollowing, route: this.rig.routeFollowing ? this.roads.routeAt(this.rig.position) : null,
      touring: this.rig.touring, speed: this.rig.velocity.length(),
      fps: this.loop.fps, drawCalls: this.context.renderer.info.render.drawCalls,
      gpuBytes: this.context.renderer.info.memory.total };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort(); this.unsubscribeOrigin();
    void this.context.renderer.setAnimationLoop(null);
    this.buildingExperience.dispose(); this.buildings.dispose();
    this.input.dispose(); this.ui.dispose(); this.terrain.dispose(); this.vegetation.dispose(); this.roads.dispose(); this.sky.dispose(); this.post.dispose();
    this.context.renderer.dispose(); this.context.canvas.remove();
  }
}

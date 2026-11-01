import { Group } from 'three/webgpu';
import type { QualityName } from '../../config';
import type { FloatingOrigin } from '../../core/floating-origin';
import { TerrainField } from '../terrain-field';
import { BuildingVisuals } from '../../rendering/buildings/building-visuals';
import { BuildingCollisionDebug } from '../../rendering/buildings/collision-debug';
import { BuildingCollisionIndex } from './collision';
import { BuildingRuntime } from './runtime';
import { BUILDING_SETTINGS, BUILDING_QUALITY } from './settings';
import { BUILDING_TEMPLATES } from './templates';
import { BuildingState } from './state';
import type { BuildingStorage } from './state';
import { buildingToWorld, worldToBuilding } from './coordinates';
import type { BuildingDescriptor, BuildingEvent, BuildingInteraction, BuildingPorts, Point3, RoomLocation } from './types';
import type { AuthoredBuilding, BuildingPlacementField } from './placement';

interface TerrainAvailability { heightAt: (x: number, z: number) => number | undefined; readonly revision?: number }
export interface BuildingManagerOptions { seed: string; quality: QualityName; origin: FloatingOrigin; terrain: TerrainAvailability; ports?: BuildingPorts; storage?: BuildingStorage; sites?: BuildingPlacementField; onReservationsChanged?: () => void }

/** Coordinates scene streaming, NOT global gameplay, character physics or NPC AI. */
export class BuildingManager {
  readonly group = new Group();
  readonly collision = new BuildingCollisionIndex();
  private readonly visuals = new BuildingVisuals();
  private readonly debug = new BuildingCollisionDebug();
  private readonly instances = new Map<string, BuildingRuntime>();
  private readonly storageWarnings: string[] = [];
  private readonly eventListeners = new Set<(event: BuildingEvent) => void>();
  private readonly ports: BuildingPorts;
  private elapsed: number = BUILDING_SETTINGS.refreshSeconds;
  private lastPosition: Point3 = { x: Infinity, y: Infinity, z: Infinity };
  private location: RoomLocation | undefined;
  private disposed = false;
  private terrainRevision = -1;
  private state: BuildingState;
  field: BuildingPlacementField;
  quality: QualityName;
  seed: string;
  constructor(private readonly options: BuildingManagerOptions) {
    this.seed = options.seed; this.quality = options.quality;
    this.field = options.sites ?? new TerrainField(this.seed).buildings;
    if (this.field.seed !== this.seed) throw new Error('Building site seed must match the world');
    this.ports = { ...options.ports, events: (event) => { options.ports?.events?.(event); for (const listener of this.eventListeners) listener(event); } };
    this.state = this.createState();
    this.group.name = 'Phase 7 / buildings & streamed interiors'; this.group.add(this.debug.group);
  }
  private createState(): BuildingState {
    return new BuildingState(this.seed, this.options.storage, (message) => {
      console.warn('[Buildings]', message);
      this.storageWarnings.push(message);
      if (this.storageWarnings.length > 8) this.storageWarnings.shift();
      this.ports.events?.({ type: 'BuildingStorageWarning', message });
    });
  }
  onEvent(listener: (event: BuildingEvent) => void): () => void {
    this.eventListeners.add(listener);
    for (const message of this.storageWarnings) listener({ type: 'BuildingStorageWarning', message });
    return () => this.eventListeners.delete(listener);
  }

  update(position: Point3, dt: number, hour: number, force = false): void {
    if (this.disposed) return;
    this.visuals.setHour(hour);
    this.elapsed += dt;
    const moved = Math.hypot(position.x - this.lastPosition.x, position.y - this.lastPosition.y, position.z - this.lastPosition.z) > 12;
    if (force || this.terrainRevision !== (this.options.terrain.revision ?? 0) || (this.elapsed >= BUILDING_SETTINGS.refreshSeconds && moved)) {
      this.terrainRevision = this.options.terrain.revision ?? 0;
      this.elapsed = 0; this.lastPosition = { ...position }; this.refresh(position);
    }
    this.updateLocation(position);
    let lights = 0;
    for (const instance of this.instances.values()) {
      const room = this.location?.building.id === instance.data.id ? this.location.room : instance.template.rooms[0];
      this.visuals.setLight(instance.view, room, instance.interiorLoaded && lights++ < BUILDING_QUALITY[this.quality].lights);
    }
    this.debug.update(this.collision.values, this.options.origin.absolute);
  }
  private refresh(position: Point3): void {
    const budget = BUILDING_QUALITY[this.quality];
    const candidates = this.field.nearby(position.x, position.z, budget.range);
    const containing = this.roomAt(position)?.building;
    if (containing && !candidates.some((item) => item.id === containing.id)) candidates.unshift(containing);
    candidates.sort((a, b) => a.id === containing?.id ? -1 : b.id === containing?.id ? 1 : Math.hypot(a.position.x - position.x, a.position.z - position.z) - Math.hypot(b.position.x - position.x, b.position.z - position.z));
    const desired = candidates.filter((building) => building.id === containing?.id || this.options.terrain.heightAt(building.position.x, building.position.z) !== undefined).slice(0, budget.shells);
    const ids = new Set(desired.map((building) => building.id));
    for (const [id, instance] of this.instances) if (!ids.has(id)) { instance.dispose(); this.instances.delete(id); }
    for (const building of desired) if (!this.instances.has(building.id)) {
      const instance = new BuildingRuntime(building, this.visuals, this.collision, this.state, this.ports);
      this.instances.set(building.id, instance); this.group.add(instance.view.root); this.positionView(instance);
    }
    let interiors = 0;
    for (const building of desired) {
      const instance = this.instances.get(building.id)!;
      instance.setCollisionActive(instance.distance(position) < BUILDING_SETTINGS.collisionRange);
      const range = instance.interiorLoaded ? BUILDING_SETTINGS.interiorLeave : BUILDING_SETTINGS.interiorEnter;
      instance.setInterior(instance.distance(position) < range && interiors++ < budget.interiors);
    }
  }
  private positionView(instance: BuildingRuntime): void {
    const p = instance.data.position, origin = this.options.origin.absolute;
    instance.view.root.position.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  }
  fixedUpdate(dt: number, observer: Point3): void { if (!this.disposed) for (const instance of this.instances.values()) instance.fixedUpdate(dt, observer); }
  rebase(): void { for (const instance of this.instances.values()) this.positionView(instance); this.debug.update(this.collision.values, this.options.origin.absolute); }
  roomAt(position: Point3): RoomLocation | undefined {
    for (const instance of this.instances.values()) {
      if (instance.distance(position) > Math.hypot(instance.template.width, instance.template.depth)) continue;
      const local = worldToBuilding(instance.data, position);
      const room = instance.template.rooms.find((r) => local.x > r.min.x && local.x < r.max.x && local.y >= r.min.y - 0.03 && local.y < r.max.y && local.z > r.min.z && local.z < r.max.z);
      if (room) return { building: instance.data, room };
    }
    return undefined;
  }
  private updateLocation(position: Point3): void {
    const next = this.roomAt(position), old = this.location;
    if (old?.building.id !== next?.building.id) {
      if (old) this.ports.events?.({ type: 'PlayerExitedBuilding', buildingId: old.building.id, roomId: old.room.id });
      if (next) this.ports.events?.({ type: 'PlayerEnteredBuilding', buildingId: next.building.id, roomId: next.room.id });
    }
    if (next && (old?.building.id !== next.building.id || old.room.id !== next.room.id)) this.ports.events?.({ type: 'BuildingRoomChanged', buildingId: next.building.id, roomId: next.room.id, acoustic: next.room.acoustic });
    this.location = next;
  }
  interactionAt(position: Point3, direction: Point3): BuildingInteraction | undefined {
    let best: BuildingInteraction | undefined, bestDistance = Infinity;
    for (const instance of this.instances.values()) for (const interaction of instance.interactions) {
      const dx = interaction.position.x - position.x, dy = interaction.position.y - position.y, dz = interaction.position.z - position.z;
      const distance = Math.hypot(dx, dy, dz), facing = (dx * direction.x + dy * direction.y + dz * direction.z) / Math.max(0.01, distance);
      if (distance > interaction.range || distance >= bestDistance || facing < 0.5) continue;
      if (this.collision.sweep(position, interaction.position, 0, 0, interaction.id)) continue;
      best = interaction; bestDistance = distance;
    }
    return best;
  }
  nearest(position: Point3): BuildingDescriptor | undefined { return this.field.nearest(position); }
  entrance(building: BuildingDescriptor): Point3 { return buildingToWorld(building, BUILDING_TEMPLATES.get(building.template).entrance); }
  graph(id: string) { return this.instances.get(id)?.graph(); }
  registerAuthored(input: AuthoredBuilding): BuildingDescriptor {
    const result = this.field.registerAuthored(input);
    this.lastPosition.x = Infinity;
    this.options.onReservationsChanged?.();
    return result;
  }
  setDebug(enabled: boolean): void { this.debug.group.visible = enabled; }
  get debugEnabled(): boolean { return this.debug.group.visible; }
  setQuality(quality: QualityName): void { this.quality = quality; this.lastPosition.x = Infinity; }
  reset(seed: string): void {
    this.state.flush();
    if (this.location) this.ports.events?.({ type: 'PlayerExitedBuilding', buildingId: this.location.building.id, roomId: this.location.room.id });
    for (const instance of this.instances.values()) instance.dispose();
    this.instances.clear(); this.location = undefined; this.seed = seed;
    this.storageWarnings.length = 0;
    this.field = new TerrainField(seed).buildings; this.state = this.createState(); this.lastPosition.x = Infinity;
    this.options.onReservationsChanged?.();
  }
  exportModifications() { return this.state.snapshot(); }
  restoreModifications(data: unknown): void {
    this.state.restore(data);
    for (const instance of this.instances.values()) instance.dispose();
    this.instances.clear(); this.lastPosition.x = Infinity;
  }
  get currentRoom(): RoomLocation | undefined { return this.location; }
  snapshot() {
    return { ...this.stats, activeRoom: this.location ? { buildingId: this.location.building.id, roomId: this.location.room.id, name: this.location.room.name, acoustic: this.location.room.acoustic } : null,
      buildings: [...this.instances.values()].map((instance) => instance.snapshot()) };
  }
  get stats() {
    return { shells: this.instances.size, interiors: [...this.instances.values()].filter((item) => item.interiorLoaded).length, colliders: this.collision.size,
      lights: [...this.instances.values()].filter((item) => item.view.light?.visible).length,
      ...this.field.stats, ...this.state.stats, ...this.visuals.stats, budget: BUILDING_QUALITY[this.quality] };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.state.flush();
    for (const instance of this.instances.values()) instance.dispose();
    this.instances.clear(); this.collision.clear(); this.debug.dispose(); this.visuals.dispose(); this.eventListeners.clear(); this.group.removeFromParent();
  }
}

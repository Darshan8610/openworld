import { BUILDING_SETTINGS } from './settings';
import { BUILDING_TEMPLATES } from './templates';
import { buildingToWorld } from './coordinates';
import { createBuildingSiteParts } from './site-parts';
import { BuildingCollisionIndex, distanceToBox, doorCollider, partCollider } from './collision';
import { createBuildingGraph } from './navigation';
import { BuildingState } from './state';
import { BuildingVisuals } from '../../rendering/buildings/building-visuals';
import type { BuildingView } from '../../rendering/buildings/building-visuals';
import type { BuildingCollider, BuildingDescriptor, BuildingDoor, BuildingInteraction, BuildingPorts, BuildingSnapshot, Point3 } from './types';

interface DoorState { definition: BuildingDoor; open: boolean; angle: number; cooldown: number; passable: boolean; blocked: boolean }

/** One bounded streamed instance: simulation is separate from its shared meshes. */
export class BuildingRuntime {
  readonly template;
  readonly view: BuildingView;
  readonly doors = new Map<string, DoorState>();
  readonly interactions: BuildingInteraction[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private readonly colliderIds = new Set<string>();
  private readonly site;
  private collisionActive = false;
  interiorLoaded = false;
  constructor(readonly data: BuildingDescriptor, private readonly visuals: BuildingVisuals, private readonly index: BuildingCollisionIndex, private readonly state: BuildingState, private readonly ports: BuildingPorts) {
    this.template = BUILDING_TEMPLATES.get(data.template);
    this.site = createBuildingSiteParts(data);
    this.view = visuals.create(data, this.site);
    for (const definition of this.template.doors) {
      const id = `${data.id}/door/${definition.id}`;
      const open = state.isOpen(id);
      this.doors.set(definition.id, { definition, open, angle: open ? definition.openAngle : 0, cooldown: 0, passable: open && Math.abs(definition.openAngle) >= 1.15, blocked: false });
      this.view.doors.get(definition.id)!.rotation.y = definition.yaw + (open ? definition.openAngle : 0);
      const binding: BuildingInteraction = { id, buildingId: data.id, position: doorCollider(data, definition, 0).center, range: BUILDING_SETTINGS.interactionRange, label: () => `${this.doors.get(definition.id)!.open ? 'Close' : 'Open'} ${definition.name.toLowerCase()}`, interact: (actor) => this.interact(definition.id, actor) };
      this.interactions.push(binding);
      if (ports.interactions) this.unsubscribers.push(ports.interactions.register(binding));
    }
    this.publishGraph();
    ports.events?.({ type: 'BuildingStreamedIn', buildingId: data.id });
  }
  private put(collider: BuildingCollider): void { this.index.upsert(collider); this.colliderIds.add(collider.id); this.ports.physics?.upsertCollider(collider); }
  private remove(id: string): void { this.index.remove(id); this.colliderIds.delete(id); this.ports.physics?.removeCollider(id); }
  setCollisionActive(active: boolean): void {
    if (this.collisionActive === active) return;
    this.collisionActive = active;
    this.refreshColliders();
  }
  private refreshColliders(): void {
    const desired = new Map<string, BuildingCollider>();
    if (this.collisionActive) {
      for (const part of [...this.site, ...this.template.parts]) if (part.solid && (part.stage === 'shell' || this.interiorLoaded)) {
        const collider = partCollider(this.data, part); desired.set(collider.id, collider);
      }
      for (const door of this.doors.values()) { const collider = doorCollider(this.data, door.definition, door.angle); desired.set(collider.id, collider); }
    }
    for (const id of this.colliderIds) if (!desired.has(id)) this.remove(id);
    for (const collider of desired.values()) this.put(collider);
  }
  setInterior(loaded: boolean): void {
    if (this.interiorLoaded === loaded) return;
    this.interiorLoaded = loaded;
    this.visuals.setInterior(this.view, this.template, loaded);
    this.refreshColliders();
    this.ports.events?.({ type: loaded ? 'InteriorLoaded' : 'InteriorUnloaded', buildingId: this.data.id });
  }
  private interact(id: string, actor: Point3): boolean {
    const door = this.doors.get(id), binding = this.interactions.find((item) => item.id.endsWith(`/door/${id}`));
    if (!door || !binding || !this.collisionActive || door.cooldown > 0 || Math.hypot(actor.x - binding.position.x, actor.y - binding.position.y, actor.z - binding.position.z) > binding.range) return false;
    if (this.index.sweep(actor, binding.position, 0, 0, binding.id)) return false;
    door.open = !door.open; door.cooldown = 0.4;
    this.state.setOpen(binding.id, door.open); this.state.flush();
    this.ports.events?.({ type: 'BuildingDoorChanged', buildingId: this.data.id, doorId: id, open: door.open });
    return true;
  }
  fixedUpdate(dt: number, observer: Point3): void {
    for (const [id, door] of this.doors) {
      door.cooldown = Math.max(0, door.cooldown - dt);
      const target = door.open ? door.definition.openAngle : 0;
      if (Math.abs(target - door.angle) < 1e-6) continue;
      const next = door.angle + Math.sign(target - door.angle) * Math.min(Math.abs(target - door.angle), BUILDING_SETTINGS.doorSpeed * dt);
      const collider = doorCollider(this.data, door.definition, next);
      const separation = distanceToBox(observer, collider);
      const previousSeparation = distanceToBox(observer, doorCollider(this.data, door.definition, door.angle));
      const blocked = (separation < 0.3 && separation < previousSeparation - 1e-6) || this.ports.physics?.canMoveKinematic?.(collider) === false;
      if (blocked) {
        // Initial contact must still be allowed to move AWAY from the observer.
        // Closing into an occupant reopens; opening into one waits for clearance.
        if (!door.blocked) this.ports.events?.({ type: 'BuildingDoorBlocked', buildingId: this.data.id, doorId: id });
        door.blocked = true;
        if (!door.open) { door.open = true; this.state.setOpen(collider.id, true); this.state.flush(); }
        continue;
      }
      door.blocked = false;
      door.angle = next;
      this.view.doors.get(id)!.rotation.y = door.definition.yaw + next;
      if (this.collisionActive) this.put(collider);
      const passable = Math.abs(door.angle) >= 1.15;
      if (passable !== door.passable) { door.passable = passable; this.publishGraph(); }
    }
  }
  graph() { return createBuildingGraph(this.data, this.template, (id) => this.doors.get(id)?.passable ?? false); }
  private publishGraph(): void { this.ports.navigation?.setBuildingGraph(this.graph()); }
  snapshot(): BuildingSnapshot {
    return { id: this.data.id, template: this.template.id, name: this.template.name, position: { ...this.data.position }, yaw: this.data.yaw, entrance: buildingToWorld(this.data, this.template.entrance), interiorLoaded: this.interiorLoaded,
      doors: [...this.doors.entries()].map(([id, door]) => ({ id, open: door.open, angle: door.angle, position: doorCollider(this.data, door.definition, door.angle).center })) };
  }
  distance(position: Point3): number { return Math.hypot(position.x - this.data.position.x, position.y - this.data.position.y, position.z - this.data.position.z); }
  dispose(): void {
    this.setCollisionActive(false);
    this.setInterior(false);
    for (const id of [...this.colliderIds]) this.remove(id);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.ports.navigation?.removeBuildingGraph(this.data.id);
    this.visuals.destroy(this.view);
    this.ports.events?.({ type: 'BuildingStreamedOut', buildingId: this.data.id });
  }
}

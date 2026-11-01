import type { BuildingDoor, BuildingMaterial, BuildingPart, BuildingRoom, Point3 } from './types';

const p = (x: number, y: number, z: number): Point3 => ({ x, y, z });
/** Reusable structural pieces. Windows/doors are true holes, not painted walls. */
export class TemplateKit {
  readonly parts: BuildingPart[] = [];
  readonly doors: BuildingDoor[] = [];
  readonly rooms: BuildingRoom[] = [];
  box(id: string, center: Point3, size: Point3, material: BuildingMaterial, stage: BuildingPart['stage'] = 'shell', solid = true, walkable = false): void {
    this.parts.push({ id, center, size, material, stage, solid, walkable });
  }
  floor(id: string, x: number, z: number, width: number, depth: number, y = 0, stage: BuildingPart['stage'] = 'shell'): void {
    this.box(id, p(x, y - 0.12, z), p(width, 0.24, depth), 'floor', stage, true, true);
  }
  /** Wall lies along X, then rotates into the requested side. */
  wall(id: string, length: number, height: number, center: Point3, yaw: number, opening: 'door' | 'window' | 'solid' = 'solid', material: BuildingMaterial = 'plaster'): void {
    const start = this.parts.length;
    const add = (suffix: string, x: number, y: number, w: number, h: number, mat = material) => this.box(`${id}:${suffix}`, p(x, y, 0), p(w, h, 0.24), mat);
    if (opening === 'solid') add('wall', 0, height / 2, length, height);
    else {
      const width = opening === 'door' ? 1.5 : Math.min(2.4, length * 0.45);
      const base = opening === 'door' ? 0 : 0.95;
      const top = opening === 'door' ? 2.45 : 2.3;
      const side = (length - width) / 2;
      add('left', -(width + side) / 2, height / 2, side, height);
      add('right', (width + side) / 2, height / 2, side, height);
      add('lintel', 0, (height + top) / 2, width, height - top);
      if (base > 0) add('sill-wall', 0, base / 2, width, base);
      if (opening === 'window') {
        add('glass', 0, (base + top) / 2, width, top - base, 'glass');
        add('window-glow', 0, (base + top) / 2, width - 0.08, top - base - 0.08, 'window');
        for (const x of [-width / 2, 0, width / 2]) add(`frame-${x}`, x, (base + top) / 2, 0.065, top - base + 0.12, 'timber');
        for (const y of [base, top]) add(`frame-${y}`, 0, y, width + 0.14, 0.08, 'timber');
      }
    }
    for (const part of this.parts.slice(start)) {
      const x = part.center.x, z = part.center.z;
      part.center = p(center.x + Math.cos(yaw) * x + Math.sin(yaw) * z, center.y + part.center.y, center.z - Math.sin(yaw) * x + Math.cos(yaw) * z);
      part.rotation = p(0, yaw, 0);
      if (part.material === 'window') { part.solid = false; part.size.z = 0.008; }
      if (part.material === 'glass') part.size.z = 0.035;
    }
  }
  room(id: string, name: string, min: Point3, max: Point3, floor = 0, acoustic: BuildingRoom['acoustic'] = 'wood-room'): void {
    this.rooms.push({ id, name, min, max, floor, acoustic, light: p((min.x + max.x) / 2, max.y - 0.35, (min.z + max.z) / 2) });
    this.box(`${id}:lamp`, p((min.x + max.x) / 2, max.y - 0.18, (min.z + max.z) / 2), p(0.8, 0.07, 0.34), 'light', 'interior', false);
  }
  door(id: string, hinge: Point3, rooms: BuildingDoor['rooms'], yaw = 0): void {
    this.doors.push({ id, name: rooms[0] === null ? 'Entrance door' : 'Room door', hinge, width: 1.4, height: 2.4, thickness: 0.09, yaw, openAngle: Math.PI * 0.56, rooms });
  }
  table(id: string, x: number, z: number, y = 0): void {
    this.box(`${id}:top`, p(x, y + 0.77, z), p(2.1, 0.11, 1.05), 'timber', 'interior');
    for (const dx of [-0.85, 0.85]) for (const dz of [-0.38, 0.38]) this.box(`${id}:leg-${dx}-${dz}`, p(x + dx, y + 0.35, z + dz), p(0.1, 0.7, 0.1), 'metal', 'interior');
  }
  chair(id: string, x: number, z: number, y = 0): void {
    this.box(`${id}:seat`, p(x, y + 0.46, z), p(0.58, 0.08, 0.58), 'timber', 'interior');
    this.box(`${id}:back`, p(x, y + 0.76, z - 0.24), p(0.58, 0.55, 0.08), 'timber', 'interior');
    for (const dx of [-0.22, 0.22]) for (const dz of [-0.22, 0.22]) this.box(`${id}:leg-${dx}-${dz}`, p(x + dx, y + 0.23, z + dz), p(0.06, 0.46, 0.06), 'metal', 'interior');
  }
  bed(id: string, x: number, z: number, y = 0): void {
    this.box(`${id}:frame`, p(x, y + 0.26, z), p(1.65, 0.45, 2.3), 'timber', 'interior');
    this.box(`${id}:mattress`, p(x, y + 0.54, z), p(1.5, 0.2, 2.15), 'linen', 'interior');
    this.box(`${id}:pillow`, p(x, y + 0.7, z - 0.65), p(0.9, 0.15, 0.48), 'linen', 'interior');
  }
  shelf(id: string, x: number, z: number, y = 0): void {
    for (const dx of [-0.9, 0.9]) this.box(`${id}:upright-${dx}`, p(x + dx, y + 1.05, z), p(0.08, 2.1, 0.55), 'metal', 'interior');
    for (let n = 0; n < 4; n++) {
      this.box(`${id}:shelf-${n}`, p(x, y + 0.2 + n * 0.58, z), p(1.9, 0.06, 0.6), 'timber', 'interior');
      if (n > 0) this.box(`${id}:box-${n}`, p(x - 0.4 + n * 0.2, y + 0.38 + n * 0.58, z), p(0.55, 0.3, 0.4), 'ceramic', 'interior');
    }
  }
}
export { p as point };

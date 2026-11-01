import { TemplateKit, point as p } from './template-kit';
import { finitePoint } from './coordinates';
import { BUILDING_MATERIALS } from './types';
import type { BuildingTemplate } from './types';

function envelope(kit: TemplateKit, width: number, depth: number, floors: number, timber = false): void {
  const material = timber ? 'timber' : 'plaster';
  kit.floor('ground-floor', 0, 0, width, depth);
  for (let floor = 0; floor < floors; floor++) {
    const y = floor * 3.4;
    kit.wall(`front-${floor}`, 4, 3.2, p(0, y, depth / 2), 0, floor === 0 ? 'door' : 'window', material);
    const side = (width - 4) / 2;
    for (const sign of [-1, 1]) {
      kit.wall(`front-wing-${floor}-${sign}`, side, 3.2, p(sign * (2 + side / 2), y, depth / 2), 0, 'window', material);
      kit.wall(`back-${floor}-${sign}`, width / 2, 3.2, p(sign * width / 4, y, -depth / 2), 0, 'window', material);
      for (const half of [-1, 1]) kit.wall(`side-${floor}-${sign}-${half}`, depth / 2, 3.2, p(sign * width / 2, y, half * depth / 4), Math.PI / 2, 'window', material);
    }
    for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) kit.box(`post-${floor}-${x}-${z}`, p(x, y + 1.6, z), p(0.28, 3.25, 0.28), 'timber');
    kit.box(`ring-${floor}-front`, p(0, y + 3.25, depth / 2), p(width + 0.4, 0.22, 0.32), 'timber');
    kit.box(`ring-${floor}-back`, p(0, y + 3.25, -depth / 2), p(width + 0.4, 0.22, 0.32), 'timber');
  }
  const ceiling = floors * 3.4 - 0.18;
  kit.box('ceiling', p(0, ceiling, 0), p(width, 0.18, depth), 'plaster');
  kit.parts.push({ id: 'pitched-roof', center: p(0, ceiling + 0.98, 0), size: p(width + 1.1, 1.9, depth + 1.1), material: 'roof', stage: 'shell', shape: 'gable', solid: false });
  kit.door('entrance', p(-0.7, 0, depth / 2), [null, 'hall']);
  kit.floor('porch', 0, depth / 2 + 1.6, 3.6, 3.2);
  // Roofed porch and fine facade trim, still merged into shared material batches.
  kit.box('porch-canopy', p(0, 2.8, depth / 2 + 1.1), p(3.9, 0.16, 2.6), 'roof');
  for (const x of [-1.6, 1.6]) kit.box(`porch-post-${x}`, p(x, 1.36, depth / 2 + 2.05), p(0.12, 2.72, 0.12), 'timber');
}

function cabin(): BuildingTemplate {
  const k = new TemplateKit();
  envelope(k, 12, 10, 1, true);
  k.wall('partition', 11.8, 3.2, p(0, 0, 0), 0, 'door');
  k.door('bedroom', p(-0.7, 0, 0), ['hall', 'bedroom']);
  k.room('hall', 'Living room', p(-5.8, 0, 0.12), p(5.8, 3.2, 4.8));
  k.room('bedroom', 'Bedroom', p(-5.8, 0, -4.8), p(5.8, 3.2, -0.12));
  k.table('dining', -3.6, 2.8); k.chair('chair-1', -3.6, 1.85); k.chair('chair-2', -4.9, 2.8);
  k.bed('bed', -3.4, -2.7); k.shelf('cabinet', 4, -4.4);
  k.box('kitchen-counter', p(4.7, 0.48, 2.4), p(1, 0.96, 3.4), 'plaster', 'interior');
  k.box('kitchen-top', p(4.7, 1.01, 2.4), p(1.06, 0.1, 3.45), 'stone', 'interior');
  return {
    id: 'cabin', name: 'Timber cabin', width: 12, depth: 10, height: 5.3,
    parts: k.parts, rooms: k.rooms, doors: k.doors, entrance: p(0, 0, 7.7),
    nodes: [{ id: 'outside', position: p(0, 0, 7.7), room: null }, { id: 'hall', position: p(0, 0, 3), room: 'hall' }, { id: 'bedroom', position: p(0, 0, -2.5), room: 'bedroom' }],
    edges: [{ from: 'outside', to: 'hall', kind: 'entrance', door: 'entrance' }, { from: 'hall', to: 'bedroom', kind: 'walk', door: 'bedroom' }],
  };
}

function workshop(): BuildingTemplate {
  const k = new TemplateKit();
  envelope(k, 14, 12, 1);
  k.wall('partition', 13.8, 3.2, p(0, 0, -2), 0, 'door');
  k.door('store', p(-0.7, 0, -2), ['hall', 'store']);
  k.room('hall', 'Workshop', p(-6.8, 0, -1.85), p(6.8, 3.2, 5.8), 0, 'workshop');
  k.room('store', 'Storage room', p(-6.8, 0, -5.8), p(6.8, 3.2, -2.15), 0, 'workshop');
  k.table('workbench-left', -4.8, 1.2); k.table('workbench-right', 4.8, 1.2);
  k.chair('work-chair', -4.8, 0.2);
  for (const x of [-4.5, -2, 2, 4.5]) k.shelf(`storage-${x}`, x, -5.2);
  k.box('tool-board', p(-6.5, 1.7, 1.2), p(0.08, 0.8, 2.8), 'timber', 'interior');
  for (let n = 0; n < 7; n++) k.box(`tool-${n}`, p(-6.4, 1.65, 0.2 + n * 0.32), p(0.05, 0.4, 0.08), 'metal', 'interior', false);
  return {
    id: 'workshop', name: 'Roadside workshop', width: 14, depth: 12, height: 5.3,
    parts: k.parts, rooms: k.rooms, doors: k.doors, entrance: p(0, 0, 8.7),
    nodes: [{ id: 'outside', position: p(0, 0, 8.7), room: null }, { id: 'hall', position: p(0, 0, 3), room: 'hall' }, { id: 'store', position: p(0, 0, -4), room: 'store' }],
    edges: [{ from: 'outside', to: 'hall', kind: 'entrance', door: 'entrance' }, { from: 'hall', to: 'store', kind: 'walk', door: 'store' }],
  };
}

function lodge(): BuildingTemplate {
  const k = new TemplateKit();
  envelope(k, 16, 14, 2);
  k.wall('partition', 15.8, 3.2, p(0, 0, -1), 0, 'door');
  k.door('back-room', p(-0.7, 0, -1), ['hall', 'back-room']);
  k.room('hall', 'Common room', p(-7.8, 0, -0.85), p(7.8, 3.2, 6.8), 0, 'large-room');
  k.room('back-room', 'Back room', p(-7.8, 0, -6.8), p(7.8, 3.2, -1.15));
  k.room('loft', 'Upper gallery', p(-7.8, 3.4, -6.8), p(7.8, 6.6, 6.8), 1, 'large-room');
  // Four slabs leave a REAL opening for the stair, rather than an invisible floor.
  k.floor('upper-west', -1.95, 0, 12.1, 14, 3.4);
  k.floor('upper-east', 7.35, 0, 1.3, 14, 3.4);
  k.floor('upper-north', 5.4, -3.9, 2.6, 6.2, 3.4);
  k.floor('upper-south', 5.4, 6.55, 2.6, 0.9, 3.4);
  k.floor('upper-stair-landing', 5.4, -0.35, 2.6, 1, 3.4);
  const nodes = [
    { id: 'outside', position: p(0, 0, 9.7), room: null },
    { id: 'hall', position: p(0, 0, 4.5), room: 'hall' },
    { id: 'back-room', position: p(0, 0, -3.5), room: 'back-room' },
    { id: 'stair-base', position: p(5.4, 0, 6.05), room: 'hall' },
  ];
  const edges: BuildingTemplate['edges'][number][] = [
    { from: 'outside', to: 'hall', kind: 'entrance', door: 'entrance' },
    { from: 'hall', to: 'back-room', kind: 'walk', door: 'back-room' },
    { from: 'hall', to: 'stair-base', kind: 'walk' },
  ];
  for (let i = 0; i < 17; i++) {
    const top = (i + 1) * 0.2, z = 5.7 - i * 0.34;
    k.box(`stair-${i}`, p(5.4, top / 2, z), p(2.3, top, 0.34), 'timber', 'interior', true, true);
    nodes.push({ id: `step-${i}`, position: p(5.4, top, z), room: i === 16 ? 'loft' : 'hall' });
    edges.push({ from: i === 0 ? 'stair-base' : `step-${i - 1}`, to: `step-${i}`, kind: 'stairs' });
    if (i % 3 === 0) for (const x of [4.2, 6.6]) k.box(`stair-rail-post-${i}-${x}`, p(x, top + 0.45, z), p(0.065, 0.9, 0.065), 'metal', 'interior');
  }
  nodes.push({ id: 'landing', position: p(5.4, 3.4, -1.15), room: 'loft' }, { id: 'loft', position: p(0, 3.4, -2.5), room: 'loft' });
  edges.push({ from: 'step-16', to: 'landing', kind: 'stairs' }, { from: 'landing', to: 'loft', kind: 'walk' });
  for (const x of [4.12, 6.68]) {
    k.box(`gallery-rail-${x}`, p(x, 4.35, 2.7), p(0.07, 0.08, 6.4), 'metal', 'interior');
    for (let z = 0; z < 6; z++) k.box(`gallery-post-${x}-${z}`, p(x, 3.85, z), p(0.065, 0.9, 0.065), 'metal', 'interior');
  }
  k.table('common-table', -4.5, 3.2); k.chair('common-chair', -4.5, 2.1);
  k.bed('back-bed', -5, -4.6); k.shelf('back-shelf', 5, -6.3);
  k.table('gallery-table', -4.5, 1.8, 3.4); k.chair('gallery-chair', -4.5, 0.7, 3.4);
  k.shelf('gallery-shelf', -4.5, -6.3, 3.4);
  return { id: 'lodge', name: 'Two-storey lodge', width: 16, depth: 14, height: 8.7, parts: k.parts, rooms: k.rooms, doors: k.doors, entrance: p(0, 0, 9.7), nodes, edges };
}

/** A validated registry is shared by procedural and authored placement. */
export class BuildingTemplateRegistry {
  private readonly templates = new Map<string, BuildingTemplate>();
  constructor(initial: readonly BuildingTemplate[] = [cabin(), workshop(), lodge()]) { for (const template of initial) this.register(template); }
  register(template: BuildingTemplate): void {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(template.id) || this.templates.has(template.id) || this.templates.size >= 32) throw new Error(`Invalid or duplicate building template: ${template.id}`);
    if (![template.width, template.depth, template.height].every((n) => Number.isFinite(n) && n > 0 && n < 200)) throw new Error('Invalid building dimensions');
    if (template.parts.length > 512 || template.rooms.length > 16 || template.doors.length > 16 || template.nodes.length > 128) throw new Error('Building template budget exceeded');
    const unique = (values: readonly { id: string }[], label: string) => { if (new Set(values.map((v) => v.id)).size !== values.length) throw new Error(`Duplicate ${label} id`); };
    unique(template.parts, 'part'); unique(template.doors, 'door'); unique(template.rooms, 'room'); unique(template.nodes, 'navigation');
    const rooms = new Set(template.rooms.map((room) => room.id)), nodes = new Set(template.nodes.map((node) => node.id)), doors = new Set(template.doors.map((door) => door.id));
    for (const part of template.parts) if (!finitePoint(part.center) || !finitePoint(part.size) || ![part.size.x, part.size.y, part.size.z].every((n) => n > 0) || (part.rotation && !finitePoint(part.rotation))) throw new Error(`Invalid part: ${part.id}`);
    for (const part of template.parts) {
      if (!BUILDING_MATERIALS.includes(part.material) || (part.solid && part.rotation && (part.rotation.x !== 0 || part.rotation.z !== 0))) throw new Error(`Unsupported material or solid rotation: ${part.id}`);
    }
    for (const room of template.rooms) if (!finitePoint(room.min) || !finitePoint(room.max) || !finitePoint(room.light) || !Number.isInteger(room.floor) || room.max.x <= room.min.x || room.max.y <= room.min.y || room.max.z <= room.min.z) throw new Error(`Invalid room: ${room.id}`);
    for (const door of template.doors) if (!finitePoint(door.hinge) || ![door.width, door.height, door.thickness, door.yaw, door.openAngle].every(Number.isFinite) || door.width <= 0 || door.height <= 0 || door.thickness <= 0 || door.rooms.some((id) => id !== null && !rooms.has(id))) throw new Error(`Invalid door: ${door.id}`);
    for (const node of template.nodes) if (!finitePoint(node.position) || (node.room !== null && !rooms.has(node.room))) throw new Error(`Invalid navigation node: ${node.id}`);
    for (const edge of template.edges) if (!nodes.has(edge.from) || !nodes.has(edge.to) || (edge.door !== undefined && !doors.has(edge.door))) throw new Error('Invalid building navigation edge');
    if (!finitePoint(template.entrance)) throw new Error('Invalid entrance');
    this.templates.set(template.id, template);
  }
  get(id: string): BuildingTemplate { const result = this.templates.get(id); if (!result) throw new Error(`Unknown building template: ${id}`); return result; }
  get all(): readonly BuildingTemplate[] { return [...this.templates.values()]; }
}
export const BUILDING_TEMPLATES = new BuildingTemplateRegistry();

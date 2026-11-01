import { buildingToWorld } from './coordinates';
import type { BuildingDescriptor, BuildingGraph, BuildingTemplate } from './types';

/** Explicit portals let the host navigator distinguish closed doors from stairs. */
export function createBuildingGraph(building: BuildingDescriptor, template: BuildingTemplate, isOpen: (door: string) => boolean): BuildingGraph {
  return {
    buildingId: building.id,
    nodes: template.nodes.map((node) => ({ ...node, position: buildingToWorld(building, node.position) })),
    edges: template.edges.map((edge) => ({ ...edge, blocked: edge.door !== undefined && !isOpen(edge.door) })),
  };
}
export function findBuildingPath(graph: BuildingGraph, from: string, to: string): string[] | undefined {
  if (!graph.nodes.some((n) => n.id === from) || !graph.nodes.some((n) => n.id === to)) return undefined;
  const parents = new Map<string, string | null>([[from, null]]), queue = [from];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (current === to) {
      const path: string[] = [];
      for (let id: string | null = to; id !== null; id = parents.get(id) ?? null) path.unshift(id);
      return path;
    }
    for (const edge of graph.edges) {
      if (edge.blocked) continue;
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : undefined;
      if (next !== undefined && !parents.has(next)) { parents.set(next, current); queue.push(next); }
    }
  }
  return undefined;
}

import { TerrainField } from './terrain-field';
import { tileSize, tileKey } from './tiles';
import type { TileRequest, TileResult } from './tiles';
import { CONFIG } from '../config';
import { createClimateSample } from './biomes';
import { clamp } from '../utils/math';
import { generateVegetation } from './vegetation-field';
import { generateRoadTile } from './road-geometry';

/**
 * Pure chunk builder. Runs inside a worker in production and directly in unit
 * tests. Heights are absolute; XZ positions are tile-local to protect precision.
 */
export function generateTile(request: TileRequest, terrain: TerrainField): TileResult {
  const n = request.segments, stride = n + 1, gridSize = stride * stride;
  const size = tileSize(request.level), step = size / n;
  const left = request.x * size, top = request.z * size;
  const skirt = Math.max(3, size * CONFIG.terrain.skirtFraction);
  const count = gridSize + 4 * stride;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const surface = new Float32Array(count * 3);
  const biomeWeights = new Float32Array(count * 4);
  const climate = createClimateSample();
  const heights = new Float32Array(gridSize);
  const indices = new Uint32Array(n * n * 6 + 4 * n * 6);
  let minHeight = Infinity, maxHeight = -Infinity;

  for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
    const index = iz * stride + ix;
    const h = terrain.height(left + ix * step, top + iz * step);
    heights[index] = h;
    minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h);
    positions[index * 3] = ix * step - size / 2;
    positions[index * 3 + 1] = h;
    positions[index * 3 + 2] = iz * step - size / 2;
  }

  const epsilon = Math.max(1, step * 0.5);
  for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) {
    const index = iz * stride + ix;
    const x = left + ix * step, z = top + iz * step, h = heights[index]!;
    const dx = (terrain.height(x + epsilon, z) - terrain.height(x - epsilon, z)) / (2 * epsilon);
    const dz = (terrain.height(x, z + epsilon) - terrain.height(x, z - epsilon)) / (2 * epsilon);
    const length = Math.hypot(dx, 1, dz);
    normals[index * 3] = -dx / length;
    normals[index * 3 + 1] = 1 / length;
    normals[index * 3 + 2] = -dz / length;
    terrain.sample(x, z, h, 1 - 1 / length, climate);
    terrain.biomes.color(x, z, climate, colors, index * 3);
    surface[index * 3] = climate.rock;
    surface[index * 3 + 1] = climate.snow;
    surface[index * 3 + 2] = climate.dominant;
    biomeWeights[index * 4] = climate.weights[0];
    biomeWeights[index * 4 + 1] = climate.weights[1];
    biomeWeights[index * 4 + 2] = climate.weights[2];
    biomeWeights[index * 4 + 3] = climate.weights[3];
  }

  let cursor = 0;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const a = iz * stride + ix, b = a + 1, c = a + stride, d = c + 1;
    indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
    indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
  }

  // Vertical skirts conceal T-junction cracks where LOD neighbours differ.
  const edges = [
    Array.from({ length: stride }, (_, i) => i),
    Array.from({ length: stride }, (_, i) => i * stride + n),
    Array.from({ length: stride }, (_, i) => n * stride + n - i),
    Array.from({ length: stride }, (_, i) => (n - i) * stride),
  ];
  let next = gridSize;
  for (const edge of edges) {
    const start = next;
    for (const source of edge) {
      for (let axis = 0; axis < 3; axis++) {
        positions[next * 3 + axis] = positions[source * 3 + axis]!;
        normals[next * 3 + axis] = normals[source * 3 + axis]!;
        colors[next * 3 + axis] = colors[source * 3 + axis]!;
        surface[next * 3 + axis] = surface[source * 3 + axis]!;
      }
      for (let axis = 0; axis < 4; axis++) biomeWeights[next * 4 + axis] = biomeWeights[source * 4 + axis]!;
      positions[next * 3 + 1] = positions[next * 3 + 1]! - skirt;
      next++;
    }
    for (let i = 0; i < n; i++) {
      const a = edge[i]!, b = edge[i + 1]!, c = start + i, d = c + 1;
      indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c;
      indices[cursor++] = b; indices[cursor++] = d; indices[cursor++] = c;
    }
  }

  // Root plants on the actual rendered triangles, not the smooth field: coarse
  // LODs would otherwise leave trunks floating above or buried under the mesh.
  const surfaceHeight = (x: number, z: number): number => {
    const fx = clamp((x - left) / step, 0, n - 0.00001);
    const fz = clamp((z - top) / step, 0, n - 0.00001);
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const a = heights[iz * stride + ix]!, b = heights[iz * stride + ix + 1]!;
    const c = heights[(iz + 1) * stride + ix]!, d = heights[(iz + 1) * stride + ix + 1]!;
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  };

  return {
    type: 'tile', id: request.id, epoch: request.epoch, key: tileKey(request),
    coord: { x: request.x, z: request.z, level: request.level, rootX: request.rootX, rootZ: request.rootZ },
    segments: n, positions, normals, colors, surface, biomeWeights, vegetation: generateVegetation(request, terrain.seed, terrain, surfaceHeight), road: generateRoadTile(request, terrain.roads, surfaceHeight), indices,
    minHeight: minHeight - skirt, maxHeight,
  };
}

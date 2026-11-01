import { TerrainField } from '../world/terrain-field';
import { generateTile } from '../world/terrain-generator';
import type { TileRequest } from '../world/tiles';

let field: TerrainField | undefined;
let fieldSeed = '';
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<TileRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

/** Height, normal and albedo data are built off the rendering thread. */
worker.onmessage = ({ data }: MessageEvent<TileRequest>) => {
  const request = data;
  try {
    if (!field || fieldSeed !== request.seed) {
      field = new TerrainField(request.seed);
      fieldSeed = request.seed;
    }
    const result = generateTile(request, field);
    worker.postMessage(result, [result.positions.buffer, result.normals.buffer, result.colors.buffer, result.surface.buffer, result.biomeWeights.buffer, result.vegetation.buffer, result.indices.buffer]);
  } catch (error) {
    worker.postMessage({ type: 'error', id: request.id, epoch: request.epoch, message: error instanceof Error ? error.message : String(error) }, []);
  }
};

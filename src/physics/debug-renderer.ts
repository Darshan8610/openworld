import { BufferAttribute, BufferGeometry, DynamicDrawUsage, LineBasicMaterial, LineSegments } from 'three/webgpu';
import { CONFIG } from '../config';
import type { PhysicsWorld } from './physics-world';

/**
 * Collider wireframes for developers. Rapier returns line pairs in physics-local
 * coordinates, which is exactly the render frame, so origin shifts need no work
 * here. Buffer capacity is fixed; overflow is clipped rather than grown.
 */
export class PhysicsDebugRenderer {
  readonly object: LineSegments;
  private readonly geometry = new BufferGeometry();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly material = new LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9 });
  private readonly vertexBudget: number;

  constructor(private readonly physics: PhysicsWorld, vertexBudget: number = CONFIG.physics.debugVertexBudget) {
    this.vertexBudget = vertexBudget;
    this.positions = new Float32Array(vertexBudget * 3);
    this.colors = new Float32Array(vertexBudget * 3);
    const positionAttribute = new BufferAttribute(this.positions, 3);
    const colorAttribute = new BufferAttribute(this.colors, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', positionAttribute);
    this.geometry.setAttribute('color', colorAttribute);
    this.geometry.setDrawRange(0, 0);
    this.object = new LineSegments(this.geometry, this.material);
    this.object.name = 'physics debug colliders';
    this.object.frustumCulled = false;
    this.object.renderOrder = 900;
    this.object.visible = false;
  }

  get visible(): boolean { return this.object.visible; }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
    if (visible) this.update();
  }

  /** Re-read collider geometry. Only called while the overlay is visible. */
  update(): void {
    if (!this.object.visible) return;
    const { vertices, colors } = this.physics.debugLines();
    // Rapier returns xyz per vertex and RGBA per vertex; three wants vertexColors
    // as RGB, so the alpha channel is dropped here.
    const count = Math.min(vertices.length / 3, this.vertexBudget);
    for (let vertex = 0; vertex < count; vertex++) {
      const p = vertex * 3;
      this.positions[p] = vertices[p]!;
      this.positions[p + 1] = vertices[p + 1]!;
      this.positions[p + 2] = vertices[p + 2]!;
      const c = vertex * 4;
      this.colors[p] = colors[c] ?? 1;
      this.colors[p + 1] = colors[c + 1] ?? 1;
      this.colors[p + 2] = colors[c + 2] ?? 1;
    }
    this.geometry.setDrawRange(0, count);
    const positionAttribute = this.geometry.getAttribute('position') as BufferAttribute;
    const colorAttribute = this.geometry.getAttribute('color') as BufferAttribute;
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    // Debug lines have no meaningful precomputed bounds.
    this.geometry.boundingSphere = null;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}

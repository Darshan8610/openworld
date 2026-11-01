import { BoxGeometry, DynamicDrawUsage, Group, InstancedMesh, MeshBasicNodeMaterial, Object3D } from 'three/webgpu';
import type { Point3, BuildingCollider } from '../../world/buildings/types';

/** One pooled debug draw, not one allocation per collider or frame. */
export class BuildingCollisionDebug {
  readonly group = new Group();
  private readonly geometry = new BoxGeometry(1, 1, 1);
  private readonly material = new MeshBasicNodeMaterial({ color: 0x8debce, wireframe: true, transparent: true, opacity: 0.65, depthTest: false });
  private readonly mesh = new InstancedMesh(this.geometry, this.material, 6000);
  private readonly dummy = new Object3D();
  constructor() {
    this.group.name = 'Building collision debug'; this.group.visible = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage); this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }
  update(colliders: readonly BuildingCollider[], origin: Point3): void {
    if (!this.group.visible) return;
    if (colliders.length > 6000) throw new Error('Building collision debug capacity exceeded');
    colliders.forEach((collider, index) => {
      this.dummy.position.set(collider.center.x - origin.x, collider.center.y - origin.y, collider.center.z - origin.z);
      this.dummy.rotation.set(0, collider.yaw, 0); this.dummy.scale.set(collider.half.x * 2, collider.half.y * 2, collider.half.z * 2);
      this.dummy.updateMatrix(); this.mesh.setMatrixAt(index, this.dummy.matrix);
    });
    this.mesh.count = colliders.length; this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose(): void { this.group.removeFromParent(); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}

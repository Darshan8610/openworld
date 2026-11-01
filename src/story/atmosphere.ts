import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry,
} from 'three/webgpu';
import type { StoryBounds } from './campaign';

/**
 * Night dressing for Blackwood Valley — the photoreal pass on a budget.
 *
 * • Abandoned cars on the highway shoulder with hazard lights blinking slowly
 *   (Act I's "cars nobody came back for" beat).
 * • The diner's dying amber sign and the motel's red vacancy panel, both
 *   flickering on their own phase so the road never feels mirrored.
 * • A pulsing amber beacon and crossed tape at the collapsed north tunnel.
 * • Red reflector dots along the south coast guardrail.
 *
 * Everything is a handful of primitives with emissive materials toggled on a
 * clock in `update()` — no textures, no lights added to the render budget,
 * identical on WebGPU and WebGL2. Fully disposed with the story layer.
 */

export interface AtmosphereOptions {
  readonly ground: (x: number, z: number) => number;
  readonly roadZ: (x: number) => number;
  readonly bounds: StoryBounds;
  /** Landmark anchors (signs sit on their forecourts). */
  readonly diner: { x: number; z: number };
  readonly motel: { x: number; z: number };
}

interface Blinker {
  readonly mesh: Mesh;
  readonly phase: number;
  readonly rate: number;
  readonly style: 'hazard' | 'beacon' | 'sign' | 'reflector';
}

const PAINTS = [0x1d2227, 0x2b2621, 0x232a2e, 0x30211d] as const;

export class StoryAtmosphere {
  readonly group = new Group();
  private readonly blinkers: Blinker[] = [];
  private clock = 0;

  constructor(private readonly options: AtmosphereOptions) {
    this.group.name = 'story/atmosphere';
    this.buildWrecks();
    this.buildSigns();
    this.buildTunnelBeacon();
    this.buildCoastReflectors();
  }

  /** Advance every blinker; called once per rendered frame. */
  update(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;
    for (const blinker of this.blinkers) {
      const material = blinker.mesh.material as MeshStandardMaterial;
      material.emissiveIntensity = this.levelFor(blinker);
    }
  }

  /** Pure blink envelope — exposed so tests can assert the cadence. */
  levelFor(blinker: Pick<Blinker, 'phase' | 'rate' | 'style'>): number {
    const t = this.clock;
    switch (blinker.style) {
      case 'hazard': {
        // Slow alternating double-blink: left lamp, pause, right lamp, pause.
        // Phase encodes the lamp side (0 = left, 1 = right), never a time shift.
        const cycle = (t * blinker.rate) % 4;
        const left = cycle < 1.7;
        const right = cycle >= 2 && cycle < 3.7;
        const lit = blinker.phase >= 1 ? right : left;
        return lit ? 2.6 : 0.08;
      }
      case 'beacon': {
        const pulse = Math.sin((t + blinker.phase) * blinker.rate * Math.PI * 2);
        return pulse > 0.15 ? 3.2 : 0.15;
      }
      case 'sign': {
        // Mostly steady with rare, brief dropouts — a dying transformer.
        const dropout = Math.sin(t * 0.7 + blinker.phase) > 0.985
          || Math.sin(t * 2.9 + blinker.phase) < -0.995;
        return dropout ? 0.25 : 1.9 + Math.sin(t * blinker.rate + blinker.phase) * 0.14;
      }
      case 'reflector':
        return 0.7 + Math.sin(t * blinker.rate + blinker.phase) * 0.35;
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const entry of material) entry.dispose();
      else material?.dispose();
    });
    this.group.clear();
    this.blinkers.length = 0;
  }

  // ---- builders ------------------------------------------------------------

  private makeBlinker(mesh: Mesh, style: Blinker['style'], phase: number, rate: number, color: number): void {
    const material = new MeshStandardMaterial({
      color: 0x0a0a0a, roughness: 0.6, emissive: color, emissiveIntensity: 0.1,
    });
    mesh.material = material;
    this.blinkers.push({ mesh, phase, rate, style });
    this.group.add(mesh);
  }

  private buildWrecks(): void {
    // Four wrecks strung along the highway between the arrival and the motel,
    // each on its own shoulder with a different resting angle.
    const placements = [
      { dx: 64, side: -1, yaw: 0.28, paint: PAINTS[0]! },
      { dx: 138, side: 1, yaw: -0.52, paint: PAINTS[1]! },
      { dx: 214, side: -1, yaw: 0.09, paint: PAINTS[2]! },
      { dx: 302, side: 1, yaw: 2.9, paint: PAINTS[3]! },
    ];
    const startX = this.options.diner.x - 40;
    for (const [index, place] of placements.entries()) {
      const x = startX + place.dx;
      const z = this.options.roadZ(x) + place.side * 4.6;
      const y = this.options.ground(x, z);
      const car = new Group();
      const paint = new MeshStandardMaterial({ color: place.paint, roughness: 0.62, metalness: 0.55 });
      const body = new Mesh(new BoxGeometry(4.3, 0.72, 1.86), paint);
      body.position.y = 0.62;
      const cabin = new Mesh(new BoxGeometry(2.15, 0.6, 1.66), paint);
      cabin.position.set(-0.25, 1.24, 0);
      car.add(body, cabin);
      const tyre = new MeshStandardMaterial({ color: 0x0b0c0d, roughness: 1 });
      for (const [wx, wz] of [[1.45, 0.95], [1.45, -0.95], [-1.45, 0.95], [-1.45, -0.95]] as const) {
        const wheel = new Mesh(new CylinderGeometry(0.34, 0.34, 0.24, 10), tyre);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(wx, 0.34, wz);
        car.add(wheel);
      }
      // Hazard lamps at the rear corners (the direction facing oncoming traffic).
      for (const [side, phase] of [[-0.72, 0], [0.72, 1]] as const) {
        const lamp = new Mesh(new BoxGeometry(0.1, 0.14, 0.22), new MeshStandardMaterial());
        lamp.position.set(-2.16, 0.78, side);
        // Slight per-car drift so the wrecks never blink as one chorus.
        this.makeBlinker(lamp, 'hazard', phase, 1.05 + index * 0.09, 0xff9a2a);
        car.add(lamp);
      }
      car.position.set(x, y, z);
      car.rotation.y = place.yaw + (place.side > 0 ? 0.12 : -0.08);
      this.group.add(car);
    }
  }

  private buildSigns(): void {
    // Diner: a warm amber panel on a pole, guttering like a bad ballast.
    this.buildPoleSign(
      this.options.diner.x + 15, this.options.diner.z + 9,
      3.8, 1.5, 0xffb347, 'sign', 0, 7.4,
    );
    // Motel: the red vacancy panel at the courtyard entrance.
    this.buildPoleSign(
      this.options.motel.x + 12, this.options.motel.z + 12,
      3.2, 1.3, 0xff3b30, 'sign', 3.7, 5.1,
    );
  }

  private buildPoleSign(x: number, z: number, width: number, height: number, color: number, style: Blinker['style'], phase: number, rate: number): void {
    const y = this.options.ground(x, z);
    const pole = new Mesh(
      new CylinderGeometry(0.09, 0.12, 3.4, 8),
      new MeshStandardMaterial({ color: 0x33383d, roughness: 0.5, metalness: 0.7 }),
    );
    pole.position.set(x, y + 1.7, z);
    this.group.add(pole);
    const panel = new Mesh(new BoxGeometry(width, height, 0.16), new MeshStandardMaterial());
    panel.position.set(x, y + 3.4 + height * 0.2, z);
    this.makeBlinker(panel, style, phase, rate, color);
  }

  private buildTunnelBeacon(): void {
    // Crossed tape + pulsing amber beacon at the collapsed north tunnel.
    const midX = (this.options.bounds.minX + this.options.bounds.maxX) / 2;
    const z = this.options.bounds.minZ + 7.4;
    const y = this.options.ground(midX, z);
    const tape = new Mesh(
      new BoxGeometry(16, 0.3, 0.08),
      new MeshStandardMaterial({ color: 0xd7c43a, roughness: 0.75, emissive: 0x6b5f10, emissiveIntensity: 0.35 }),
    );
    tape.position.set(midX - 14, y + 1.15, z);
    tape.rotation.y = 0.05;
    this.group.add(tape);
    const barricade = new Mesh(
      new BoxGeometry(2.6, 1.1, 0.3),
      new MeshStandardMaterial({ color: 0xc9a227, roughness: 0.8 }),
    );
    barricade.position.set(midX - 21, y + 0.55, z + 0.4);
    barricade.rotation.y = -0.2;
    this.group.add(barricade);
    const beacon = new Mesh(new SphereGeometry(0.16, 10, 8), new MeshStandardMaterial());
    beacon.position.set(midX - 21, y + 1.25, z + 0.4);
    this.makeBlinker(beacon, 'beacon', 0, 0.9, 0xff7b00);
  }

  private buildCoastReflectors(): void {
    // Red dots strung along the submerged south guardrail.
    const { minX, maxX, maxZ } = this.options.bounds;
    const count = 9;
    for (let i = 0; i < count; i++) {
      const x = minX + 40 + ((maxX - minX - 80) * i) / (count - 1);
      const z = maxZ - 1.5;
      const y = this.options.ground(x, z);
      const dot = new Mesh(new BoxGeometry(0.14, 0.14, 0.08), new MeshStandardMaterial());
      dot.position.set(x, y + 1.05, z);
      this.makeBlinker(dot, 'reflector', i * 0.8, 1.6, 0xff2a1f);
    }
  }
}

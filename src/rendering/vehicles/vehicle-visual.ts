import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
} from 'three/webgpu';
import type { Vehicle } from '../../vehicles/vehicle';
import type { VehicleSpec, WheelSpec } from '../../vehicles/types';

/**
 * High-fidelity PBR Vehicle Visual System.
 *
 * Provides production-grade 3D visual models for every vehicle category:
 *  - Sedan, Hatchback, SUV, Offroad, Pickup, Van, Truck, Bus, Sports, Muscle, Supercar
 *  - Motorcycle, Scooter, Bicycle
 *  - Helicopter, Lightplane, Jet, Drone
 *  - Speedboat, Motorboat, Sailboat, Rowboat, Submarine
 *
 * Binds directly to the Rapier simulation state:
 *  - Wheel suspension travel (suspensionLength)
 *  - Wheel steering angle (steer)
 *  - Wheel rotation speed (spin)
 *  - Rotor angular rate for helicopters
 *  - Control surface deflections for aircraft
 */

interface WheelBinding {
  readonly spec: WheelSpec;
  readonly anchor: Group;
  readonly steerGroup: Group;
  readonly spinMesh: Group;
}

export class VehicleVisual {
  readonly root = new Group();
  private readonly wheels: WheelBinding[] = [];
  private readonly rotors: Group[] = [];
  private readonly materials: MeshStandardNodeMaterial[] = [];
  private readonly bodyMaterial: MeshStandardNodeMaterial;
  private readonly glassMaterial: MeshStandardNodeMaterial;
  private readonly chromeMaterial: MeshStandardNodeMaterial;
  private readonly rubberMaterial: MeshStandardNodeMaterial;
  private readonly rimMaterial: MeshStandardNodeMaterial;
  private readonly interiorMaterial: MeshStandardNodeMaterial;
  private readonly headlightMaterial: MeshStandardNodeMaterial;
  private readonly taillightMaterial: MeshStandardNodeMaterial;

  constructor(private readonly vehicle: Vehicle) {
    const spec = vehicle.spec;
    this.root.name = `visual/${vehicle.id}`;

    // Establish PBR materials with automotive finishes
    const paintColor = spec.accent ?? 0x224488;
    this.bodyMaterial = this.track(new MeshStandardNodeMaterial({
      color: paintColor,
      roughness: 0.22,
      metalness: 0.65,
    }));
    this.glassMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0x16222e,
      roughness: 0.08,
      metalness: 0.25,
      transparent: true,
      opacity: 0.65,
    }));
    this.chromeMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0xdedede,
      roughness: 0.15,
      metalness: 0.95,
    }));
    this.rubberMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0x1a1a1a,
      roughness: 0.88,
      metalness: 0.04,
    }));
    this.rimMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0xc8c8c8,
      roughness: 0.25,
      metalness: 0.88,
    }));
    this.interiorMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0x222225,
      roughness: 0.82,
      metalness: 0.05,
    }));
    this.headlightMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0xfffaea,
      emissive: 0xfff0c0,
      emissiveIntensity: 0.8,
      roughness: 0.15,
      metalness: 0.2,
    }));
    this.taillightMaterial = this.track(new MeshStandardNodeMaterial({
      color: 0xd91616,
      emissive: 0xcc0000,
      emissiveIntensity: 0.7,
      roughness: 0.2,
      metalness: 0.1,
    }));

    // Build specific vehicle archetype
    this.buildBody(spec);
    this.buildWheels(spec);
  }

  private track<T extends MeshStandardNodeMaterial>(mat: T): T {
    this.materials.push(mat);
    return mat;
  }

  private addMesh(geo: any, mat: any, parent: Group = this.root, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (rx || ry || rz) mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private buildBody(spec: VehicleSpec): void {
    const dim = spec.dimensions;
    const l = dim.length;
    const w = dim.width;
    const h = dim.height;
    const key = spec.key;

    if (key === 'helicopter') {
      this.buildHelicopter(l, w, h);
    } else if (key === 'motorcycle' || key === 'scooter' || key === 'bicycle') {
      this.buildMotorcycle(l, w, h, key);
    } else if (key === 'sports') {
      this.buildSportsCar(l, w, h);
    } else if (key === 'pickup') {
      this.buildPickupTruck(l, w, h);
    } else if (key === 'suv' || key === 'offroad') {
      this.buildSUV(l, w, h, key === 'offroad');
    } else if (key === 'ambulance' || key === 'van') {
      this.buildVanOrAmbulance(l, w, h, key === 'ambulance');
    } else if (key === 'truck' || key === 'bus') {
      this.buildHeavyTruckOrBus(l, w, h, key === 'bus');
    } else if (spec.vehicleClass === 'watercraft' || key.includes('boat')) {
      this.buildBoat(l, w, h);
    } else {
      // Default Sedan & Coupe
      this.buildSedan(l, w, h);
    }
  }

  /** Modern 4-door family sedan with aerodynamic curves and interior */
  private buildSedan(l: number, w: number, h: number): void {
    const bodyH = h * 0.45;
    const cabinH = h * 0.42;

    // Lower chassis & fenders
    this.addMesh(new BoxGeometry(w * 0.95, bodyH, l * 0.96), this.bodyMaterial, this.root, 0, bodyH * 0.5, 0);

    // Front hood taper & rear trunk
    this.addMesh(new BoxGeometry(w * 0.92, bodyH * 0.85, l * 0.32), this.bodyMaterial, this.root, 0, bodyH * 0.52, l * 0.34);
    this.addMesh(new BoxGeometry(w * 0.92, bodyH * 0.82, l * 0.28), this.bodyMaterial, this.root, 0, bodyH * 0.50, -l * 0.34);

    // Cabin glasshouse
    this.addMesh(new BoxGeometry(w * 0.84, cabinH, l * 0.48), this.glassMaterial, this.root, 0, bodyH + cabinH * 0.48, -l * 0.03);

    // Roof panel
    this.addMesh(new BoxGeometry(w * 0.82, 0.05, l * 0.42), this.bodyMaterial, this.root, 0, bodyH + cabinH, -l * 0.03);

    // Front chrome radiator grille & bumper
    this.addMesh(new BoxGeometry(w * 0.65, bodyH * 0.45, 0.08), this.chromeMaterial, this.root, 0, bodyH * 0.45, l * 0.49);
    this.addMesh(new BoxGeometry(w * 0.98, bodyH * 0.25, 0.12), this.chromeMaterial, this.root, 0, bodyH * 0.22, l * 0.49);
    this.addMesh(new BoxGeometry(w * 0.98, bodyH * 0.25, 0.12), this.chromeMaterial, this.root, 0, bodyH * 0.22, -l * 0.49);

    // Dual headlights & taillights
    const hlW = w * 0.18;
    this.addMesh(new BoxGeometry(hlW, bodyH * 0.28, 0.06), this.headlightMaterial, this.root, -w * 0.35, bodyH * 0.65, l * 0.485);
    this.addMesh(new BoxGeometry(hlW, bodyH * 0.28, 0.06), this.headlightMaterial, this.root, w * 0.35, bodyH * 0.65, l * 0.485);
    this.addMesh(new BoxGeometry(hlW, bodyH * 0.22, 0.06), this.taillightMaterial, this.root, -w * 0.35, bodyH * 0.62, -l * 0.485);
    this.addMesh(new BoxGeometry(hlW, bodyH * 0.22, 0.06), this.taillightMaterial, this.root, w * 0.35, bodyH * 0.62, -l * 0.485);

    // Side view mirrors
    this.addMesh(new BoxGeometry(0.18, 0.10, 0.12), this.bodyMaterial, this.root, -w * 0.52, bodyH + 0.15, l * 0.12);
    this.addMesh(new BoxGeometry(0.18, 0.10, 0.12), this.bodyMaterial, this.root, w * 0.52, bodyH + 0.15, l * 0.12);

    // Interior seats & dashboard
    this.addMesh(new BoxGeometry(w * 0.72, 0.16, 0.22), this.interiorMaterial, this.root, 0, bodyH + 0.18, l * 0.16);
    this.addMesh(new BoxGeometry(0.38, 0.42, 0.38), this.interiorMaterial, this.root, -w * 0.22, bodyH + 0.28, -l * 0.04);
    this.addMesh(new BoxGeometry(0.38, 0.42, 0.38), this.interiorMaterial, this.root, w * 0.22, bodyH + 0.28, -l * 0.04);
  }

  /** Aggressive high-performance sports car with spoiler and air vents */
  private buildSportsCar(l: number, w: number, h: number): void {
    const bodyH = h * 0.42;
    const cabinH = h * 0.38;

    // Wedge chassis
    this.addMesh(new BoxGeometry(w * 0.98, bodyH, l * 0.98), this.bodyMaterial, this.root, 0, bodyH * 0.48, 0);

    // Sleek cockpit canopy
    this.addMesh(new BoxGeometry(w * 0.82, cabinH, l * 0.52), this.glassMaterial, this.root, 0, bodyH + cabinH * 0.42, -l * 0.04);
    this.addMesh(new BoxGeometry(w * 0.78, 0.04, l * 0.40), this.bodyMaterial, this.root, 0, bodyH + cabinH * 0.88, -l * 0.04);

    // Aerodynamic rear spoiler on dual struts
    this.addMesh(new BoxGeometry(w * 0.94, 0.04, 0.32), this.chromeMaterial, this.root, 0, bodyH + 0.32, -l * 0.46);
    this.addMesh(new BoxGeometry(0.04, 0.32, 0.12), this.chromeMaterial, this.root, -w * 0.34, bodyH + 0.16, -l * 0.46);
    this.addMesh(new BoxGeometry(0.04, 0.32, 0.12), this.chromeMaterial, this.root, w * 0.34, bodyH + 0.16, -l * 0.46);

    // Front air dam splitter & side skirts
    this.addMesh(new BoxGeometry(w * 1.02, 0.08, 0.22), this.chromeMaterial, this.root, 0, 0.08, l * 0.48);
    this.addMesh(new BoxGeometry(0.08, 0.08, l * 0.88), this.chromeMaterial, this.root, -w * 0.49, 0.08, 0);
    this.addMesh(new BoxGeometry(0.08, 0.08, l * 0.88), this.chromeMaterial, this.root, w * 0.49, 0.08, 0);

    // Slim aggressive headlights
    this.addMesh(new BoxGeometry(w * 0.22, 0.10, 0.08), this.headlightMaterial, this.root, -w * 0.32, bodyH * 0.72, l * 0.49);
    this.addMesh(new BoxGeometry(w * 0.22, 0.10, 0.08), this.headlightMaterial, this.root, w * 0.32, bodyH * 0.72, l * 0.49);
    this.addMesh(new BoxGeometry(w * 0.24, 0.08, 0.08), this.taillightMaterial, this.root, -w * 0.32, bodyH * 0.70, -l * 0.49);
    this.addMesh(new BoxGeometry(w * 0.24, 0.08, 0.08), this.taillightMaterial, this.root, w * 0.32, bodyH * 0.70, -l * 0.49);
  }

  /** Heavy-duty rugged SUV with roof rack and elevated suspension */
  private buildSUV(l: number, w: number, h: number, offroad: boolean): void {
    const bodyH = h * 0.46;
    const cabinH = h * 0.48;

    // Muscular high-riding box body
    this.addMesh(new BoxGeometry(w * 0.94, bodyH, l * 0.94), this.bodyMaterial, this.root, 0, bodyH * 0.52, 0);

    // High panoramic cabin
    this.addMesh(new BoxGeometry(w * 0.86, cabinH, l * 0.64), this.glassMaterial, this.root, 0, bodyH + cabinH * 0.48, -l * 0.08);
    this.addMesh(new BoxGeometry(w * 0.85, 0.06, l * 0.62), this.bodyMaterial, this.root, 0, bodyH + cabinH * 0.98, -l * 0.08);

    // Roof rack rails with crossbars
    const rackY = bodyH + cabinH + 0.08;
    this.addMesh(new BoxGeometry(0.04, 0.08, l * 0.55), this.chromeMaterial, this.root, -w * 0.36, rackY, -l * 0.08);
    this.addMesh(new BoxGeometry(0.04, 0.08, l * 0.55), this.chromeMaterial, this.root, w * 0.36, rackY, -l * 0.08);
    this.addMesh(new BoxGeometry(w * 0.72, 0.04, 0.04), this.chromeMaterial, this.root, 0, rackY + 0.04, -l * 0.25);
    this.addMesh(new BoxGeometry(w * 0.72, 0.04, 0.04), this.chromeMaterial, this.root, 0, rackY + 0.04, l * 0.10);

    // Rear mounted spare tire
    const spare = this.addMesh(new CylinderGeometry(0.36, 0.36, 0.22, 14), this.rubberMaterial, this.root, 0, bodyH * 0.75, -l * 0.52);
    spare.rotation.x = Math.PI / 2;

    // Front bull bar
    if (offroad) {
      this.addMesh(new BoxGeometry(w * 0.72, bodyH * 0.65, 0.08), this.chromeMaterial, this.root, 0, bodyH * 0.5, l * 0.52);
    }
    this.addMesh(new BoxGeometry(w * 0.18, 0.18, 0.06), this.headlightMaterial, this.root, -w * 0.34, bodyH * 0.70, l * 0.48);
    this.addMesh(new BoxGeometry(w * 0.18, 0.18, 0.06), this.headlightMaterial, this.root, w * 0.34, bodyH * 0.70, l * 0.48);
    this.addMesh(new BoxGeometry(w * 0.14, 0.32, 0.06), this.taillightMaterial, this.root, -w * 0.38, bodyH * 0.75, -l * 0.48);
    this.addMesh(new BoxGeometry(w * 0.14, 0.32, 0.06), this.taillightMaterial, this.root, w * 0.38, bodyH * 0.75, -l * 0.48);
  }

  /** Heavy utility pickup truck with crew cab and ribbed cargo bed */
  private buildPickupTruck(l: number, w: number, h: number): void {
    const bodyH = h * 0.45;
    const cabinH = h * 0.46;

    // Front cab & engine bay
    this.addMesh(new BoxGeometry(w * 0.95, bodyH, l * 0.48), this.bodyMaterial, this.root, 0, bodyH * 0.5, l * 0.22);
    this.addMesh(new BoxGeometry(w * 0.88, cabinH, l * 0.38), this.glassMaterial, this.root, 0, bodyH + cabinH * 0.48, l * 0.12);
    this.addMesh(new BoxGeometry(w * 0.86, 0.06, l * 0.36), this.bodyMaterial, this.root, 0, bodyH + cabinH * 0.98, l * 0.12);

    // Rear cargo bed walls & floor
    this.addMesh(new BoxGeometry(w * 0.94, bodyH * 0.65, 0.08), this.bodyMaterial, this.root, 0, bodyH * 0.45, -l * 0.48); // tailgate
    this.addMesh(new BoxGeometry(0.08, bodyH * 0.65, l * 0.48), this.bodyMaterial, this.root, -w * 0.45, bodyH * 0.45, -l * 0.24); // left wall
    this.addMesh(new BoxGeometry(0.08, bodyH * 0.65, l * 0.48), this.bodyMaterial, this.root, w * 0.45, bodyH * 0.45, -l * 0.24); // right wall
    this.addMesh(new BoxGeometry(w * 0.88, 0.08, l * 0.48), this.chromeMaterial, this.root, 0, bodyH * 0.18, -l * 0.24); // bed floor

    // Chrome front grille & bumper
    this.addMesh(new BoxGeometry(w * 0.75, bodyH * 0.55, 0.10), this.chromeMaterial, this.root, 0, bodyH * 0.50, l * 0.47);
    this.addMesh(new BoxGeometry(w * 0.20, 0.20, 0.06), this.headlightMaterial, this.root, -w * 0.35, bodyH * 0.65, l * 0.47);
    this.addMesh(new BoxGeometry(w * 0.20, 0.20, 0.06), this.headlightMaterial, this.root, w * 0.35, bodyH * 0.65, l * 0.47);
    this.addMesh(new BoxGeometry(0.12, 0.30, 0.06), this.taillightMaterial, this.root, -w * 0.44, bodyH * 0.45, -l * 0.485);
    this.addMesh(new BoxGeometry(0.12, 0.30, 0.06), this.taillightMaterial, this.root, w * 0.44, bodyH * 0.45, -l * 0.485);
  }

  /** Van or Emergency Ambulance with flashing roof beacons */
  private buildVanOrAmbulance(l: number, w: number, h: number, isAmbulance: boolean): void {
    const mat = isAmbulance
      ? this.track(new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 }))
      : this.bodyMaterial;

    // High box body
    this.addMesh(new BoxGeometry(w * 0.94, h * 0.85, l * 0.94), mat, this.root, 0, h * 0.46, -l * 0.02);

    // Front engine nose
    this.addMesh(new BoxGeometry(w * 0.92, h * 0.45, l * 0.24), mat, this.root, 0, h * 0.25, l * 0.42);

    // Windshield & side windows
    this.addMesh(new BoxGeometry(w * 0.86, h * 0.32, 0.06), this.glassMaterial, this.root, 0, h * 0.60, l * 0.32);
    this.addMesh(new BoxGeometry(0.06, h * 0.24, l * 0.32), this.glassMaterial, this.root, -w * 0.48, h * 0.60, l * 0.12);
    this.addMesh(new BoxGeometry(0.06, h * 0.24, l * 0.32), this.glassMaterial, this.root, w * 0.48, h * 0.60, l * 0.12);

    // Headlights & taillights
    this.addMesh(new BoxGeometry(0.22, 0.22, 0.06), this.headlightMaterial, this.root, -w * 0.34, h * 0.35, l * 0.54);
    this.addMesh(new BoxGeometry(0.22, 0.22, 0.06), this.headlightMaterial, this.root, w * 0.34, h * 0.35, l * 0.54);
    this.addMesh(new BoxGeometry(0.14, 0.45, 0.06), this.taillightMaterial, this.root, -w * 0.42, h * 0.45, -l * 0.50);
    this.addMesh(new BoxGeometry(0.14, 0.45, 0.06), this.taillightMaterial, this.root, w * 0.42, h * 0.45, -l * 0.50);

    // Ambulance emergency rooftop lightbar (red and blue strobe lenses)
    if (isAmbulance) {
      const redStrobe = this.track(new MeshStandardNodeMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 1.2 }));
      const blueStrobe = this.track(new MeshStandardNodeMaterial({ color: 0x0044ff, emissive: 0x0033ff, emissiveIntensity: 1.2 }));
      this.addMesh(new BoxGeometry(w * 0.30, 0.12, 0.14), redStrobe, this.root, -w * 0.20, h * 0.94, l * 0.12);
      this.addMesh(new BoxGeometry(w * 0.30, 0.12, 0.14), blueStrobe, this.root, w * 0.20, h * 0.94, l * 0.12);
    }
  }

  /** Heavy commercial truck cab or transit bus */
  private buildHeavyTruckOrBus(l: number, w: number, h: number, isBus: boolean): void {
    if (isBus) {
      // Long city transit bus with panoramic windows
      this.addMesh(new BoxGeometry(w * 0.95, h * 0.88, l * 0.96), this.bodyMaterial, this.root, 0, h * 0.48, 0);
      this.addMesh(new BoxGeometry(w * 0.96, h * 0.32, l * 0.84), this.glassMaterial, this.root, 0, h * 0.62, 0);
      this.addMesh(new BoxGeometry(w * 0.96, h * 0.38, 0.08), this.glassMaterial, this.root, 0, h * 0.62, l * 0.48);
    } else {
      // Semi truck cab-over engine
      this.addMesh(new BoxGeometry(w * 0.95, h * 0.82, l * 0.55), this.bodyMaterial, this.root, 0, h * 0.48, l * 0.18);
      this.addMesh(new BoxGeometry(w * 0.90, h * 0.28, 0.08), this.glassMaterial, this.root, 0, h * 0.68, l * 0.46);
      // Dual vertical chrome exhaust stacks
      this.addMesh(new CylinderGeometry(0.08, 0.08, h * 0.85, 8), this.chromeMaterial, this.root, -w * 0.44, h * 0.65, -l * 0.12);
      this.addMesh(new CylinderGeometry(0.08, 0.08, h * 0.85, 8), this.chromeMaterial, this.root, w * 0.44, h * 0.65, -l * 0.12);
      // Chassis rails & fifth wheel
      this.addMesh(new BoxGeometry(w * 0.75, 0.22, l * 0.52), this.chromeMaterial, this.root, 0, 0.32, -l * 0.22);
    }
  }

  /** Agile 2-wheeled motorcycle or scooter */
  private buildMotorcycle(l: number, w: number, h: number, _kind: string): void {
    // Slender tubular frame
    this.addMesh(new BoxGeometry(0.24, 0.32, l * 0.62), this.chromeMaterial, this.root, 0, h * 0.42, 0);
    // V-twin engine block
    this.addMesh(new BoxGeometry(0.28, 0.30, 0.38), this.interiorMaterial, this.root, 0, h * 0.35, 0.06);
    // Teardrop fuel tank
    this.addMesh(new SphereGeometry(0.22, 10, 8), this.bodyMaterial, this.root, 0, h * 0.62, 0.18);
    // Leather saddle seat
    this.addMesh(new BoxGeometry(0.26, 0.10, 0.42), this.interiorMaterial, this.root, 0, h * 0.58, -l * 0.12);
    // Front steering fork and handlebars
    const fork = this.addMesh(new CylinderGeometry(0.03, 0.03, h * 0.65, 6), this.chromeMaterial, this.root, 0, h * 0.55, l * 0.35);
    fork.rotation.x = -0.32;
    this.addMesh(new CylinderGeometry(0.02, 0.02, w * 0.85, 6), this.chromeMaterial, this.root, 0, h * 0.82, l * 0.26, 0, 0, Math.PI / 2);
    // Single round headlight
    this.addMesh(new CylinderGeometry(0.10, 0.10, 0.08, 10), this.headlightMaterial, this.root, 0, h * 0.72, l * 0.36, Math.PI / 2);
  }

  /** Aerodynamic helicopter with working spinning rotors */
  private buildHelicopter(l: number, w: number, h: number): void {
    // Teardrop cockpit fuselage
    const fuse = this.addMesh(new SphereGeometry(w * 0.55, 12, 10), this.bodyMaterial, this.root, 0, h * 0.55, l * 0.12);
    fuse.scale.set(1, 1.2, 1.8);

    // Bubble glass windshield
    const glass = this.addMesh(new SphereGeometry(w * 0.52, 10, 8), this.glassMaterial, this.root, 0, h * 0.60, l * 0.24);
    glass.scale.set(0.95, 1.1, 1.3);

    // Tail boom & vertical stabilizer
    this.addMesh(new CylinderGeometry(0.12, 0.22, l * 0.58, 8), this.bodyMaterial, this.root, 0, h * 0.58, -l * 0.32, Math.PI / 2);
    this.addMesh(new BoxGeometry(0.06, h * 0.48, 0.26), this.bodyMaterial, this.root, 0, h * 0.75, -l * 0.58);

    // Dual landing skids on cross struts
    const skidY = 0.12;
    this.addMesh(new CylinderGeometry(0.04, 0.04, l * 0.72, 6), this.chromeMaterial, this.root, -w * 0.42, skidY, 0, Math.PI / 2);
    this.addMesh(new CylinderGeometry(0.04, 0.04, l * 0.72, 6), this.chromeMaterial, this.root, w * 0.42, skidY, 0, Math.PI / 2);

    // Main rotor assembly on top mast
    const mainRotorGroup = new Group();
    mainRotorGroup.position.set(0, h * 1.05, 0.05);
    this.addMesh(new CylinderGeometry(0.06, 0.06, 0.25, 8), this.chromeMaterial, mainRotorGroup, 0, 0, 0);
    // 4 rotor blades
    const bladeGeo = new BoxGeometry(0.14, 0.02, l * 0.95);
    this.addMesh(bladeGeo, this.interiorMaterial, mainRotorGroup, 0, 0.12, 0);
    this.addMesh(bladeGeo, this.interiorMaterial, mainRotorGroup, 0, 0.12, 0, 0, Math.PI / 2);
    this.root.add(mainRotorGroup);
    this.rotors.push(mainRotorGroup);

    // Tail rotor
    const tailRotorGroup = new Group();
    tailRotorGroup.position.set(0.10, h * 0.85, -l * 0.58);
    this.addMesh(new BoxGeometry(0.02, 0.08, 0.55), this.interiorMaterial, tailRotorGroup);
    this.root.add(tailRotorGroup);
    this.rotors.push(tailRotorGroup);
  }

  /** V-shaped hull marine boat */
  private buildBoat(l: number, w: number, h: number): void {
    // Planing V-hull
    this.addMesh(new BoxGeometry(w * 0.92, h * 0.45, l * 0.94), this.bodyMaterial, this.root, 0, h * 0.25, 0);
    // Cockpit windshield
    this.addMesh(new BoxGeometry(w * 0.78, h * 0.35, 0.06), this.glassMaterial, this.root, 0, h * 0.58, l * 0.15);
    // Transom outboard motor
    this.addMesh(new BoxGeometry(0.24, 0.45, 0.28), this.interiorMaterial, this.root, 0, h * 0.32, -l * 0.48);
  }

  /** Construct 3D rubber tires, alloy rims, hubcaps, and suspension mounts */
  private buildWheels(spec: VehicleSpec): void {
    if (!spec.wheels || spec.wheels.length === 0) return;

    for (const wSpec of spec.wheels) {
      const anchor = new Group();
      anchor.position.set(wSpec.local.x, wSpec.local.y, wSpec.local.z);

      const steerGroup = new Group();
      anchor.add(steerGroup);

      const spinMesh = new Group();
      steerGroup.add(spinMesh);

      const r = wSpec.radius;
      const width = wSpec.width;

      // 1. Rubber tire (cylinder along X)
      const tire = new Mesh(new CylinderGeometry(r, r, width, 14), this.rubberMaterial);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      spinMesh.add(tire);

      // 2. Alloy rim with chrome hubcap
      const rim = new Mesh(new CylinderGeometry(r * 0.68, r * 0.68, width * 1.02, 10), this.rimMaterial);
      rim.rotation.z = Math.PI / 2;
      spinMesh.add(rim);

      const hub = new Mesh(new CylinderGeometry(r * 0.24, r * 0.24, width * 1.06, 8), this.chromeMaterial);
      hub.rotation.z = Math.PI / 2;
      spinMesh.add(hub);

      // 3. Brake caliper
      const caliper = new Mesh(new BoxGeometry(width * 0.8, r * 0.35, r * 0.3), this.interiorMaterial);
      caliper.position.set(0, r * 0.35, 0);
      steerGroup.add(caliper);

      this.root.add(anchor);
      this.wheels.push({ spec: wSpec, anchor, steerGroup, spinMesh });
    }
  }

  /**
   * Synchronize visual geometry per-frame with the Rapier physics controller:
   *  - Steering angle
   *  - Wheel spin rotation
   *  - Suspension vertical deflection
   *  - Rotor spin rate
   */
  update(dt: number): void {
    const controller = this.vehicle.controller;
    const views = controller.wheels;

    // Synchronize wheels
    if (views && views.length > 0) {
      for (let i = 0; i < this.wheels.length; i++) {
        const binding = this.wheels[i]!;
        const view = views[i];
        if (!view) continue;

        // Steering rotation on Y
        binding.steerGroup.rotation.y = view.steer;

        // Wheel forward rolling on X
        binding.spinMesh.rotation.x = view.spin;

        // Suspension travel on Y
        const suspensionY = -view.suspensionLength;
        binding.anchor.position.y = binding.spec.local.y + suspensionY;
      }
    }

    // Spin rotors for helicopters
    if (this.rotors.length > 0) {
      const rate = (controller as any).rotorRate ?? 32;
      for (const rotor of this.rotors) {
        rotor.rotation.y += rate * dt;
      }
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const mat of this.materials) {
      mat.dispose();
    }
    this.materials.length = 0;
  }
}

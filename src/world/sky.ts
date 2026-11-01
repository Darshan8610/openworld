import {
  Scene, Group, Vector3, Color, DirectionalLight, HemisphereLight, PerspectiveCamera,
  PMREMGenerator, Mesh, SphereGeometry, MeshBasicNodeMaterial, Points, BufferGeometry,
  BufferAttribute, PointsNodeMaterial, AdditiveBlending,
} from 'three/webgpu';
import type { RenderTarget, WebGPURenderer } from 'three/webgpu';
import { positionLocal, mx_noise_float, vec3 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { CONFIG, QUALITY } from '../config';
import type { QualityName } from '../config';
import { seededRandom, hashSeed } from '../utils/random';
import { clamp, smoothstep } from '../utils/math';

/**
 * Preetham analytic Rayleigh/Mie atmosphere (Three's BSD-licensed SkyMesh),
 * extended with a seeded star sphere and a procedural moon. Not a weather system.
 */
export class SkySystem {
  readonly group = new Group();
  readonly sun = new DirectionalLight(0xfff2db, 3.5);
  readonly moonLight = new DirectionalLight(0x91b4ef, 0.15);
  readonly ambient = new HemisphereLight(0xc5ddf5, 0x65634c, 1.1);
  readonly sunDirection = new Vector3();
  readonly horizon = new Color();
  hour: number = CONFIG.sky.initialHour;
  cycling = true;
  /**
   * Phase 9 weather inputs. The sky owns its defaults, so it renders correctly
   * with no weather system attached; the controller then drives these values.
   */
  cloudCoverage = 0.32;
  cloudDensity = 0.42;
  cloudSpeed = 1;
  sunScale = 1;
  ambientScale = 1;
  /** True once a weather controller is driving the cloud/light values. */
  weatherDriven = false;
  private readonly sky = new SkyMesh();
  private readonly environmentSky = new SkyMesh();
  private readonly environmentScene = new Scene();
  private readonly stars: Points<BufferGeometry, PointsNodeMaterial>;
  private readonly moon: Mesh<SphereGeometry, MeshBasicNodeMaterial>;
  private readonly pmrem: PMREMGenerator;
  private environment?: RenderTarget;
  private environmentTimer: number = CONFIG.sky.environmentInterval;
  private lastEnvironmentHour = -100;
  private shadowExtent: number;
  private readonly target = new Vector3();

  constructor(private readonly renderer: WebGPURenderer, private readonly scene: Scene, seed: string, quality: QualityName = 'balanced') {
    this.shadowExtent = QUALITY[quality].shadowExtent;
    this.sky.scale.setScalar(30000);
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.sky.turbidity.value = 2.6;
    this.sky.rayleigh.value = 1.65;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.82;
    this.sky.cloudCoverage.value = 0.32;
    this.sky.cloudDensity.value = 0.42;
    this.sky.cloudScale.value = 0.0018;
    this.sky.cloudSpeed.value = 0.000025;
    this.sky.cloudElevation.value = 0.55;
    this.group.add(this.sky);

    this.environmentSky.scale.setScalar(50);
    this.environmentSky.cloudCoverage.value = 0;
    this.environmentSky.showSunDisc.value = false;
    this.environmentScene.add(this.environmentSky);
    this.pmrem = new PMREMGenerator(renderer);

    const random = seededRandom(hashSeed(seed) ^ 0x452abcd);
    const positions = new Float32Array(CONFIG.sky.starCount * 3);
    const colors = new Float32Array(CONFIG.sky.starCount * 3);
    for (let i = 0; i < CONFIG.sky.starCount; i++) {
      const azimuth = random() * Math.PI * 2;
      // Concentrate a third of the stars along a tilted galactic band.
      const elevation = i % 3 === 0 ? (random() + random() + random() - 1.5) * 0.16 : Math.asin(random() * 2 - 1);
      const v = new Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation));
      v.applyAxisAngle(new Vector3(1, 0, 0), 0.65).multiplyScalar(18000);
      v.toArray(positions, i * 3);
      const brightness = 0.3 + random() ** 3 * 0.7;
      colors.set([brightness * (0.8 + random() * 0.2), brightness * (0.85 + random() * 0.15), brightness], i * 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    this.stars = new Points(geometry, new PointsNodeMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false }));
    this.stars.renderOrder = -90;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    const moonMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const craters = mx_noise_float(positionLocal.mul(0.055));
    moonMaterial.colorNode = vec3(0.65, 0.72, 0.8).mul(craters.mul(0.4).add(0.7));
    this.moon = new Mesh(new SphereGeometry(145, 24, 16), moonMaterial);
    this.moon.renderOrder = -80;
    this.group.add(this.moon);

    this.sun.castShadow = true;
    this.sun.shadow.camera.left = -this.shadowExtent;
    this.sun.shadow.camera.right = this.shadowExtent;
    this.sun.shadow.camera.top = this.shadowExtent;
    this.sun.shadow.camera.bottom = -this.shadowExtent;
    this.sun.shadow.camera.near = 100;
    this.sun.shadow.camera.far = 10000;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 1.5;
    this.scene.add(this.sun, this.sun.target, this.moonLight, this.moonLight.target, this.ambient, this.group);
    this.update(0, new Vector3(), new PerspectiveCamera(), true);
  }

  setHour(hour: number): void { this.hour = ((hour % 24) + 24) % 24; }

  /**
   * Drive the sky from the weather controller. Values are already eased by the
   * weather system, so the sky never snaps; passing `weatherDriven = false`
   * restores the authored baseline.
   */
  setWeather(weather: {
    cloudCoverage: number; cloudDensity: number; cloudSpeed: number;
    sunScale: number; ambientScale: number;
  } | null): void {
    if (!weather) { this.weatherDriven = false; return; }
    this.weatherDriven = true;
    this.cloudCoverage = clamp(weather.cloudCoverage, 0, 1);
    this.cloudDensity = clamp(weather.cloudDensity, 0, 1);
    this.cloudSpeed = clamp(weather.cloudSpeed, 0.2, 6);
    this.sunScale = clamp(weather.sunScale, 0.05, 1.4);
    this.ambientScale = clamp(weather.ambientScale, 0.4, 1.8);
  }

  update(dt: number, worldPosition: Vector3, camera: PerspectiveCamera, forceEnvironment = false): void {
    if (this.cycling) this.hour = (this.hour + dt * 24 / CONFIG.sky.secondsPerDay) % 24;
    const latitude = CONFIG.sky.latitude * Math.PI / 180;
    // Fixed northern summer solstice: declination changes with season, not hour.
    const declination = CONFIG.sky.axialTilt * Math.PI / 180;
    // Astronomical convention: 12:00 is solar noon, 00:00 is solar midnight.
    const hourAngle = (this.hour - 12) * Math.PI / 12;
    this.sunDirection.set(
      -Math.cos(declination) * Math.sin(hourAngle),
      Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle) + Math.cos(latitude) * Math.sin(declination),
      -Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle) + Math.sin(latitude) * Math.sin(declination),
    ).normalize();
    const elevation = this.sunDirection.y;
    const day = smoothstep(-0.12, 0.16, elevation);
    const golden = 1 - smoothstep(0.02, 0.5, elevation);
    this.sky.sunPosition.value.copy(this.sunDirection).multiplyScalar(450000);
    this.environmentSky.sunPosition.value.copy(this.sky.sunPosition.value);
    this.environmentSky.turbidity.value = this.sky.turbidity.value;
    this.environmentSky.rayleigh.value = this.sky.rayleigh.value;
    this.sky.showSunDisc.value = smoothstep(-0.04, 0.0, elevation) * (1 - this.cloudCoverage * 0.8);
    this.sky.cloudCoverage.value = this.cloudCoverage;
    this.sky.cloudDensity.value = this.cloudDensity;
    this.sky.cloudSpeed.value = 0.000025 * this.cloudSpeed;
    this.group.position.copy(camera.position);
    // Cloud cover hides the stars; a clear night keeps the whole field.
    this.stars.material.opacity = (1 - smoothstep(-0.18, 0.02, elevation)) * (1 - this.cloudCoverage * 0.92);
    this.stars.rotation.y = this.hour * Math.PI / 12;
    this.moon.position.copy(this.sunDirection).multiplyScalar(-16000);
    this.moon.position.x += 1600;
    this.moon.lookAt(new Vector3());
    this.moon.material.opacity = 1 - day;
    this.moon.visible = elevation < 0.1;

    this.sun.color.setRGB(1, 0.95 - golden * 0.27, 0.85 - golden * 0.43);
    this.sun.intensity = 3.6 * smoothstep(-0.025, 0.16, elevation) * this.sunScale;
    this.ambient.intensity = (0.14 + day * 0.9) * this.ambientScale;
    this.ambient.color.setRGB(0.48 + day * 0.25, 0.61 + day * 0.17, 0.85);
    this.moonLight.intensity = (1 - day) * 0.16;
    this.moonLight.position.copy(worldPosition).sub(this.sunDirection.clone().multiplyScalar(4000));
    this.moonLight.target.position.copy(worldPosition);
    this.target.copy(worldPosition);
    // Snap the shadow centre to texels to avoid swimming as the survey camera moves.
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    this.target.x = Math.round(this.target.x / texel) * texel;
    this.target.z = Math.round(this.target.z / texel) * texel;
    this.sun.target.position.copy(this.target);
    this.sun.position.copy(this.target).addScaledVector(this.sunDirection, 4500);
    this.horizon.setRGB(0.012 + day * (0.49 + golden * 0.12), 0.02 + day * (0.61 - golden * 0.06), 0.038 + day * (0.73 - golden * 0.22));
    this.environmentTimer += dt;
    if (this.scene.userData.ready && (forceEnvironment || (this.environmentTimer > CONFIG.sky.environmentInterval && Math.abs(this.hour - this.lastEnvironmentHour) > 0.025))) {
      this.refreshEnvironment();
    }
  }

  private refreshEnvironment(): void {
    const next = this.pmrem.fromScene(this.environmentScene, 0, 0.1, 100, { size: 128 });
    this.scene.environment = next.texture;
    const day = smoothstep(-0.12, 0.16, this.sunDirection.y);
    this.scene.environmentIntensity = 0.04 + day * 0.18;
    this.environment?.dispose();
    this.environment = next;
    this.environmentTimer = 0;
    this.lastEnvironmentHour = this.hour;
  }

  setQuality(quality: QualityName): void {
    this.renderer.shadowMap.enabled = QUALITY[quality].shadows;
    this.shadowExtent = QUALITY[quality].shadowExtent;
    this.sun.shadow.mapSize.setScalar(QUALITY[quality].shadowSize);
    this.sun.shadow.camera.left = -this.shadowExtent;
    this.sun.shadow.camera.right = this.shadowExtent;
    this.sun.shadow.camera.top = this.shadowExtent;
    this.sun.shadow.camera.bottom = -this.shadowExtent;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  reseed(seed: string): void {
    // Star positions are inexpensive and deterministic; rebuild only on world reset.
    const random = seededRandom(hashSeed(seed) ^ 0x452abcd);
    const attribute = this.stars.geometry.getAttribute('position');
    const axis = new Vector3(1, 0, 0);
    for (let i = 0; i < CONFIG.sky.starCount; i++) {
      const azimuth = random() * Math.PI * 2;
      const elevation = i % 3 === 0 ? (random() + random() + random() - 1.5) * 0.16 : Math.asin(random() * 2 - 1);
      const v = new Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation));
      v.applyAxisAngle(axis, 0.65).multiplyScalar(18000);
      attribute.setXYZ(i, v.x, v.y, v.z);
      random(); random(); random();
    }
    attribute.needsUpdate = true;
  }

  get night(): boolean { return this.sunDirection.y < -0.1; }
  get timeLabel(): string { return `${String(Math.floor(this.hour)).padStart(2, '0')}:${String(Math.floor((this.hour % 1) * 60)).padStart(2, '0')}`; }
  get elevationDegrees(): number { return Math.asin(clamp(this.sunDirection.y, -1, 1)) * 180 / Math.PI; }

  dispose(): void {
    this.scene.remove(this.group, this.sun, this.sun.target, this.moonLight, this.moonLight.target, this.ambient);
    this.sky.geometry.dispose(); this.sky.material.dispose();
    this.environmentSky.geometry.dispose(); this.environmentSky.material.dispose();
    this.stars.geometry.dispose(); this.stars.material.dispose();
    this.moon.geometry.dispose(); this.moon.material.dispose();
    this.sun.shadow.map?.dispose();
    this.environment?.dispose(); this.pmrem.dispose();
  }
}

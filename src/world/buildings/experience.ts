import { Vector3 } from 'three/webgpu';
import type { SurveyCamera } from '../../core/survey-camera';
import type { TerrainManager } from '../terrain-manager';
import type { BuildingManager } from './manager';
import type { BuildingDescriptor, BuildingInteraction } from './types';

interface ExperienceActions { loading: () => void; changed: () => void; toast: (message: string) => void }

/** Removable developer bridge while other agents build Phases 4–6. Not a human controller. */
export class BuildingExperience {
  private readonly abort = new AbortController();
  private readonly root = document.createElement('section');
  private readonly controls = document.createElement('section');
  private readonly direction = new Vector3();
  private interaction: BuildingInteraction | undefined;
  private visited: string | undefined;
  private lastUpdate = 0;
  private readonly unsubscribe: () => void;
  constructor(private readonly buildings: BuildingManager, private readonly rig: SurveyCamera, private readonly terrain: TerrainManager, private readonly actions: ExperienceActions) {
    this.controls.className = 'building-settings';
    this.controls.innerHTML = `<div class="nature-heading"><span class="eyebrow">BUILDINGS & INTERIORS</span><span>PHASE 07</span></div>
      <p class="building-help">Enterable architecture in the same infinite world. Human control is being developed separately.</p>
      <button id="visit-building" class="building-visit" type="button">Inspect a nearby building <kbd>F7</kbd></button>
      <label class="switch-row" for="building-collision"><span>Building collision overlay</span><input id="building-collision" type="checkbox" role="switch"></label>
      <output id="building-counts" class="building-counts"></output>`;
    document.querySelector('#settings .panel-note')!.before(this.controls);
    this.root.className = 'building-overlay'; this.root.setAttribute('aria-label', 'Building inspection');
    this.root.innerHTML = `<div id="building-location" class="building-location" hidden><span class="eyebrow">ARCHITECTURE INSPECTION</span><strong id="building-room"></strong><small id="building-mode"></small></div>
      <button id="building-interact" class="building-prompt" type="button" hidden><kbd>F</kbd><span id="building-action"></span></button>
      <p id="building-inspection-hint" class="building-inspection-hint" hidden>WASD move · Q/E inspect vertically · Drag to look · F doors · F7 return to survey</p>`;
    document.getElementById('interface')!.append(this.root);
    const options = { signal: this.abort.signal };
    this.controls.querySelector('#visit-building')!.addEventListener('click', () => this.visitNearest(), options);
    this.controls.querySelector('#building-collision')!.addEventListener('change', (event) => this.buildings.setDebug((event.target as HTMLInputElement).checked), options);
    this.root.querySelector('#building-interact')!.addEventListener('click', () => this.interact(), options);
    window.addEventListener('keydown', (event) => {
      if (event.repeat || (event.target as HTMLElement).closest('input,select,textarea,button,[contenteditable=true]')) return;
      if (event.code === 'F7') { event.preventDefault(); if (rig.inspecting) this.stop(); else this.visitNearest(); }
      if (event.code === 'KeyF' && this.interaction) { event.preventDefault(); this.interact(); }
    }, options);
    this.unsubscribe = buildings.onEvent((event) => {
      if (event.type === 'BuildingStorageWarning') actions.toast(event.message);
      if (event.type === 'BuildingDoorBlocked') actions.toast('Door movement held — clear the doorway.');
    });
  }
  visitNearest(): boolean {
    const building = this.buildings.nearest(this.rig.position);
    if (!building) { this.actions.toast('No safe building lot nearby. Try another route or seed.'); return false; }
    return this.visit(building);
  }
  visit(building: BuildingDescriptor): boolean {
    const entrance = this.buildings.entrance(building);
    this.actions.loading();
    this.visited = building.id;
    this.rig.beginInspection(new Vector3(entrance.x, entrance.y + 1.65, entrance.z), building.yaw, (from, desired) => this.constrain(from, desired));
    this.buildings.update(this.rig.position, 0, 12, true);
    document.getElementById('intro')!.classList.add('dismissed');
    document.getElementById('settings')!.hidden = true;
    document.getElementById('settings-toggle')!.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('settings-open');
    document.querySelector<HTMLCanvasElement>('.world-canvas')!.focus({ preventScroll: true });
    this.actions.changed(); this.actions.toast('Architecture inspection · F opens doors · F7 returns to survey');
    return true;
  }
  private constrain(from: Vector3, desired: Vector3): void {
    const foot = { x: desired.x, y: from.y - 1.65, z: desired.z };
    const support = this.buildings.collision.supportHeight(foot);
    // Optional gentle stair snapping only; Q/E remains a developer inspection tool.
    if (support !== undefined && Math.abs(desired.y - from.y) < 0.006 && Math.abs(support - foot.y) < 0.55) desired.y = support + 1.65;
    const groundedFrom = { x: from.x, y: Math.max(from.y, desired.y), z: from.z };
    const result = this.buildings.collision.moveSphere(groundedFrom, desired, 0.24);
    desired.set(result.x, result.y, result.z);
    const terrain = this.terrain.heightAt(desired.x, desired.z);
    if (terrain !== undefined) desired.y = Math.max(desired.y, terrain + 0.4);
  }
  private interact(): void {
    if (this.interaction && !this.interaction.interact(this.rig.position)) this.actions.toast('Move closer and keep the doorway clear.');
    document.querySelector<HTMLCanvasElement>('.world-canvas')!.focus({ preventScroll: true });
  }
  update(timestamp: number): void {
    if (timestamp - this.lastUpdate < 100) return;
    this.lastUpdate = timestamp;
    this.direction.set(-Math.sin(this.rig.yaw) * Math.cos(this.rig.pitch), Math.sin(this.rig.pitch), -Math.cos(this.rig.yaw) * Math.cos(this.rig.pitch));
    this.interaction = this.buildings.interactionAt(this.rig.position, this.direction);
    const prompt = this.root.querySelector<HTMLElement>('#building-interact')!;
    prompt.hidden = !this.interaction;
    this.root.querySelector('#building-action')!.textContent = this.interaction?.label() ?? '';
    const room = this.buildings.currentRoom;
    this.root.querySelector<HTMLElement>('#building-location')!.hidden = !room && !this.rig.inspecting;
    this.root.querySelector('#building-room')!.textContent = room?.room.name ?? 'Outside';
    this.root.querySelector('#building-mode')!.textContent = room ? `${room.building.template} · interior audio zone: ${room.room.acoustic}` : 'Developer camera · not a playable human';
    this.root.querySelector<HTMLElement>('#building-inspection-hint')!.hidden = !this.rig.inspecting;
    const stats = this.buildings.stats;
    this.controls.querySelector('#building-counts')!.textContent = `${stats.shells}/${stats.budget.shells} buildings · ${stats.interiors}/${stats.budget.interiors} interiors · ${stats.colliders} collision shapes`;
  }
  stop(): void { this.rig.endInspection(); this.visited = undefined; this.actions.changed(); }
  get activeBuilding(): string | undefined { return this.rig.inspecting ? this.visited : undefined; }
  dispose(): void { this.abort.abort(); this.unsubscribe(); this.root.remove(); this.controls.remove(); }
}

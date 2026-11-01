import { describe, expect, it } from 'vitest';
import { GameEventBus } from '../src/core/events';
import { ObjectiveRuntime } from '../src/game/objectives';
import { Discovery } from '../src/discovery/discovery';
import { NarrativeTracker } from '../src/story/narrative-state';
import { MissionDirector } from '../src/story/mission-director';
import {
  MISSION_CHAIN, STORY_MISSIONS, STORY_MISSION_DEFS, nextMissionId, waypointForMission,
} from '../src/story/mission-content';
import { CAMPAIGN } from '../src/story/campaign';

describe('story mission content contract', () => {
  it('is a single 16-mission chain from the stranded arrival to the capacitor bank', () => {
    expect(STORY_MISSIONS.length).toBe(16);
    expect(MISSION_CHAIN[0]).toBe('p_shelter');
    expect(MISSION_CHAIN[15]).toBe('a3_overload');
    expect(STORY_MISSION_DEFS.map((def) => def.id)).toEqual(MISSION_CHAIN);
    const acts = CAMPAIGN.acts.map((act) => act.id);
    for (const mission of STORY_MISSIONS) {
      expect(acts).toContain(mission.act);
      expect(mission.title.length).toBeGreaterThan(0);
      expect(mission.brief.length).toBeGreaterThan(0);
    }
    for (const def of STORY_MISSION_DEFS) {
      expect(def.objectives.length).toBeGreaterThan(0);
      for (const objective of def.objectives) {
        expect(['event', 'flag', 'reach']).toContain(objective.kind);
        if (objective.kind === 'event') expect(typeof objective.event === 'string' && objective.event.length > 0).toBe(true);
        if (objective.kind === 'flag') expect(typeof objective.flag === 'string' && objective.flag.length > 0).toBe(true);
        if (objective.kind === 'reach') expect((objective.point?.radius ?? 0) > 0).toBe(true);
      }
    }
  });

  it('links each mission to the next with no dead ends or orphans', () => {
    for (const id of MISSION_CHAIN.slice(0, -1)) expect(nextMissionId(id)).toBeTruthy();
    expect(nextMissionId('a3_overload')).toBeUndefined();
    expect(nextMissionId('does-not-exist')).toBeUndefined();
    const seen = new Set<string>();
    let cursor: string | undefined = MISSION_CHAIN[0];
    while (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
      cursor = nextMissionId(cursor);
    }
    expect(seen.size).toBe(MISSION_CHAIN.length);
    // Waypoints exist for the movement missions (reach objectives).
    expect(waypointForMission('p_shelter')).not.toBeNull();
    expect(waypointForMission('a3_ascend')).not.toBeNull();
    expect(waypointForMission('ghost')).toBeNull();
  });
});

function makeDirector() {
  const events = new GameEventBus();
  const objectives = new ObjectiveRuntime(events);
  const discovery = new Discovery();
  const narrative = new NarrativeTracker();
  const banners: string[] = [];
  const weather: string[] = [];
  const hours: number[] = [];
  const director = new MissionDirector({
    objectives, events, discovery, narrative,
    ui: { missionBanner: (kind, title, detail) => banners.push(`${kind}:${title}:${detail}`), toast: () => {} },
    weather: { setOverride: (kind) => weather.push(String(kind)) },
    sky: { setHour: (hour) => hours.push(hour), cycling: false },
  });
  return { director, events, objectives, discovery, banners, weather, hours };
}

describe('mission director flow', () => {
  it('registers the chain, begins at the prologue and advances through completion', () => {
    const { director, events, banners } = makeDirector();
    director.register();
    expect(director.started).toBe(false);
    director.begin();
    expect(director.started).toBe(true);
    expect(director.currentMissionId).toBe('p_shelter');
    expect(banners.some((banner) => banner.includes('Stranded Arrival'))).toBe(true);
    // Complete the opening mission through the shared event bus.
    events.emit('mission:completed', { id: 'p_shelter' });
    expect(director.currentMissionId).toBe('p_power');
    director.dispose();
  });

  it('applies act presets (weather + clock) as acts change', () => {
    const { director, events, weather, hours } = makeDirector();
    director.register();
    director.begin();
    expect(weather).toContain('fog'); // prologue preset
    // Walk the chain until Act III is active (presets must have flipped).
    let guard = 0;
    while (director.currentMissionId !== 'a3_keys' && guard++ < 30) {
      const active = director.currentMissionId;
      expect(active).not.toBeNull();
      events.emit('mission:completed', { id: active! });
    }
    expect(director.currentMissionId).toBe('a3_keys');
    expect(weather).toContain('storm');
    expect(hours.some((hour) => hour >= 23)).toBe(true);
    // Chain end → finale act (clear dawn) and no active mission.
    events.emit('mission:completed', { id: 'a3_keys' });
    events.emit('mission:completed', { id: 'a3_truck' });
    events.emit('mission:completed', { id: 'a3_ascend' });
    events.emit('mission:completed', { id: 'a3_cabin' });
    events.emit('mission:completed', { id: 'a3_overload' });
    expect(director.currentMissionId).toBeNull();
    expect(weather).toContain('clear');
    expect(hours.some((hour) => hour > 5 && hour < 6)).toBe(true);
    director.dispose();
  });

  it('sets and updates the discovery waypoint with mission changes', () => {
    const { director, events, discovery } = makeDirector();
    director.register();
    director.begin();
    const first = discovery.waypoint;
    expect(first).not.toBeNull();
    events.emit('mission:completed', { id: 'p_shelter' });
    const second = discovery.waypoint;
    expect(second).not.toBeNull();
    expect(second?.x).not.toBe(first?.x ?? Number.NaN);
    director.dispose();
  });
});

import type { CinematicShot } from './cinematic';
import { CAMPAIGN } from './campaign';
import { landmark } from './campaign';

/**
 * The in-engine cinematic beats of Echoes of Blackwood Valley.
 *
 * All shots are authored against the campaign road/terrain through small
 * sampler callbacks, so they hug the real geometry of seed `1k5om4l-ek66rv`
 * instead of hardcoded altitudes.
 */

type Sampler = (x: number, z: number) => number;

/** Prologue: headlights in the fog, the radio warning, the skid, the stall. */
export function buildOpeningShot(roadZ: (x: number) => number, ground: Sampler): CinematicShot {
  const diner = landmark('diner');
  const at = (dx: number, lift: number): [number, number, number] => {
    const x = diner.x + dx;
    const z = roadZ(x);
    return [x, ground(x, z) + lift, z];
  };
  return {
    id: 'opening',
    duck: 0.42,
    subtitles: [
      { at: 0.6, duration: 4.2, text: 'RANGER NET \u2014 all units, the valley grid is down. Stay off the forestry spur.', speaker: 'Emergency band' },
      { at: 4.6, duration: 3.4, text: 'There is a second signal riding our frequency. It is not interference. It repeats\u2014', speaker: 'Emergency band' },
      { at: 7.2, duration: 1.6, text: '[The engine dies. Rain on the roof. Something tall moves past the headlights.]', speaker: undefined },
      { at: 8.8, duration: 3.4, text: '\u2014do not answer voices on the shoulder\u2014', speaker: 'Emergency band' },
      { at: 12.4, duration: 2.4, text: '[STATIC]', speaker: undefined },
    ],
    keyframes: [
      { at: 0, position: at(-190, 7.5), lookAt: at(-120, 3), fov: 64 },
      { at: 4.2, position: at(-118, 5.4), lookAt: at(-46, 2.6), fov: 60 },
      { at: 7.0, position: at(-74, 4.2), lookAt: at(-30, 2.4), fov: 66 },
      { at: 7.9, position: at(-60, 3.1), lookAt: [diner.x + 10, ground(diner.x + 10, diner.z) + 4, diner.z], fov: 72 },
      { at: 10.4, position: at(-52, 2.7), lookAt: [diner.x + 6, ground(diner.x + 6, diner.z) + 4.5, diner.z], fov: 54 },
      { at: 14.6, position: at(-46, 3.2), lookAt: [diner.x, ground(diner.x, diner.z) + 6, diner.z], fov: 50 },
    ],
  };
}

/** Act II climax: the relay confession at the Forestry Station. */
export function buildRelayShot(ground: Sampler): CinematicShot {
  const station = landmark('forestry');
  const base = ground(station.x, station.z);
  return {
    id: 'relay-beat',
    duck: 0.5,
    subtitles: [
      { at: 0.4, duration: 4.6, text: '...this is Lookout. I\u2019m sealed in the broadcast cabin. The transmitter won\u2019t stop.', speaker: '162.4 MHz' },
      { at: 5.2, duration: 4.4, text: 'It\u2019s using my call sign now. It repeats my breath. Send anyone.', speaker: '162.4 MHz' },
      { at: 9.8, duration: 3.2, text: '[The same phrase, exactly, three more times \u2014 down to the stutter.]', speaker: undefined },
    ],
    keyframes: [
      { at: 0, position: [station.x - 10, base + 3.4, station.z + 8], lookAt: [station.x, base + 2, station.z], fov: 55 },
      { at: 6, position: [station.x - 4, base + 2.6, station.z + 4], lookAt: [station.x, base + 2.2, station.z - 2], fov: 46 },
      { at: 12.8, position: [station.x - 1.5, base + 2.4, station.z + 1.5], lookAt: [station.x, base + 2.4, station.z - 4], fov: 40 },
    ],
  };
}

/** Act III reveal: inside the glass cabin, the truth about the transmitter. */
export function buildRevelationShot(ground: Sampler): CinematicShot {
  const tower = landmark('tower');
  const base = ground(tower.x, tower.z);
  return {
    id: 'revelation',
    duck: 0.35,
    subtitles: [
      { at: 0.5, duration: 4.6, text: 'The logs were right: a deep-ground seismic resonance transmitter. Built to map fault lines. It found something that maps back.', speaker: 'Jack (journal)' },
      { at: 5.4, duration: 4.2, text: 'Every distress call from this valley \u2014 the survivor sealed in this cabin \u2014 it\u2019s the machine, rehearsing a voice it likes.', speaker: 'Jack (journal)' },
      { at: 9.8, duration: 3.6, text: 'One overload on the primary capacitor bank, and the valley gets its silence back. Real silence.', speaker: 'Jack (journal)' },
    ],
    keyframes: [
      { at: 0, position: [tower.x - 7, base + 6.2, tower.z + 5], lookAt: [tower.x, base + 5.4, tower.z - 1], fov: 52 },
      { at: 5.5, position: [tower.x - 3, base + 5.6, tower.z + 2.4], lookAt: [tower.x - 1, base + 5.2, tower.z - 2], fov: 44 },
      { at: 11, position: [tower.x - 1, base + 5.4, tower.z + 0.5], lookAt: [tower.x - 3.5, base + 4.8, tower.z - 3], fov: 38 },
      { at: 14, position: [tower.x, base + 5.3, tower.z - 1], lookAt: [tower.x - 5, base + 4.6, tower.z - 3], fov: 36 },
    ],
  };
}

/** Finale: the tower dies, the fog lifts, dawn over the pines. */
export function buildFinaleShot(ground: Sampler): CinematicShot {
  const tower = landmark('tower');
  const diner = landmark('diner');
  const base = ground(tower.x, tower.z);
  const valley = ground(diner.x, diner.z);
  return {
    id: 'finale',
    duck: 0.5,
    letterbox: true,
    subtitles: [
      { at: 0.4, duration: 3.4, text: '[The tower lights burst. Sirens die into a silence with weight to it.]', speaker: undefined },
      { at: 4.2, duration: 4.4, text: '[Far below, the fog over Blackwood begins, at last, to lift.]', speaker: undefined },
      { at: 9.4, duration: 4.2, text: 'Jack walks to the remaining vehicle as morning breaks through the pines.', speaker: undefined },
      { at: 13.8, duration: 2.6, text: 'The tape keeps running. Nobody answers the office phone. Not anymore.', speaker: 'Jack (journal)' },
    ],
    keyframes: [
      { at: 0, position: [tower.x - 12, base + 10, tower.z + 10], lookAt: [tower.x, base + 8, tower.z], fov: 48 },
      { at: 4, position: [tower.x - 20, base + 12, tower.z + 22], lookAt: [tower.x, base + 9, tower.z], fov: 52 },
      { at: 9, position: [tower.x - 30, base + 16, tower.z + 44], lookAt: [(tower.x + diner.x) / 2, (base + valley) / 2 + 6, (tower.z + diner.z) / 2], fov: 56 },
      { at: 14, position: [tower.x - 40, base + 20, tower.z + 70], lookAt: [diner.x, valley + 8, diner.z], fov: 60 },
      { at: 16.6, position: [tower.x - 46, base + 22, tower.z + 86], lookAt: [diner.x, valley + 10, diner.z], fov: 62 },
    ],
  };
}

/** The arrival point where control returns after the opening (wreck on the shoulder). */
export const ARRIVAL = CAMPAIGN.arrival;

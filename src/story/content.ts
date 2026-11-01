import type { StoryClue, StoryPropSpec } from './story-props';
import { STORY_POINTS } from './mission-content';

/**
 * Authored Blackwood Valley content: clue texts and the narrative prop
 * layout. Ids here are the contract matched by mission objectives —
 * `story:cassette`, `story:register`, `story:audio-log-N`, `story:radio-relay`
 * and the flags `breaker_diner` / `gate_forestry` / `transmitter_dead`.
 */

export const CLUES: Readonly<Record<string, StoryClue>> = {
  'story:cassette': {
    kind: 'cassette',
    title: 'Answering machine — Blackwood Diner',
    body: '[BEEP] ...it\u2019s Marta, closing up. The hum came back tonight, strongest by the Radio Lookout. If you hear your own name on the relay, unplug it. That\u2019s not \u2014 [STATIC] ...anyone on this frequency, do not answer the handoff. It learns the shape of a voice in one pass. [BEEP]',
  },
  'story:audio-log-1': {
    kind: 'log',
    title: 'Audio log 1 — Forestry Station, Day 2',
    body: 'Seismics team logged a resonance spike at 41 Hz under the ridge. Not tectonic. The bore camera showed the casing sweating. Administration says it\u2019s the old transmitter array re-routing power. Nobody re-routes power into solid granite.',
  },
  'story:audio-log-2': {
    kind: 'log',
    title: 'Audio log 2 — Forestry Station, Day 5',
    body: 'Half the crew won\u2019t sleep facing the tower. Rui hears his daughter calling from the tree line \u2014 she\u2019s three hundred kilometres away. We counted eleven voices on the emergency net. There are six of us.',
  },
  'story:audio-log-3': {
    kind: 'log',
    title: 'Audio log 3 — Forestry Station, Day 9',
    body: 'Evacuation was a mistake. The road vehicles stalled mid-convoy; something in the gravel kept naming the drivers by their childhood nicknames. I\u2019m sealing the gate. If you find this, the Station is empty on purpose. Do not let it hear you use the relay.',
  },
  'story:radio-relay': {
    kind: 'cassette',
    title: 'Distress call — 162.4 MHz',
    body: '...anyone, this is Lookout, I\u2019m sealed in the broadcast cabin, the transmitter won\u2019t stop \u2014 [pause] ...it\u2019s using my call sign now. It repeats my breath. Send anyone. [the same phrase, exactly, three more times \u2014 down to the stutter]',
  },
  'story:logbook': {
    kind: 'document',
    title: 'Dispatch logbook (torn page)',
    body: 'Crew rotations crossed out in the same handwriting. Last legible entry: "Cap bank serviced 03:10. Resonance test authorised. If the valley goes quiet, it isn\u2019t silence. It\u2019s listening."',
  },
  'story:notice': {
    kind: 'document',
    title: 'Pinned notice — Blackwood Diner',
    body: 'HIGHWAY SERVICE MAP: Blackwood \u2192 Whispering Pines (2.8 km) \u2192 Forestry spur (unpaved, floods) \u2192 Lookout switchbacks (closed after dark). Ranger note, added in pencil: "After the siren, drive ON. Do not stop for voices on the shoulder."',
  },
};

/**
 * The narrative prop layout. Anchors come from STORY_POINTS so missions,
 * props and cutscenes agree on where things are.
 */
export const STORY_PROPS: readonly StoryPropSpec[] = [
  {
    id: 'story:notice', label: 'Pinned highway notice', point: { ...STORY_POINTS.dinerForecourt, radius: 1 },
    kind: 'clue', clue: CLUES['story:notice'],
  },
  {
    id: 'story:breaker', label: 'Utility shed breaker', point: STORY_POINTS.utilityShed,
    kind: 'breaker', flag: 'breaker_diner', verb: 'Throw the breaker',
  },
  {
    id: 'story:register', label: 'Diner cash register', point: STORY_POINTS.dinerRegister,
    kind: 'register', grants: 'service-keys', flag: 'keys_found', verb: 'Search the register',
  },
  {
    id: 'story:cassette', label: 'Answering machine cassette', point: STORY_POINTS.officeDesk,
    kind: 'clue', clue: CLUES['story:cassette'], flag: 'cassette_played', verb: 'Play the tape',
  },
  {
    id: 'story:door-room4', label: 'Room Four door', point: STORY_POINTS.roomFour,
    kind: 'door', verb: 'Knock on the reinforced door',
  },
  {
    id: 'story:gate-forestry', label: 'Forestry Station gate', point: STORY_POINTS.forestryGate,
    kind: 'keydoor', requires: 'forestry-keycard', flag: 'gate_forestry', doorId: 'forestry-gate', verb: 'Unlock the gate',
  },
  {
    id: 'story:logbook', label: 'Dispatch logbook', point: { ...STORY_POINTS.dispatchDesk, radius: 1 },
    kind: 'clue', clue: CLUES['story:logbook'], verb: 'Read the logbook',
  },
  {
    id: 'story:audio-log-1', label: 'Encrypted audio log 1', point: { ...STORY_POINTS.dispatchDesk, radius: 1 },
    kind: 'clue', clue: CLUES['story:audio-log-1'], verb: 'Play log 1',
  },
  {
    id: 'story:audio-log-2', label: 'Encrypted audio log 2', point: { x: STORY_POINTS.dispatchDesk.x + 1.6, z: STORY_POINTS.dispatchDesk.z + 1, radius: 1 },
    kind: 'clue', clue: CLUES['story:audio-log-2'], verb: 'Play log 2',
  },
  {
    id: 'story:audio-log-3', label: 'Encrypted audio log 3', point: { x: STORY_POINTS.dispatchDesk.x - 1.6, z: STORY_POINTS.dispatchDesk.z + 1, radius: 1 },
    kind: 'clue', clue: CLUES['story:audio-log-3'], verb: 'Play log 3',
  },
  {
    id: 'story:terminal', label: 'Master communications terminal', point: STORY_POINTS.terminal,
    kind: 'terminal', flag: 'terminal_used', verb: 'Wake the terminal',
  },
  {
    id: 'story:radio-relay', label: 'Backup radio relay', point: STORY_POINTS.radioRelay,
    kind: 'radio', clue: CLUES['story:radio-relay'], flag: 'distress_heard', verb: 'Monitor the relay',
  },
  {
    id: 'story:truck-keys', label: 'Utility truck keys', point: STORY_POINTS.truckKeys,
    kind: 'keys', grants: 'truck-keys', flag: 'truck_keys', verb: 'Take the truck keys',
  },
  {
    id: 'story:capacitor', label: 'Primary capacitor bank', point: STORY_POINTS.capacitorVault,
    kind: 'capacitor', flag: 'transmitter_dead', holdSeconds: 3, verb: 'Overload the capacitors',
  },
];

import { describe, expect, it } from 'vitest';
import { CinematicDirector } from '../src/story/cinematic';

function makeUi() {
  const log: string[] = [];
  return {
    log,
    ui: {
      setLetterbox: (on: boolean) => log.push(`letterbox:${on}`),
      setSubtitle: (text: string | null) => log.push(`subtitle:${text ?? 'null'}`),
      setHudVisible: (visible: boolean) => log.push(`hud:${visible}`),
    },
    audio: { setDuck: (level: number) => log.push(`duck:${level}`) },
  };
}

const SHOT = {
  id: 'test-shot',
  keyframes: [
    { at: 0, position: [0, 10, 0] as const, lookAt: [0, 0, 0] as const, fov: 55 },
    { at: 1, position: [10, 12, 10] as const, lookAt: [1, 1, 1] as const, fov: 60 },
    { at: 2, position: [20, 14, 20] as const, lookAt: [2, 2, 2] as const, fov: 50 },
  ],
  subtitles: [{ at: 0.1, duration: 1.5, text: 'The fog is wrong tonight.', speaker: 'Jack' }],
  letterbox: true,
  duck: 0.4,
};

describe('cinematic sequencer', () => {
  it('plays a shot to completion with letterbox, subtitles and ducking', async () => {
    const { log, ui, audio } = makeUi();
    const director = new CinematicDirector({ ui, audio });
    expect(director.active).toBe(false);
    const done = director.play(SHOT);
    expect(director.active).toBe(true);
    expect(log).toContain('letterbox:true');
    expect(log).toContain('hud:false');
    expect(log).toContain('duck:0.4');
    director.update(0.2);
    expect(log.some((entry) => entry.startsWith('subtitle:') && entry.includes('fog'))).toBe(true);
    director.update(10); // jump past the end; resolves on the next microtask
    await done;
    expect(director.active).toBe(false);
    expect(log).toContain('letterbox:false');
    expect(log).toContain('hud:true');
    expect(log).toContain('duck:1');
  });

  it('skip() ends a running shot immediately and restores the mix', async () => {
    const { log, ui, audio } = makeUi();
    const director = new CinematicDirector({ ui, audio });
    const done = director.play(SHOT);
    director.update(0.3);
    director.skip();
    expect(director.active).toBe(false);
    await done;
    expect(log).toContain('letterbox:false');
    expect(log).toContain('duck:1');
    // A finished shot can be skipped again without breaking anything.
    director.skip();
    expect(director.active).toBe(false);
  });

  it('reduced motion jumps straight to the final frame', async () => {
    const { log, ui, audio } = makeUi();
    const director = new CinematicDirector({ ui, audio, reducedMotion: true });
    const done = director.play(SHOT);
    expect(director.active).toBe(false); // never starts the sweep
    await done;
    expect(log).toContain('letterbox:true');
    expect(log).toContain('letterbox:false');
  });

  it('ignores malformed shots (single keyframe) without activating', async () => {
    const { ui, audio } = makeUi();
    const director = new CinematicDirector({ ui, audio });
    await director.play({ id: 'bad', keyframes: [SHOT.keyframes[0]!] });
    expect(director.active).toBe(false);
  });
});

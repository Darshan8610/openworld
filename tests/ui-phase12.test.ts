import { describe, expect, it } from 'vitest';
import { CaptionFeed, directionLabel } from '../src/ui/captions';
import { MenuState } from '../src/ui/menu';
import {
  ACCESSIBILITY_CLASSES, DEFAULT_ACCESSIBILITY, DEFAULT_PREFERENCES, PREFERENCES_KEY,
  applyPreferences, loadPreferences, parsePreferences, savePreferences,
} from '../src/ui/preferences';
import type { PreferenceStorage } from '../src/ui/preferences';
import {
  accessibilitySettingsMarkup, audioSettingsMarkup, interfaceMarkup, menuFieldsMarkup, pauseMarkup,
} from '../src/ui/interface';
import { DEFAULT_AUDIO_SETTINGS } from '../src/audio/types';

class MemoryStorage implements PreferenceStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota');
    this.values.set(key, value);
  }
  seed(key: string, value: string): void { this.values.set(key, value); }
}

describe('preferences', () => {
  it('falls back to defaults for every malformed input', () => {
    expect(loadPreferences(new MemoryStorage())).toEqual(DEFAULT_PREFERENCES);
    const broken = new MemoryStorage();
    broken.seed(PREFERENCES_KEY, '{not json');
    expect(loadPreferences(broken)).toEqual(DEFAULT_PREFERENCES);
    const array = new MemoryStorage();
    array.seed(PREFERENCES_KEY, '[1,2,3]');
    expect(loadPreferences(array)).toEqual(DEFAULT_PREFERENCES);
    const future = new MemoryStorage();
    future.seed(PREFERENCES_KEY, JSON.stringify({ version: 99, audio: { master: 0.1 } }));
    expect(loadPreferences(future)).toEqual(DEFAULT_PREFERENCES);
  });

  it('clamps volumes and ignores wrongly typed booleans', () => {
    const parsed = parsePreferences({
      audio: { master: 4, ambience: -3, effects: Number.NaN, ui: '0.2', muted: 'yes', captions: false },
      accessibility: { reducedMotion: true, highContrast: 'true', largeText: 1, interactionHold: false },
    });
    expect(parsed.audio).toEqual({
      master: 1,
      ambience: 0,
      effects: DEFAULT_AUDIO_SETTINGS.effects,
      ui: DEFAULT_AUDIO_SETTINGS.ui,
      muted: DEFAULT_AUDIO_SETTINGS.muted,
      captions: false,
    });
    expect(parsed.accessibility).toEqual({
      reducedMotion: true, highContrast: false, largeText: false, interactionHold: false,
    });
  });

  it('round-trips through storage and stays in memory when storage refuses', () => {
    const storage = new MemoryStorage();
    const preferences = {
      audio: { ...DEFAULT_AUDIO_SETTINGS, master: 0.42, captions: false },
      accessibility: { ...DEFAULT_ACCESSIBILITY, largeText: true },
    };
    expect(savePreferences(preferences, storage)).toBe(true);
    expect(loadPreferences(storage)).toEqual(preferences);

    const denied = new MemoryStorage();
    denied.failWrites = true;
    expect(savePreferences(preferences, denied)).toBe(false);
    expect(loadPreferences(denied)).toEqual(DEFAULT_PREFERENCES);
  });

  it('toggles every document class from the preferences', () => {
    const toggles = new Map<string, boolean>();
    const root = { classList: { toggle: (token: string, force?: boolean) => { toggles.set(token, !!force); return !!force; } } };
    applyPreferences({ ...DEFAULT_PREFERENCES, audio: { ...DEFAULT_AUDIO_SETTINGS, captions: false } }, root);
    expect(toggles.get(ACCESSIBILITY_CLASSES.reducedMotion)).toBe(false);
    expect(toggles.get(ACCESSIBILITY_CLASSES.captions)).toBe(false);

    applyPreferences({
      audio: DEFAULT_AUDIO_SETTINGS,
      accessibility: { reducedMotion: true, highContrast: true, largeText: true, interactionHold: false },
    }, root);
    for (const token of [ACCESSIBILITY_CLASSES.reducedMotion, ACCESSIBILITY_CLASSES.highContrast, ACCESSIBILITY_CLASSES.largeText, ACCESSIBILITY_CLASSES.captions]) {
      expect(toggles.get(token)).toBe(true);
    }
  });
});

describe('caption feed', () => {
  it('labels stereo directions and ignores blank text', () => {
    expect(directionLabel(-0.9)).toBe('left');
    expect(directionLabel(0.9)).toBe('right');
    expect(directionLabel(0.2)).toBeNull();
    const feed = new CaptionFeed();
    expect(feed.push('   ', 0)).toBeNull();
    expect(feed.push(' Gate opens ', 0, 0.8)).toMatchObject({ text: 'Gate opens', direction: 'right' });
  });

  it('caps the visible list and expires by lifetime', () => {
    const feed = new CaptionFeed({ maxVisible: 2, lifetime: 2 });
    feed.push('One', 0);
    feed.push('Two', 0.1);
    feed.push('Three', 0.2);
    expect(feed.size).toBe(2);
    expect(feed.list(0.3).map((caption) => caption.text)).toEqual(['Two', 'Three']);
    expect(feed.list(3)).toHaveLength(0);
  });

  it('suppresses an immediate duplicate but allows a later repeat', () => {
    const feed = new CaptionFeed();
    expect(feed.push('Pickup', 10)).not.toBeNull();
    expect(feed.push('Pickup', 10.2)).toBeNull();
    expect(feed.push('Pickup', 11)).not.toBeNull();
  });
});

describe('menu state machine', () => {
  it('starts on the title screen and hands the world over once', () => {
    const menu = new MenuState();
    expect(menu.current).toBe('title');
    expect(menu.onTitle).toBe(true);
    expect(menu.blocksWorldInput).toBe(true);
    expect(menu.enterWorld()).toEqual({ from: 'title', to: 'none' });
    expect(menu.paused).toBe(false);
    expect(menu.blocksWorldInput).toBe(false);
    expect(menu.enterWorld()).toEqual({ from: 'none', to: 'none' });
  });

  it('pauses, resumes and steps out of settings in the right order', () => {
    const menu = new MenuState('none');
    expect(menu.openPause()).toEqual({ from: 'none', to: 'pause' });
    expect(menu.paused).toBe(true);

    menu.openSettings();
    expect(menu.current).toBe('settings');
    // Settings must return to the pause menu they were opened from.
    expect(menu.closeSettings()).toEqual({ from: 'settings', to: 'pause' });
    expect(menu.paused).toBe(true);

    expect(menu.escape()).toEqual({ from: 'pause', to: 'none' });
    expect(menu.paused).toBe(false);
    expect(menu.escape()).toEqual({ from: 'none', to: 'none' });
  });

  it('remembers the title screen as the settings return point', () => {
    const menu = new MenuState('title');
    menu.openSettings();
    expect(menu.closeSettings()).toEqual({ from: 'settings', to: 'title' });
    expect(menu.onTitle).toBe(true);
    expect(menu.backToTitle()).toEqual({ from: 'title', to: 'title' });
  });

  it('toggles pause only from the world or the pause menu', () => {
    const menu = new MenuState('none');
    expect(menu.togglePause().to).toBe('pause');
    expect(menu.togglePause().to).toBe('none');
    const title = new MenuState('title');
    expect(title.togglePause()).toEqual({ from: 'title', to: 'title' });
  });
});

describe('phase 12 markup', () => {
  const markup = interfaceMarkup(16.4, 'WebGL2', 'alpha-42', 'high');

  it('contains every interactive id the interface binds, exactly once', () => {
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);

    for (const id of [
      'menu-seed-form', 'menu-seed', 'menu-random', 'menu-quality', 'menu-settings', 'menu-share', 'menu-status',
      'explore', 'pause', 'pause-resume', 'pause-settings', 'pause-share', 'pause-mute', 'pause-restart',
      'pause-title-button', 'pause-title', 'captions', 'captions-feed', 'audio-status',
      'volume-master', 'volume-ambience', 'volume-effects', 'volume-ui',
      'volume-master-value', 'volume-ambience-value', 'volume-effects-value', 'volume-ui-value',
      'mute', 'a11y-motion', 'a11y-contrast', 'a11y-text', 'a11y-hold',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('marks the pause dialog and the caption region up for screen readers', () => {
    expect(markup).toContain('id="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title"');
    expect(markup).toContain('id="captions-feed" role="status" aria-live="polite"');
    expect(markup).toContain('id="audio-status"');
    expect(markup).toContain('PHASE 12');
  });

  it('renders the current seed, preset and mix into the controls', () => {
    const fields = menuFieldsMarkup('alpha-42', 'high');
    expect(fields).toContain('value="alpha-42"');
    expect(fields).toContain('<option value="high" selected>');
    expect(markup).toContain('id="seed-label"');

    const sound = audioSettingsMarkup({ ...DEFAULT_AUDIO_SETTINGS, master: 0.33, muted: true, captions: false });
    expect(sound).toContain('id="volume-master" type="range"');
    expect(sound).toContain('id="volume-master-value">33%');
    expect(sound).toMatch(/id="mute" role="switch" checked/);
    expect(sound).toMatch(/id="captions" role="switch">/);

    const a11y = accessibilitySettingsMarkup({ ...DEFAULT_ACCESSIBILITY, highContrast: true });
    expect(a11y).toMatch(/id="a11y-contrast" role="switch" checked/);
    expect(a11y).toMatch(/id="a11y-motion" role="switch">/);
  });

  it('escapes seeds instead of injecting markup', () => {
    const hostile = menuFieldsMarkup('"><img src=x onerror=alert(1)>', 'balanced');
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('&quot;&gt;&lt;img');
    const page = interfaceMarkup(12, 'WebGL2', '<script>alert(1)</script>');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('keeps the pause menu self-contained', () => {
    const pause = pauseMarkup();
    expect(pause).toContain('id="pause-title"');
    expect(pause.startsWith('      <div class="pause"')).toBe(true);
    expect(pause.match(/<button/g)!.length).toBe(6);
    expect(pause).toContain('<kbd>Esc</kbd> resume');
    expect(pause).toContain('<kbd>Tab</kbd> move focus');
  });
});

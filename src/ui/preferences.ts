import { DEFAULT_AUDIO_SETTINGS, clamp01 } from '../audio/types';
import type { AudioSettings } from '../audio/types';

/**
 * Player preferences: audio mix and accessibility.
 *
 * Preferences are not save data — they are local, unversioned prose about how the
 * player wants to experience the world, so an unreadable or newer blob falls back
 * to defaults instead of blocking the game. Every field is clamped and typed on
 * load; nothing here trusts storage.
 */

export const PREFERENCES_KEY = 'wayfarer.preferences';
export const PREFERENCES_VERSION = 1;

export interface AccessibilityPreferences {
  /** Force reduced motion on (or off) regardless of the OS setting. */
  readonly reducedMotion: boolean;
  /** Higher-contrast UI panels and text. */
  readonly highContrast: boolean;
  /** Larger UI text for the HUD, menus and panels. */
  readonly largeText: boolean;
  /** Hold E to confirm. Off = a single press confirms. */
  readonly interactionHold: boolean;
}

export const DEFAULT_ACCESSIBILITY: AccessibilityPreferences = {
  reducedMotion: false,
  highContrast: false,
  largeText: false,
  interactionHold: true,
};

export interface Preferences {
  readonly audio: AudioSettings;
  readonly accessibility: AccessibilityPreferences;
}

export const DEFAULT_PREFERENCES: Preferences = {
  audio: DEFAULT_AUDIO_SETTINGS,
  accessibility: DEFAULT_ACCESSIBILITY,
};

/** The slice of `Storage` the preferences need. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const asVolume = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;

export function parsePreferences(raw: unknown): Preferences {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const audio = typeof record.audio === 'object' && record.audio !== null
    ? record.audio as Record<string, unknown> : {};
  const accessibility = typeof record.accessibility === 'object' && record.accessibility !== null
    ? record.accessibility as Record<string, unknown> : {};
  return {
    audio: {
      master: asVolume(audio.master, DEFAULT_AUDIO_SETTINGS.master),
      ambience: asVolume(audio.ambience, DEFAULT_AUDIO_SETTINGS.ambience),
      effects: asVolume(audio.effects, DEFAULT_AUDIO_SETTINGS.effects),
      ui: asVolume(audio.ui, DEFAULT_AUDIO_SETTINGS.ui),
      muted: asBoolean(audio.muted, DEFAULT_AUDIO_SETTINGS.muted),
      captions: asBoolean(audio.captions, DEFAULT_AUDIO_SETTINGS.captions),
    },
    accessibility: {
      reducedMotion: asBoolean(accessibility.reducedMotion, DEFAULT_ACCESSIBILITY.reducedMotion),
      highContrast: asBoolean(accessibility.highContrast, DEFAULT_ACCESSIBILITY.highContrast),
      largeText: asBoolean(accessibility.largeText, DEFAULT_ACCESSIBILITY.largeText),
      interactionHold: asBoolean(accessibility.interactionHold, DEFAULT_ACCESSIBILITY.interactionHold),
    },
  };
}

export function loadPreferences(storage?: PreferenceStorage | null): Preferences {
  const target = storage ?? safeStorage();
  if (!target) return DEFAULT_PREFERENCES;
  try {
    const text = target.getItem(PREFERENCES_KEY);
    if (!text) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;
    const version = (parsed as Record<string, unknown>).version;
    if (typeof version === 'number' && version > PREFERENCES_VERSION) return DEFAULT_PREFERENCES;
    return parsePreferences(parsed);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences, storage?: PreferenceStorage | null): boolean {
  const target = storage ?? safeStorage();
  if (!target) return false;
  try {
    target.setItem(PREFERENCES_KEY, JSON.stringify({ version: PREFERENCES_VERSION, ...preferences }));
    return true;
  } catch {
    // Private browsing can deny storage; preferences stay in memory only.
    return false;
  }
}

function safeStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The classes applied to `<html>`; CSS owns the actual presentation. */
export const ACCESSIBILITY_CLASSES = {
  reducedMotion: 'a11y-reduced-motion',
  highContrast: 'a11y-contrast',
  largeText: 'a11y-large-text',
  captions: 'a11y-captions',
} as const;

export interface AccessibilityRoot {
  readonly classList: {
    toggle(token: string, force?: boolean): boolean;
  };
}

/**
 * Apply preferences to the document root. Called at boot and on every change, so
 * a player who needs larger text or higher contrast never has to reload.
 */
export function applyPreferences(preferences: Preferences, root: AccessibilityRoot): void {
  root.classList.toggle(ACCESSIBILITY_CLASSES.reducedMotion, preferences.accessibility.reducedMotion);
  root.classList.toggle(ACCESSIBILITY_CLASSES.highContrast, preferences.accessibility.highContrast);
  root.classList.toggle(ACCESSIBILITY_CLASSES.largeText, preferences.accessibility.largeText);
  root.classList.toggle(ACCESSIBILITY_CLASSES.captions, preferences.audio.captions);
}

/** OS-level motion preference, used as the default for a first-time visitor. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

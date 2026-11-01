/**
 * Sound captions (accessibility).
 *
 * A bounded, time-limited list of short descriptions of salient sounds, shown in
 * a polite live region. Captions are not a transcript of footsteps: they exist so
 * a player who cannot hear a door, a pickup or a greeting still receives the
 * information. UI code renders `list()`; this module owns the policy and the
 * wording so it can be tested without a DOM.
 */

export interface Caption {
  readonly id: number;
  readonly text: string;
  /** Compass-relative direction of the source, e.g. "left". */
  readonly direction: string | null;
  /** Timestamp (seconds) when the caption was raised. */
  readonly at: number;
}

export interface CaptionOptions {
  /** How many captions are shown at once. */
  readonly maxVisible: number;
  /** Seconds a caption stays on screen. */
  readonly lifetime: number;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = { maxVisible: 3, lifetime: 3.6 };

/** Map a pan value to a word, so captions work with stereo-only rendering. */
export function directionLabel(pan: number): string | null {
  if (pan <= -0.55) return 'left';
  if (pan >= 0.55) return 'right';
  return null;
}

export class CaptionFeed {
  private readonly options: CaptionOptions;
  private entries: Caption[] = [];
  private nextId = 1;

  constructor(options: Partial<CaptionOptions> = {}) {
    this.options = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  }

  push(text: string, at: number, pan = 0): Caption | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    // Do not repeat an identical caption that is still on screen (e.g. a pick-up
    // chain), but do allow it again once it has expired.
    const recent = this.entries[this.entries.length - 1];
    if (recent && recent.text === trimmed && at - recent.at < 0.6) return null;
    const caption: Caption = {
      id: this.nextId++, text: trimmed, direction: directionLabel(pan), at,
    };
    this.entries.push(caption);
    if (this.entries.length > this.options.maxVisible) this.entries = this.entries.slice(-this.options.maxVisible);
    return caption;
  }

  /** Drop expired entries; returns the list still visible at `now`. */
  list(now: number): readonly Caption[] {
    this.entries = this.entries.filter((entry) => now - entry.at < this.options.lifetime);
    return this.entries;
  }

  clear(): void { this.entries = []; }

  get size(): number { return this.entries.length; }
}

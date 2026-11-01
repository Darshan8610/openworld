/**
 * Menu state machine.
 *
 * The overlays are mutually exclusive, and which one is open decides whether the
 * simulation runs, whether the pointer is locked and where focus goes. Keeping
 * that in one small pure object — instead of scattered booleans across the game
 * loop, the interface and the input handler — makes the rules testable without a
 * DOM and impossible to half-apply.
 */

export type Overlay = 'title' | 'pause' | 'settings' | 'none';

export interface MenuChange {
  readonly from: Overlay;
  readonly to: Overlay;
}

export class MenuState {
  private overlay: Overlay;
  /** Overlay to restore when settings close; settings never open over settings. */
  private settingsReturn: Overlay = 'none';

  constructor(start: Overlay = 'title') { this.overlay = start; }

  get current(): Overlay { return this.overlay; }

  /** The world is paused while the pause menu is open (settings keep it running). */
  get paused(): boolean { return this.overlay === 'pause'; }

  /** A full-screen menu owns the keyboard and must not pass input to the world. */
  get blocksWorldInput(): boolean { return this.overlay !== 'none'; }

  get onTitle(): boolean { return this.overlay === 'title'; }

  enterWorld(): MenuChange { return this.transition('none'); }

  openPause(): MenuChange { return this.overlay === 'pause' ? this.same() : this.transition('pause'); }

  /** Settings can be opened from the title, the pause menu or in-world. */
  openSettings(): MenuChange {
    if (this.overlay === 'settings') return this.same();
    this.settingsReturn = this.overlay;
    return this.transition('settings');
  }

  closeSettings(): MenuChange {
    if (this.overlay !== 'settings') return this.same();
    return this.transition(this.settingsReturn);
  }

  /** Resume from the pause menu (settings return to whatever they were over). */
  resume(): MenuChange { return this.overlay === 'none' ? this.same() : this.transition('none'); }

  backToTitle(): MenuChange { return this.transition('title'); }

  /** Escape steps out one level: settings → pause → world. */
  escape(): MenuChange {
    if (this.overlay === 'settings') return this.closeSettings();
    if (this.overlay === 'pause') return this.resume();
    return this.same();
  }

  togglePause(): MenuChange {
    if (this.overlay === 'pause') return this.resume();
    if (this.overlay === 'none') return this.openPause();
    return this.same();
  }

  private transition(to: Overlay): MenuChange {
    const from = this.overlay;
    this.overlay = to;
    return { from, to };
  }

  private same(): MenuChange { return { from: this.overlay, to: this.overlay }; }
}

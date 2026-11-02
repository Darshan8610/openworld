import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceMarkup } from '../src/ui/interface';

/**
 * DOM integrity guard.
 *
 * The interface shell is one template string; a typo in an element id would throw
 * inside the constructor at boot, which the browser suite would catch but which
 * cannot run in every environment. This test proves every id the Interface class
 * looks up exists in the markup it inserts.
 */
describe('interface markup', () => {
  const markup = interfaceMarkup(17.6, 'WebGL2');
  const source = readFileSync(join(process.cwd(), 'src/ui/interface.ts'), 'utf8');

  const declared = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!));
  const referenced = new Set<string>();
  for (const match of source.matchAll(/[$(](?:<[^>]+>)?\('#([A-Za-z0-9_-]+)'\)/g)) referenced.add(match[1]!);
  for (const match of source.matchAll(/\bon\('([A-Za-z0-9_-]+)'/g)) referenced.add(match[1]!);

  it('declares every element id the interface looks up', () => {
    const missing = [...referenced].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it('exposes the player controls added in Phase 5', () => {
    for (const id of ['walk-mode', 'first-person', 'sensitivity', 'shoulder', 'respawn', 'player-mode', 'player-stance', 'controls-hint']) {
      expect(declared.has(id)).toBe(true);
    }
    expect(markup).toContain('PHASE 05');
  });

  it('exposes the Phase 12 menus, mixing and accessibility controls', () => {
    for (const id of ['pause', 'pause-title', 'pause-resume', 'pause-settings', 'pause-restart', 'menu-seed', 'menu-quality', 'volume-master', 'volume-master-value', 'mute', 'a11y-hold', 'captions-feed', 'audio-status']) {
      expect(declared.has(id), id).toBe(true);
    }
    expect(markup).toContain('PHASE 12');
  });

  it('interpolates the backend and clock instead of leaving placeholders', () => {
    expect(markup).toContain('WebGL2');
    expect(markup).toContain('17:36');
    expect(markup).not.toContain('undefined');
  });
});

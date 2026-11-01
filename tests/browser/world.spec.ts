import { test, expect, type Page } from '@playwright/test';

type Game = import('../../src/core/game').Game;
type Snapshot = ReturnType<Game['snapshot']>;

async function openWorld(page: Page, query = '', mode: 'character' | 'survey' = 'character'): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?renderer=webgl&quality=low&seed=playwright${query}&mode=${mode}`);
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 90_000 });
  expect(errors).toEqual([]);
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__WAYFARER__!.snapshot());
}

/** Focus the world so window-level key handlers own the input. */
async function focusWorld(page: Page): Promise<void> {
  await page.locator('canvas.world-canvas').click({ position: { x: 40, y: 40 } });
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().character.spawned === true, null, { timeout: 60_000 });
}

test('boots a deterministic streamed world on foot without page errors', async ({ page }) => {
  await openWorld(page);
  const state = await snapshot(page);
  expect(state.backend).toBe('WebGL2');
  expect(state.mode).toBe('character');
  expect(state.cached).toBeGreaterThan(50);
  expect(state.pending).toBe(0);
  expect(state.vegetation.instances).toBeGreaterThan(100);
  expect(state.vegetation.batches).toBeLessThanOrEqual(10);
  expect(state.roads.roadTiles).toBeGreaterThan(0);
  expect(state.roads.roadsEnabled).toBe(true);
  expect(state.vegetation.instances).toBeLessThanOrEqual(state.vegetation.capacity);
  // Phase 5: the character is spawned as a real rig, not a placeholder camera.
  expect(state.character.spawned).toBe(true);
  expect(state.character.rig.joints).toBe(19);
  expect(state.character.rig.clips).toBe(13);
  expect(state.character.rig.source).toBe('placeholder');
  expect(state.character.mode).toBe('ground');
  await expect(page.locator('#loading')).toHaveClass(/loaded/);
  await expect(page.locator('#fatal')).toBeHidden();
  await expect(page.locator('canvas.world-canvas')).toBeVisible();
  await expect(page.locator('#player-mode')).toHaveText('ON FOOT');
});

test('the player walks with WASD, animates and stops', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await focusWorld(page);
  const start = await snapshot(page);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().character.speed ?? 0) > 2, null, { timeout: 20_000 });
  const moving = await snapshot(page);
  expect(moving.character.animation === 'jog' || moving.character.animation === 'walk').toBe(true);
  expect(moving.character.distance).toBeGreaterThan(1);
  await page.keyboard.up('KeyW');
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().character.speed ?? 1) < 0.4, null, { timeout: 20_000 });
  const stopped = await snapshot(page);
  expect(stopped.character.animation).toBe('idle');
  expect(Math.hypot(stopped.character.position[0]! - start.character.position[0]!, stopped.character.position[2]! - start.character.position[2]!)).toBeGreaterThan(1);
  expect(stopped.character.grounded).toBe(true);
  await expect(page.locator('#fatal')).toBeHidden();
});

test('jump leaves the ground and lands again', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await focusWorld(page);
  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().character.mode === 'air', null, { timeout: 15_000 });
  await page.keyboard.up('Space');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().character.mode === 'ground', null, { timeout: 20_000 });
  expect((await snapshot(page)).character.grounded).toBe(true);
});

test('C switches between the character and the survey camera', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await focusWorld(page);
  await page.keyboard.press('KeyC');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().mode === 'survey', null, { timeout: 20_000 });
  expect(page.url()).toContain('mode=survey');
  await expect(page.locator('#player-state')).toBeHidden();
  await page.keyboard.press('KeyC');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().mode === 'character' && window.__WAYFARER__?.snapshot().character.spawned === true, null, { timeout: 30_000 });
  await expect(page.locator('#player-state')).toBeVisible();
});

test('F toggles the first-person camera and the HUD follows', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await focusWorld(page);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().character.firstPerson === true, null, { timeout: 15_000 });
  await expect(page.locator('#player-mode')).toHaveText('FIRST PERSON');
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().character.firstPerson === false, null, { timeout: 15_000 });
  await expect(page.locator('#player-mode')).toHaveText('ON FOOT');
});

test('seed input regenerates the world and updates the shareable URL', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#seed').fill('regression-seed');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true && window.__WAYFARER__?.snapshot().seed === 'regression-seed', null, { timeout: 90_000 });
  const state = await snapshot(page);
  expect(state.seed).toBe('regression-seed');
  expect(state.character.spawned).toBe(true);
  expect(page.url()).toContain('seed=regression-seed');
});

test('time slider changes the sky clock and pauses the cycle', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#time').fill('2');
  await page.waitForFunction(() => Math.abs((window.__WAYFARER__?.snapshot().hour ?? 12) - 2) < 0.05);
  await expect(page.locator('#cycle')).not.toBeChecked();
});

test('floating origin rebases around the player at large coordinates', async ({ page }) => {
  await openWorld(page, '&x=6000&z=-6000');
  const state = await snapshot(page);
  expect(state.shifts).toBeGreaterThan(0);
  expect(state.character.spawned).toBe(true);
  expect(Math.abs(state.position[0]! - state.origin[0]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(state.position[2]! - state.origin[2]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(state.characterPosition[0]! - state.character.position[0]!)).toBeLessThan(1e-6);
  expect(state.cached).toBeGreaterThan(50);
});

test('graphics preset rebuilds terrain and remains interactive', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#quality').selectOption('balanced');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 90_000 });
  await expect(page.locator('#fatal')).toBeHidden();
  const state = await snapshot(page);
  expect(state.cached).toBeGreaterThan(50);
  expect(state.character.spawned).toBe(true);
});


test('vegetation can be disabled and restored without rebuilding the world', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  // Stop route/scenic motion so streaming cannot change the tile counter mid-assertion.
  await page.locator('#tour').click();
  await page.waitForFunction(() => {
    const state = window.__WAYFARER__?.snapshot();
    return state?.pending === 0 && state?.touring === false && state?.routeFollowing === false && (state?.speed ?? 1) < 0.5;
  }, null, { timeout: 90_000 });
  const generated = (await snapshot(page)).generated;
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#vegetation').uncheck();
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().vegetation.instances === 0);
  expect((await snapshot(page)).vegetationEnabled).toBe(false);
  expect(page.url()).toContain('vegetation=0');
  await page.locator('#vegetation').check();
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().vegetation.instances ?? 0) > 100);
  const after = await snapshot(page);
  expect(after.generated).toBe(generated);
  expect(after.seed).toBe('playwright');
  expect(after.ready).toBe(true);
});

test('biome overlay exposes all five climate regions and the live HUD biome', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#biome-debug').check();
  await expect(page.locator('#biome-legend')).toBeVisible();
  await expect(page.locator('#biome-legend')).toContainText('Valley meadows');
  await expect(page.locator('#biome-legend')).toContainText('Snowline peaks');
  expect((await snapshot(page)).biomeDebug).toBe(true);
  await page.locator('#lod').check();
  await expect(page.locator('#biome-debug')).not.toBeChecked();
  await expect(page.locator('#biome-legend')).toBeHidden();
  await expect(page.locator('#location-name')).not.toHaveText('ALPINE HIGHLANDS');
});

test('the character survives a floating-origin rebase', async ({ page }) => {
  await openWorld(page, '&x=6000&z=-6000');
  const state = await snapshot(page);
  expect(state.shifts).toBeGreaterThan(0);
  expect(state.vegetation.instances).toBeGreaterThan(100);
  expect(state.character.spawned).toBe(true);
  expect(Math.abs(state.position[0]! - state.origin[0]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(state.position[2]! - state.origin[2]!)).toBeLessThanOrEqual(2048);
});


test('wind and surface detail switches update live rendering state', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#wind').uncheck();
  await page.locator('#detail').uncheck();
  await page.waitForFunction(() => {
    const state = window.__WAYFARER__?.snapshot();
    return state?.windEnabled === false && state?.detailEnabled === false;
  });
  await page.locator('#wind').check();
  await page.locator('#detail').check();
  await page.waitForFunction(() => {
    const state = window.__WAYFARER__?.snapshot();
    return state?.windEnabled === true && state?.detailEnabled === true;
  });
  await expect(page.locator('#fatal')).toBeHidden();
});


test('scenic route survey follows the road network and can be toggled', async ({ page }) => {
  await openWorld(page, '', 'survey');
  expect((await snapshot(page)).routeFollowing).toBe(true);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#route-select').selectOption('golden');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true && window.__WAYFARER__?.snapshot().route?.name === 'Golden Ridge', null, { timeout: 90_000 });
  const state = await snapshot(page);
  expect(state.routeFollowing).toBe(true);
  expect(state.route?.corridor).toBe(1);
  expect(page.url()).toContain('route=golden');
  await page.locator('#roads').uncheck();
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().roads.roadsEnabled === false);
  expect(page.url()).toContain('roads=0');
  await page.locator('#roads').check();
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().roads.roadTiles ?? 0) > 0);
});

test('Ultra preset boots with ambient occlusion and streamed roads', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Exercise the Ultra post chain / road mesh without software-rendering 60k plants.
  await page.goto('/?renderer=webgl&quality=ultra&seed=ultra-smoke&vegetation=0&postfx=1');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 180_000 });
  const state = await snapshot(page);
  expect(state.quality).toBe('ultra');
  expect(state.postfxEnabled).toBe(true);
  expect(state.roads.roadTiles).toBeGreaterThan(0);
  expect(state.character.spawned).toBe(true);
  expect(errors).toEqual([]);
  await expect(page.locator('#fatal')).toBeHidden();
});

test('an external humanoid URL falls back to the placeholder rig when it cannot load', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?renderer=webgl&quality=low&seed=asset-fallback&character=/missing-character.glb');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 120_000 });
  const state = await snapshot(page);
  // The game stays playable and reports the failure instead of rendering nothing.
  expect(state.character.spawned).toBe(true);
  expect(state.character.rig.source).toBe('placeholder');
  expect(state.character.rig.warnings.join(' ')).toContain('character asset failed');
  await expect(page.locator('#fatal')).toBeHidden();
});
test('streams interactive world objects with physics and an interaction prompt', async ({ page }) => {
  await openWorld(page);
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().objects.active ?? 0) > 0, null, { timeout: 90_000 });
  const state = await snapshot(page);
  expect(state.objects.cells).toBeGreaterThan(0);
  expect(state.objects.active).toBeGreaterThan(0);
  expect(state.objects.dynamic).toBeGreaterThan(0);
  expect(state.objects.active).toBeLessThanOrEqual(128);
  expect(state.physics.bodies).toBeGreaterThan(0);
  expect(state.interaction.providers).toBe(state.objects.active);
  // Settled props must actually sleep rather than jitter forever.
  await page.waitForFunction(() => {
    const physics = window.__WAYFARER__?.snapshot().physics;
    return physics !== undefined && physics.awake <= physics.bodies;
  }, null, { timeout: 30_000 });
  const settled = await snapshot(page);
  expect(settled.physics.awake).toBeLessThanOrEqual(settled.physics.bodies);
  await expect(page.locator('#interaction')).toBeHidden();
  await expect(page.locator('#fatal')).toBeHidden();
});

test('object toggle and share URL control the gameplay layer', async ({ page }) => {
  await openWorld(page, '&objects=1');
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().objects.active ?? 0) > 0, null, { timeout: 90_000 });
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#objects').uncheck();
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().objects.active ?? -1) === 0);
  expect(page.url()).toContain('objects=0');
  expect((await snapshot(page)).interaction.providers).toBe(0);
  await page.locator('#objects').check();
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().objects.active ?? 0) > 0, null, { timeout: 90_000 });
  expect(page.url()).toContain('objects=1');
});

test('objects=0 URL parameter never streams the gameplay layer', async ({ page }) => {
  await openWorld(page, '&objects=0');
  const state = await snapshot(page);
  expect(state.objectsEnabled).toBe(false);
  expect(state.objects.active).toBe(0);
  expect(state.interaction.providers).toBe(0);
  await expect(page.locator('#interaction')).toBeHidden();
});

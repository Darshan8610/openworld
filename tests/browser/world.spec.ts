import { test, expect, type Page } from '@playwright/test';

type Game = import('../../src/core/game').Game;
type Snapshot = ReturnType<Game['snapshot']>;

async function openWorld(page: Page, query = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?renderer=webgl&quality=low&seed=playwright${query}`);
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 90_000 });
  expect(errors).toEqual([]);
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__WAYFARER__!.snapshot());
}

test('boots a deterministic streamed world without page errors', async ({ page }) => {
  await openWorld(page);
  const state = await snapshot(page);
  expect(state.backend).toBe('WebGL2');
  expect(state.cached).toBeGreaterThan(50);
  expect(state.pending).toBe(0);
  expect(state.vegetation.instances).toBeGreaterThan(100);
  expect(state.vegetation.batches).toBeLessThanOrEqual(10);
  expect(state.roads.roadTiles).toBeGreaterThan(0);
  expect(state.roads.roadsEnabled).toBe(true);
  expect(state.vegetation.instances).toBeLessThanOrEqual(state.vegetation.capacity);
  await expect(page.locator('#loading')).toHaveClass(/loaded/);
  await expect(page.locator('#fatal')).toBeHidden();
  await expect(page.locator('canvas.world-canvas')).toBeVisible();
});

test('seed input regenerates the world and updates the shareable URL', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#seed').fill('regression-seed');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true && window.__WAYFARER__?.snapshot().seed === 'regression-seed', null, { timeout: 90_000 });
  expect((await snapshot(page)).seed).toBe('regression-seed');
  expect(page.url()).toContain('seed=regression-seed');
});

test('time slider changes the sky clock and pauses the cycle', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#time').fill('2');
  await page.waitForFunction(() => Math.abs((window.__WAYFARER__?.snapshot().hour ?? 12) - 2) < 0.05);
  await expect(page.locator('#cycle')).not.toBeChecked();
});

test('floating origin rebases at large coordinates while keeping the camera local', async ({ page }) => {
  await openWorld(page, '&x=6000&z=-6000');
  const state = await snapshot(page);
  expect(state.shifts).toBeGreaterThan(0);
  expect(Math.abs(state.position[0]! - state.origin[0]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(state.position[2]! - state.origin[2]!)).toBeLessThanOrEqual(2048);
  expect(state.cached).toBeGreaterThan(50);
});

test('graphics preset rebuilds terrain and remains interactive', async ({ page }) => {
  await openWorld(page);
  await page.getByRole('button', { name: 'World settings' }).click();
  await page.locator('#quality').selectOption('balanced');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 90_000 });
  await expect(page.locator('#fatal')).toBeHidden();
  expect((await snapshot(page)).cached).toBeGreaterThan(50);
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

test('vegetation survives a floating-origin rebase', async ({ page }) => {
  await openWorld(page, '&x=6000&z=-6000');
  const state = await snapshot(page);
  expect(state.shifts).toBeGreaterThan(0);
  expect(state.vegetation.instances).toBeGreaterThan(100);
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
  await openWorld(page);
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
  expect(errors).toEqual([]);
  await expect(page.locator('#fatal')).toBeHidden();
});

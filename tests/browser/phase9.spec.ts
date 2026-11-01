import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 9 browser coverage. NOT EXECUTED in the development sandbox (no Chromium
 * binary); run with `npx playwright install chromium && npm run test:browser`.
 *
 * These specs assert the parts that only exist in a real frame: the water surface
 * is actually streamed around the player, particles stay inside their budget, and
 * the weather controls change the sky without a page error.
 */

type Game = import('../../src/core/game').Game;
type Snapshot = ReturnType<Game['snapshot']>;

async function boot(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?renderer=webgl&quality=low&seed=phase9${query}`);
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 120_000 });
  return errors;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__WAYFARER__!.snapshot());
}

test('streams a bounded water surface and weather without page errors', async ({ page }) => {
  const errors = await boot(page);
  const state = await snapshot(page);
  expect(errors).toEqual([]);
  // The water layer is attached and its budget is respected.
  expect(state.world.water).toBeDefined();
  expect(state.world.water!.tiles).toBeLessThanOrEqual(state.world.water!.budget);
  expect(state.world.water!.triangles).toBeGreaterThanOrEqual(0);
  // Weather starts from a known, eased state.
  expect(['clear', 'partly-cloudy', 'cloudy', 'overcast', 'rain', 'heavy-rain', 'storm', 'fog', 'snow', 'blizzard', 'windy'])
    .toContain(state.weather.kind);
  expect(state.weather.cloudCoverage).toBeGreaterThanOrEqual(0);
  expect(state.weather.cloudCoverage).toBeLessThanOrEqual(1);
  // Particles never exceed the preset budget.
  expect(state.particles.active).toBeLessThanOrEqual(state.particles.capacity);
  expect(state.particles.capacity).toBeGreaterThan(0);
});

test('a pinned storm drives rain, particles and water activity', async ({ page }) => {
  const errors = await boot(page, '&weather=storm');
  // Transitions are eased with a multi-second half-life: give the front time to
  // express itself instead of asserting an instant snap.
  await page.waitForTimeout(25_000);
  const state = await snapshot(page);
  expect(errors).toEqual([]);
  expect(state.weather.kind).toBe('storm');
  expect(state.weather.cloudCoverage).toBeGreaterThan(0.4);
  expect(state.weather.rain).toBeGreaterThan(0.05);
  expect(state.weather.seaState).toBeGreaterThan(1);
  expect(state.particles.rain).toBeGreaterThan(0);
  expect(state.particles.active).toBeLessThanOrEqual(state.particles.capacity);
});

test('water can be switched off and back on from the keyboard', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('canvas.world-canvas').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(200);
  expect((await snapshot(page)).world.water?.enabled).toBe(false);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(200);
  expect((await snapshot(page)).world.water?.enabled).toBe(true);
  expect(errors).toEqual([]);
});

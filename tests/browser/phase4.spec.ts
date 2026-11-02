import { test, expect, type Page } from '@playwright/test';

type Game = import('../../src/core/game').Game;
type Snapshot = ReturnType<Game['snapshot']>;

async function openWorld(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?renderer=webgl&quality=low&seed=phase4test${query}`);
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready === true, null, { timeout: 90_000 });
  return errors;
}

/** Physics loads asynchronously (separate WASM chunk) after the world is ready. */
async function waitForPhysics(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const world = window.__WAYFARER__?.snapshot().world;
    return !!world?.physics && world.physics.bodies > 0;
  }, null, { timeout: 60_000 });
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__WAYFARER__!.snapshot());
}

test('boots a physics world on streamed terrain colliders', async ({ page }) => {
  const errors = await openWorld(page);
  await waitForPhysics(page);
  const state = await snapshot(page);
  expect(state.world.physics?.engine).toBe('rapier');
  expect(state.world.physics!.bodies).toBeGreaterThan(0);
  expect(state.world.physics!.colliders).toBeGreaterThan(0);
  expect(state.world.ground!.tiles).toBeGreaterThan(0);
  expect(state.world.ground!.tiles).toBeLessThanOrEqual(12);
  expect(errors).toEqual([]);
  await expect(page.locator('#fatal')).toBeHidden();
  await expect(page.locator('#physics')).toBeEnabled();
});

test('drops a physically simulated test crate and keeps it bounded', async ({ page }) => {
  await openWorld(page);
  await waitForPhysics(page);
  await page.locator('canvas.world-canvas').click({ position: { x: 40, y: 40 } });
  // Phase 5 moved the view toggle onto C, so the sandbox crate lives on X.
  await page.keyboard.press('x');
  await page.waitForFunction(() => (window.__WAYFARER__?.snapshot().world?.props ?? 0) > 0, null, { timeout: 20_000 });
  const state = await snapshot(page);
  expect(state.world.props).toBe(1);
  expect(state.world.entities.kinds.prop).toBe(1);
  expect(state.world.entities.full).toBeGreaterThanOrEqual(1);
  // The extra body is inside the configured budget, never unbounded.
  expect(state.world.physics!.bodies).toBeLessThanOrEqual(640);
});

test('toggles the collider debug overlay', async ({ page }) => {
  await openWorld(page);
  await waitForPhysics(page);
  await page.locator('canvas.world-canvas').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('k');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().world?.debugVisible === true, null, { timeout: 10_000 });
  expect((await snapshot(page)).world.debugVisible).toBe(true);
});

test('keeps physics valid through a floating-origin rebase', async ({ page }) => {
  await openWorld(page, '&x=6000&z=-6000');
  await waitForPhysics(page);
  const state = await snapshot(page);
  expect(state.shifts).toBeGreaterThan(0);
  expect(state.world.physics!.rebases).toBeGreaterThan(0);
  expect(state.world.ground!.tiles).toBeGreaterThan(0);
  const position = state.position;
  const origin = state.origin;
  expect(Math.abs(position[0]! - origin[0]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(position[2]! - origin[2]!)).toBeLessThanOrEqual(2048);
});

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

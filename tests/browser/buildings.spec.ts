import { test, expect, type Page } from '@playwright/test';
import { TerrainField } from '../../src/world/terrain-field';
import type { Game } from '../../src/core/game';

type Snapshot = ReturnType<Game['snapshot']>;
const seed = 'playwright';
const building = new TerrainField(seed).buildings.nearest({ x: 0, y: 0, z: 0 });
if (!building) throw new Error('Regression seed must have a safe building lot');
const id = building.id;
const query = `/?renderer=webgl&quality=low&seed=${seed}&building=${encodeURIComponent(id)}&vegetation=0&hour=15`;
const state = (page: Page): Promise<Snapshot> => page.evaluate(() => window.__WAYFARER__!.snapshot());
async function openBuilding(page: Page, targetId = id): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(query.replace(encodeURIComponent(id), encodeURIComponent(targetId)));
  await page.waitForFunction(() => {
    const s = window.__WAYFARER__?.snapshot();
    return s?.ready && s.inspecting && s.buildings.interiors > 0;
  }, null, { timeout: 120_000 });
  await expect(page.locator('#building-interact')).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}
async function openDoor(page: Page, targetId = id): Promise<void> {
  // The survey rig intentionally coasts. Settle before testing an unobstructed
  // full swing; opening into a still-moving occupant may correctly be held.
  await page.waitForFunction(() => window.__WAYFARER__!.snapshot().speed < 0.1, null, { timeout: 90_000 });
  await expect(page.locator('#building-interact')).toBeVisible();
  await page.keyboard.press('f');
  await page.waitForFunction((buildingId) => window.__WAYFARER__!.snapshot().buildings.buildings.find((b) => b.id === buildingId)?.doors[0]?.open, targetId, { timeout: 30_000 });
  await page.waitForFunction((buildingId) => {
    const door = window.__WAYFARER__?.snapshot().buildings.buildings.find((b) => b.id === buildingId)?.doors[0];
    return door?.open && door.angle > 1.5;
  }, targetId, { timeout: 90_000 });
}
async function moveUntil(page: Page, key: string, predicate: () => boolean, timeout = 45_000): Promise<void> {
  await page.keyboard.down(key);
  try { await page.waitForFunction(predicate, null, { timeout }); }
  finally { await page.keyboard.up(key); }
}

test('building URL streams real rooms, enforces the closed door and permits entry after interaction', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openBuilding(page);
  const before = await state(page);
  expect(before.buildings.colliders).toBeGreaterThan(50);
  expect(before.buildings.shells).toBeLessThanOrEqual(before.buildings.budget.shells);
  await expect(page.locator('#building-action')).toContainText('Open entrance door');
  await moveUntil(page, 'w', () => {
    const s = window.__WAYFARER__!.snapshot(), b = s.buildings.buildings.find((item) => item.interiorLoaded)!;
    return Math.hypot(s.position[0]! - b.entrance.x, s.position[2]! - b.entrance.z) > 2.4;
  });
  // Contact must remain closed even while the survey rig's momentum settles.
  await page.waitForFunction(() => window.__WAYFARER__!.snapshot().speed < 0.1, null, { timeout: 90_000 });
  const touching = await state(page);
  expect(touching.buildings.activeRoom).toBeNull();
  expect(touching.buildings.buildings.find((b) => b.id === id)?.doors[0]?.angle).toBe(0);
  await openDoor(page);
  await moveUntil(page, 'w', () => window.__WAYFARER__!.snapshot().buildings.activeRoom !== null);
  await expect(page.locator('#building-room')).not.toHaveText('Outside');
  expect((await state(page)).buildings.activeRoom?.buildingId).toBe(id);
  expect(errors).toEqual([]);
  await expect(page.locator('#fatal')).toBeHidden();
});

test('door modifications survive reload and interior unload/reload without rebuilding the seed', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openBuilding(page);
  await openDoor(page);
  const before = await state(page);
  expect(page.url()).toContain('building=');
  await page.reload();
  await page.waitForFunction((buildingId) => {
    const s = window.__WAYFARER__?.snapshot();
    return s?.ready && s.buildings.buildings.find((b) => b.id === buildingId)?.doors[0]?.open;
  }, id, { timeout: 120_000 });
  const reloaded = await state(page);
  expect(reloaded.seed).toBe(before.seed);
  expect(reloaded.buildings.buildings.find((b) => b.id === id)?.position).toEqual(before.buildings.buildings.find((b) => b.id === id)?.position);
  await page.keyboard.press('F7');
  await page.waitForFunction(() => {
    const s = window.__WAYFARER__?.snapshot(); return s?.ready && !s.inspecting && s.buildings.interiors === 0;
  }, null, { timeout: 30_000 });
  await page.keyboard.press('F7');
  await page.waitForFunction(() => {
    const s = window.__WAYFARER__?.snapshot(); return s?.ready && s.inspecting && s.buildings.interiors === 1;
  }, null, { timeout: 90_000 });
  expect((await state(page)).buildings.buildings.find((b) => b.id === id)?.doors[0]?.open).toBe(true);
  expect(errors).toEqual([]);
});

test('buildings, collisions and transparent windows work after a large-coordinate origin rebase', async ({ page }) => {
  test.setTimeout(180_000);
  const far = new TerrainField(seed).buildings.nearest({ x: 1_000_000, y: 100, z: -2_000_000 });
  expect(far).toBeDefined();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(query.replace(encodeURIComponent(id), encodeURIComponent(far!.id)));
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready, null, { timeout: 120_000 });
  const s = await state(page), loaded = s.buildings.buildings.find((b) => b.id === far!.id)!;
  expect(s.shifts).toBeGreaterThan(0);
  expect(Math.abs(s.position[0]! - s.origin[0]!)).toBeLessThanOrEqual(2048);
  expect(Math.abs(s.position[2]! - s.origin[2]!)).toBeLessThanOrEqual(2048);
  expect(loaded.position).toEqual(far!.position);
  expect(loaded.interiorLoaded).toBe(true); expect(s.buildings.colliders).toBeGreaterThan(50);
  await page.locator('#settings-toggle').click();
  await page.locator('#building-collision').check();
  await expect(page.locator('#building-collision')).toBeChecked();
  expect(errors).toEqual([]); await expect(page.locator('#fatal')).toBeHidden();
});

test('the existing settings panel can visit architecture without a special launch URL', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?renderer=webgl&quality=low&seed=playwright&vegetation=0');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready, null, { timeout: 90_000 });
  await page.locator('#menu-settings').click();
  await page.locator('#visit-building').click();
  await page.waitForFunction(() => {
    const s = window.__WAYFARER__?.snapshot(); return s?.ready && s.inspecting && s.buildings.interiors === 1;
  }, null, { timeout: 120_000 });
  await expect(page.locator('#building-inspection-hint')).toBeVisible();
  expect(page.url()).toContain('building='); expect(errors).toEqual([]);
});


test('lodge stair geometry supports inspection from the ground room to the upper gallery', async ({ page }) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 800, height: 520 });
  const lodge = new TerrainField(seed).buildings.nearby(0, 0, 7200).find((b) => b.template === 'lodge');
  expect(lodge).toBeDefined();
  const errors = await openBuilding(page, lodge!.id);
  await openDoor(page, lodge!.id);
  // Stop before the wall, then allow the survey rig's existing momentum to settle.
  await moveUntil(page, 'w', () => {
    const s = window.__WAYFARER__!.snapshot(), b = s.buildings.buildings.find((item) => item.interiorLoaded)!;
    return Math.sin(b.yaw) * (s.position[0]! - b.position.x) + Math.cos(b.yaw) * (s.position[2]! - b.position.z) < 7.05;
  });
  await page.waitForFunction(() => window.__WAYFARER__!.snapshot().speed < 0.1, null, { timeout: 90_000 });
  await moveUntil(page, 'd', () => {
    const s = window.__WAYFARER__!.snapshot(), b = s.buildings.buildings.find((item) => item.interiorLoaded)!;
    return Math.cos(b.yaw) * (s.position[0]! - b.position.x) - Math.sin(b.yaw) * (s.position[2]! - b.position.z) > 4.7;
  });
  await page.waitForFunction(() => window.__WAYFARER__!.snapshot().speed < 0.1, null, { timeout: 90_000 });
  await moveUntil(page, 'w', () => {
    const s = window.__WAYFARER__!.snapshot(), b = s.buildings.buildings.find((item) => item.interiorLoaded)!;
    const z = Math.sin(b.yaw) * (s.position[0]! - b.position.x) + Math.cos(b.yaw) * (s.position[2]! - b.position.z);
    return z < -0.5 && s.position[1]! - b.position.y > 5;
  }, 90_000);
  await expect(page.locator('#building-room')).toHaveText('Upper gallery');
  expect((await state(page)).buildings.activeRoom?.roomId).toBe('loft');
  expect(errors).toEqual([]);
});

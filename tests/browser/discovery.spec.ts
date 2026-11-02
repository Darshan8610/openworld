import { test, expect } from '@playwright/test';
test('map waypoint and manual save slot roundtrip', async ({ page }) => {
  await page.goto('/?seed=phase11&renderer=webgl&quality=low&mode=character');
  await page.waitForFunction(() => window.__WAYFARER__?.snapshot().ready, null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Map · M' }).click();
  const map = page.getByLabel('Local terrain and road map');
  await expect(map).toBeVisible();
  await map.click({ position: { x: 210, y: 160 } });
  await page.getByRole('button', { name: 'Save 1', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('wayfarer.game.slot.1'))).not.toBeNull();
  await page.getByRole('button', { name: 'Clear waypoint' }).click();
  await page.getByRole('button', { name: 'Load 1', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__WAYFARER__?.snapshot().discovery.waypoint)).not.toBeNull();
});

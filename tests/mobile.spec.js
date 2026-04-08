// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8080/tests/test-harness.html';

const PORTRAIT  = { width: 375, height: 812 };
const LANDSCAPE = { width: 812, height: 375 };

// Helper: simulate a touch tap at pixel (x, y) on the map container
async function touchTap(page, x, y) {
  await page.evaluate(([tx, ty]) => {
    // Target the map container so the touchend event reaches the listener
    const mapContainer = document.getElementById('map');
    const el = mapContainer || document.elementFromPoint(tx, ty) || document.body;
    const touch = new Touch({ identifier: Date.now(), target: el, clientX: tx, clientY: ty });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], changedTouches: [touch] }));
    el.dispatchEvent(new TouchEvent('touchend',   { bubbles: true, touches: [],      changedTouches: [touch] }));
  }, [x, y]);
}

// Helper: simulate a double-tap (two taps within 200ms at same spot)
async function doubleTap(page, x, y) {
  await touchTap(page, x, y);
  await page.waitForTimeout(100);
  await touchTap(page, x, y);
}

// Helper: wait for the app to load
async function waitForApp(page) {
  await page.goto(BASE, { waitUntil: 'commit', timeout: 15000 });
  await page.waitForFunction(() => window.__TEST_READY === true, { timeout: 15000 });
  await page.waitForTimeout(500);
}

// Helper: dismiss login overlay, init map, and inject admin UI
async function setupAdmin(page) {
  await page.evaluate(async () => {
    // Remove login overlay if present
    document.getElementById('login-overlay')?.remove();
    // Initialize map and TurfDraw if not already done
    if (!MapModule.map) {
      MapModule.init();
      TurfDraw.init(MapModule.map);
    }
    // Mark as admin
    UI.isAdmin = true;
    // Inject admin tools
    const adminRow2 = document.getElementById('admin-row2');
    if (adminRow2) {
      adminRow2.style.display = 'flex';
      adminRow2.innerHTML = `
        <div class="admin-badge-row2">
          <span class="admin-shield">Admin</span>
          <button class="admin-field-btn" onclick="UI._dropToFieldMode()">Exit Admin</button>
        </div>
        <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">Draw Zone</button>
        <button class="admin-btn" onclick="UI.showAddHouseModal()">+ House</button>
        <button class="admin-btn" onclick="UI.showAddKnockModal()">+ Knock</button>
        <button class="admin-btn" onclick="UI.showImportModal()">Import</button>
        <button class="admin-btn" onclick="UI.exportCSV()">Export</button>`;
    }
  });
  await page.waitForTimeout(500);
}

// ─── Test 1: Admin tools visible in portrait mode ─────────────────────────
test.describe('Portrait mode (375x812)', () => {
  test.use({ viewport: PORTRAIT, hasTouch: true, isMobile: true });

  test('admin tools are visible after login', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    const adminRow = page.locator('#admin-row2');
    await expect(adminRow).toBeVisible();

    const drawBtn = page.locator('#draw-mode-btn');
    await expect(drawBtn).toBeVisible();

    // row2-right should span most of the viewport width
    const row2Right = page.locator('#row2-right');
    const row2Box = await row2Right.boundingBox();
    expect(row2Box.width).toBeGreaterThan(PORTRAIT.width * 0.8);

    // All admin buttons should be within viewport bounds
    const buttons = page.locator('.admin-btn');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PORTRAIT.width + 2);
    }

    await page.screenshot({ path: 'tests/screenshots/portrait-admin-tools.png', fullPage: false });
  });
});

// ─── Test 2: Admin tools visible in landscape mode ────────────────────────
test.describe('Landscape mode (812x375)', () => {
  test.use({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });

  test('admin tools are visible in landscape', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    await expect(page.locator('#admin-row2')).toBeVisible();
    await expect(page.locator('#draw-mode-btn')).toBeVisible();

    await page.screenshot({ path: 'tests/screenshots/landscape-admin-tools.png', fullPage: false });
  });
});

// ─── Test 3: Mobile polygon draw tests ────────────────────────────────────
test.describe('Mobile polygon draw (375x812)', () => {
  test.use({ viewport: PORTRAIT, hasTouch: true, isMobile: true });

  test('draw mode shows polygon banner and accepts double-tap vertices', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    // Enter draw mode
    await page.locator('#draw-mode-btn').click();
    await page.waitForTimeout(500);

    // Polygon banner should appear (not the old rectangle banner)
    await expect(page.locator('#mobile-poly-banner')).toBeVisible();
    await expect(page.locator('#mobile-rect-banner')).toHaveCount(0);

    // Banner shows "0 placed"
    const status = page.locator('#mpb-status');
    await expect(status).toContainText('0 placed');

    await page.screenshot({ path: 'tests/screenshots/polygon-banner-shown.png', fullPage: false });

    // Double-tap to place first vertex
    const mapEl = page.locator('#map');
    const mapBox = await mapEl.boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;

    await doubleTap(page, cx, cy);
    await page.waitForTimeout(400);
    await expect(status).toContainText('1 placed');
    await expect(page.locator('#finish-zone-btn')).toHaveCount(0);
    await page.screenshot({ path: 'tests/screenshots/polygon-1-vertex.png', fullPage: false });

    // Place second vertex
    await doubleTap(page, cx + 60, cy - 80);
    await page.waitForTimeout(400);
    await expect(status).toContainText('2 placed');
    await expect(page.locator('#finish-zone-btn')).toHaveCount(0);
    await page.screenshot({ path: 'tests/screenshots/polygon-2-vertices.png', fullPage: false });

    // Place third vertex — Finish Zone button should appear
    await doubleTap(page, cx + 60, cy + 80);
    await page.waitForTimeout(400);
    await expect(status).toContainText('3 placed');
    await expect(page.locator('#finish-zone-btn')).toBeVisible();
    await expect(page.locator('#finish-zone-btn')).toContainText('Finish Zone');
    await page.screenshot({ path: 'tests/screenshots/polygon-3-vertices-finish-btn.png', fullPage: false });
  });

  test('single tap does NOT place a vertex', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    await page.locator('#draw-mode-btn').click();
    await page.waitForTimeout(500);

    const status = page.locator('#mpb-status');
    await expect(status).toContainText('0 placed');

    // Single tap on map — should NOT add vertex
    const mapEl = page.locator('#map');
    const mapBox = await mapEl.boundingBox();
    await touchTap(page, mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    await page.waitForTimeout(500);

    await expect(status).toContainText('0 placed');
    await page.screenshot({ path: 'tests/screenshots/single-tap-no-vertex.png', fullPage: false });
  });

  test('undo removes last vertex and hides finish button when < 3', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    await page.locator('#draw-mode-btn').click();
    await page.waitForTimeout(500);

    const mapEl = page.locator('#map');
    const mapBox = await mapEl.boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;

    // Place 3 vertices
    await doubleTap(page, cx, cy);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 60, cy - 80);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 60, cy + 80);
    await page.waitForTimeout(300);

    const status = page.locator('#mpb-status');
    await expect(status).toContainText('3 placed');
    await expect(page.locator('#finish-zone-btn')).toBeVisible();

    // Click Undo
    await page.locator('#mobile-poly-banner button', { hasText: 'Undo' }).click();
    await page.waitForTimeout(300);

    await expect(status).toContainText('2 placed');
    await expect(page.locator('#finish-zone-btn')).toHaveCount(0);
    await page.screenshot({ path: 'tests/screenshots/undo-vertex.png', fullPage: false });
  });

  test('cancel removes all UI elements', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    await page.locator('#draw-mode-btn').click();
    await page.waitForTimeout(500);

    const mapEl = page.locator('#map');
    const mapBox = await mapEl.boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;

    await doubleTap(page, cx, cy);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 60, cy - 80);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 60, cy + 80);
    await page.waitForTimeout(300);

    // Cancel
    await page.locator('#mobile-poly-banner button', { hasText: 'Cancel' }).click();
    await page.waitForTimeout(300);

    await expect(page.locator('#mobile-poly-banner')).toHaveCount(0);
    await expect(page.locator('#finish-zone-btn')).toHaveCount(0);
    await page.screenshot({ path: 'tests/screenshots/cancel-draw.png', fullPage: false });
  });
});

// ─── Test 4: Landscape polygon draw ───────────────────────────────────────
test.describe('Mobile polygon draw (812x375 landscape)', () => {
  test.use({ viewport: LANDSCAPE, hasTouch: true, isMobile: true });

  test('polygon draw works in landscape orientation', async ({ page }) => {
    await waitForApp(page);
    await setupAdmin(page);

    await page.locator('#draw-mode-btn').click();
    await page.waitForTimeout(500);

    await expect(page.locator('#mobile-poly-banner')).toBeVisible();

    const mapEl = page.locator('#map');
    const mapBox = await mapEl.boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;

    // Place 4 vertices
    await doubleTap(page, cx - 50, cy - 30);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 50, cy - 30);
    await page.waitForTimeout(300);
    await doubleTap(page, cx + 50, cy + 30);
    await page.waitForTimeout(300);
    await doubleTap(page, cx - 50, cy + 30);
    await page.waitForTimeout(300);

    await expect(page.locator('#mpb-status')).toContainText('4 placed');
    await expect(page.locator('#finish-zone-btn')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/landscape-polygon-draw.png', fullPage: false });
  });
});

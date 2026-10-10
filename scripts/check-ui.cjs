const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const commands = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/command') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const command = JSON.parse(Buffer.concat(chunks).toString());
      commands.push(command);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: 'ros', responseStatus: 200,
        feedback: ['dock', 'cancelDock'].includes(command.action) ? command.action : '' }));
      return;
    }
    if (pathname.endsWith('.mjpg')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(await fs.readFile(path.join(root, 'android-app/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')));
      return;
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, android: req.headers['x-test-platform'] !== 'windows', native: true,
        defaultRobotIp: '127.0.0.1', ros: { connected: true, lastFrameAt: Date.now() },
        bridge: { running: true }, network: { rosMaster: { ok: true } } }));
      return;
    }
    if (pathname === '/vendor/hls.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(''); return;
    }
    const filename = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(root, 'public', '.' + filename);
    if (!file.startsWith(path.join(root, 'public') + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    await fs.mkdir(path.join(root, '.runtime/screenshots'), { recursive: true });
    for (const scenario of [
      { name: 'console', width: 960, height: 540 },
      { name: 'console-wide', width: 1920, height: 1080 },
      { name: 'phone', width: 390, height: 844 },
      { name: 'windows', width: 1366, height: 768 },
    ]) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
        extraHTTPHeaders: { 'x-test-platform': scenario.name === 'windows' ? 'windows' : 'android' } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => document.querySelector('#log').textContent.includes('Interface prete'));
      assert.equal(await page.locator('#startProxy').isVisible(), false);
      assert.equal(await page.locator('[data-action="photo"]').isVisible(), false);
      assert.equal(await page.locator('#strafeRange').isVisible(), true);
      assert.equal(await page.locator('#turnRange').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${scenario.name}: horizontal overflow`);
      assert.ok(await page.locator('#mjpegElement').evaluate((image) => image.complete && image.naturalWidth > 0));
      await page.evaluate(() => {
        window.feedbackEvents = [];
        window.ScoutInput = { select(value) { window.selectedDevice = value; }, refresh() {}, feedback(event) { window.feedbackEvents.push(event); } };
        window.scoutNativeControllersUpdate([
          { id: 2, name: 'Xbox Wireless Controller', virtual: true },
          { id: 7, name: 'Mangmi Air X Integrated Controller', analog: true },
        ], { mode: 'auto' });
        window.scoutNativeGamepadUpdate([0, 0, 0, 0], [], true, 'Xbox Wireless Controller', 2);
      });
      assert.equal(await page.locator('#controllerSelect option').count(), 3);
      await page.locator('#controllerSelect').selectOption('7');
      assert.equal(await page.evaluate(() => window.selectedDevice), '7');
      assert.equal(await page.locator('#armButton').textContent(), 'Armer');
      await page.evaluate(() => {
        window.scoutNativeGamepadUpdate([0, -1, 0, 0], [], true, 'Xbox Wireless Controller', 2);
        window.scoutNativeButton(9, 2);
      });
      assert.equal(await page.locator('#armButton').textContent(), 'Armer');
      await page.evaluate(() => window.scoutNativeGamepadUpdate([0, 0, 0, 0], [], true, 'Mangmi Air X Integrated Controller', 7));
      await page.waitForTimeout(60);
      await page.evaluate(() => window.scoutNativeButton(0, 7));
      await page.waitForFunction(() => document.querySelector('#armButton').textContent === 'Desarmer');
      await page.waitForTimeout(60);
      assert.ok(commands.some((command) => command.action === 'undock'));
      await page.evaluate(() => window.scoutNativeGamepadUpdate([0, -0.8, 0, 0], [], true, 'Mangmi Air X Integrated Controller', 7));
      await page.waitForTimeout(100);
      const before = commands.length;
      await page.evaluate(() => window.scoutNativeGamepadUpdate([0, 0, 0, 0], [], true, 'Mangmi Air X Integrated Controller', 7));
      await page.waitForTimeout(60);
      assert.ok(commands.slice(before).some((command) => command.action === 'stop'));
      await page.evaluate(() => window.scoutNativeButton(1, 7));
      await page.waitForFunction(() => window.feedbackEvents.includes('dock'));
      await page.evaluate(() => window.scoutNativeButton(0, 7));
      await page.waitForFunction(() => window.feedbackEvents.includes('cancelDock'));
      assert.deepEqual(await page.evaluate(() => window.feedbackEvents), ['dock', 'cancelDock']);
      assert.equal(commands.at(-1).action, 'cancelDock');
      await page.evaluate(() => window.scoutNativeButton(4, 7));
      assert.equal(await page.locator('#mjpegElement').isVisible(), false);
      await page.evaluate(() => window.scoutNativeButton(4, 7));
      assert.equal(await page.locator('#mjpegElement').isVisible(), true);
      assert.equal(await page.evaluate(() => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        document.querySelector('#videoFrame').dispatchEvent(event);
        return event.defaultPrevented;
      }), true);
      await page.screenshot({ path: path.join(root, `.runtime/screenshots/${scenario.name}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${scenario.name} ${scenario.width}x${scenario.height}`);
    }
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

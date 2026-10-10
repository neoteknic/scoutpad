const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const commands = [];
  const audioCommands = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/soundboard/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (pathname.endsWith('/encode')) {
        assert.ok(body.length > 0 && body.length <= 960000 && body.length % 2 === 0);
        res.writeHead(200, { 'content-type': 'audio/aac' });
        res.end(Buffer.from([255,241,96,64,1,95,252,0,0,0])); return;
      }
      if (!pathname.endsWith('/status')) audioCommands.push({ pathname, sequence: Number(req.headers['x-sound-sequence']), body, query: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, simulated: req.url.includes('simulation=true'), audio: { state: 'idle', playing: false } })); return;
    }
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
    if (pathname === '/vendor/lucide.min.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(await fs.readFile(path.join(root, 'node_modules/lucide/dist/umd/lucide.min.js'))); return;
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
      const pcm = new ArrayBuffer(8000);
      const fixture = Buffer.from(await (await import('../public/soundboard-audio.js')).wav(pcm).arrayBuffer());
      await page.locator('#soundFile').setInputFiles({ name: 'Test.wav', mimeType: 'audio/wav', buffer: fixture });
      await page.waitForFunction(() => document.querySelectorAll('.sound-row').length === 1);
      assert.equal(await page.locator('.sound-row svg').count(), 3);
      assert.equal(await page.locator('#soundBindings select').count(), 6);
      const soundId = await page.locator('.sound-row').getAttribute('data-sound-id');
      for (const index of [12,13,14,15,2,3]) await page.locator(`[data-sound-button="${index}"]`).selectOption(soundId);
      await page.locator('.sound-row input').fill('Mon son');
      await page.locator('.sound-row input').press('Tab');
      await page.waitForTimeout(100);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.sound-row input')?.value === 'Mon son');
      for (const index of [12,13,14,15,2,3]) {
        assert.equal(await page.locator(`[data-sound-button="${index}"]`).inputValue(), soundId);
        assert.equal(await page.locator(`[data-sound-button="${index}"] option:checked`).textContent(), 'Mon son');
      }
      await page.evaluate(() => window.scoutNativeGamepadUpdate([0,0,0,0], [], true, 'Mangmi Air X Integrated Controller', 7));
      const beforeBindings = audioCommands.length;
      const beforeMovement = commands.length;
      await page.locator('[data-sound-button="12"]').focus();
      await page.evaluate(() => window.scoutNativeButton(12,7));
      await page.waitForTimeout(80);
      assert.equal(audioCommands.length, beforeBindings, 'editing assignments must not play');
      await page.locator('[data-sound-button="12"]').evaluate((node) => node.blur());
      await page.evaluate(() => window.scoutNativeButton(12,2));
      await page.waitForTimeout(80);
      assert.equal(audioCommands.length, beforeBindings, 'wrong controller must not play');
      for (const index of [12,13,14,15,2,3]) {
        const beforePress = audioCommands.filter((item) => item.pathname.endsWith('/play')).length;
        await page.evaluate((button) => window.scoutNativeButton(button,7), index);
        await page.waitForTimeout(80);
        assert.equal(audioCommands.filter((item) => item.pathname.endsWith('/play')).length, beforePress + 1);
      }
      assert.equal(await page.locator('#armButton').textContent(), 'Armer');
      assert.ok(!commands.slice(beforeMovement).some((item) => item.action !== 'stop'), 'bindings must not move robot');
      await page.getByRole('button', { name: 'Ecouter ici', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Ecouter ici"]').getAttribute('aria-pressed') === 'true');
      const beforeAudio = audioCommands.length;
      await page.getByRole('button', { name: 'Jouer sur le robot', exact: true }).click();
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'Arreter les sons', exact: true }).click();
      await page.waitForTimeout(100);
      const sent = audioCommands.slice(beforeAudio);
      assert.ok(sent.some((item) => item.pathname.endsWith('/play') && item.body.length === 10));
      assert.ok(sent.some((item) => item.pathname.endsWith('/stop')));
      assert.ok(sent.at(-1).sequence > sent[0].sequence);
      assert.equal(await page.locator('#armButton').textContent(), 'Armer', 'sound must not arm robot');
      await page.locator('#simulationToggle').check();
      await page.getByRole('button', { name: 'Jouer sur le robot', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#soundStatus').textContent.includes('Simulation'));
      assert.ok(audioCommands.at(-1).query.includes('simulation=true'));
      await page.locator('#simulationToggle').uncheck();
      const tooLong = Buffer.from(await (await import('../public/soundboard-audio.js')).wav(new ArrayBuffer(31 * 32000)).arrayBuffer());
      await page.locator('#soundFile').setInputFiles({ name: 'Long.wav', mimeType: 'audio/wav', buffer: tooLong });
      await page.waitForFunction(() => document.querySelector('#soundStatus').textContent.includes('30 secondes'));
      assert.equal(await page.locator('.sound-row').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(root, `.runtime/screenshots/${scenario.name}.png`), fullPage: true });
      if (scenario.name === 'windows') {
        await page.reload();
        await page.waitForFunction(() => document.querySelector('.sound-row input')?.value === 'Mon son');
        await page.evaluate(() => {
          window.testPad = { index:0, id:'Xbox Browser', connected:true, mapping:'standard', axes:[0,0,0,0], buttons:Array.from({length:16},()=>({pressed:false,value:0})) };
          Object.defineProperty(navigator, 'getGamepads', { configurable:true, value:()=>[window.testPad] });
        });
        const beforeBrowserMotion = commands.length;
        for (const index of [12,13,14,15,2,3]) {
          const beforePress = audioCommands.filter((item) => item.pathname.endsWith('/play')).length;
          await page.evaluate((button) => { window.testPad.buttons[button] = { pressed:true,value:1 }; }, index);
          await page.waitForTimeout(220);
          assert.equal(audioCommands.filter((item) => item.pathname.endsWith('/play')).length, beforePress + 1, 'holding browser button must not repeat sound');
          await page.evaluate((button) => { window.testPad.buttons[button] = { pressed:false,value:0 }; }, index);
          await page.waitForTimeout(60);
        }
        assert.equal(await page.locator('#armButton').textContent(), 'Armer');
        assert.ok(!commands.slice(beforeBrowserMotion).some((item) => item.action !== 'stop'));
      }
      await page.getByRole('button', { name: 'Supprimer le son', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.sound-row').length === 0);
      for (const index of [12,13,14,15,2,3]) assert.equal(await page.locator(`[data-sound-button="${index}"]`).inputValue(), '');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('scoutpad-sound-bindings'))), {});
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

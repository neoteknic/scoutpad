const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const root = path.resolve(__dirname, '../dist/ScoutPad-Windows-x64');

async function checkBackend() {
  const child = spawn(path.join(root, 'scout-backend.exe'), ['-robot', '127.0.0.1', '-assets', path.join(root, 'public')],
    { cwd: root, windowsHide: true });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes('ScoutPad ready:')) {
      assert.equal(child.exitCode, null, 'Backend exited before readiness');
      assert.ok(Date.now() < deadline, 'Backend readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const index = await fetch('http://127.0.0.1:18114/', { signal: AbortSignal.timeout(2000) });
    assert.equal(index.status, 200);
    assert.ok((await index.text()).includes('armButton'));
    const status = await fetch('http://127.0.0.1:18114/api/status', { signal: AbortSignal.timeout(2000) });
    const body = await status.json();
    assert.equal(body.platform, 'windows');
    assert.equal(body.defaultRobotIp, '127.0.0.1');
    const audioStatus = await fetch('http://127.0.0.1:18114/api/soundboard/status');
    assert.equal((await audioStatus.json()).audio.state, 'idle');
    const encoded = await fetch('http://127.0.0.1:18114/api/soundboard/encode', { method: 'POST', body: new Uint8Array(8000), signal: AbortSignal.timeout(10000) });
    assert.equal(encoded.status, 200, 'offline audio encoding failed');
    const aac = new Uint8Array(await encoded.arrayBuffer());
    assert.equal(aac[0], 255);
    assert.equal((aac[2] >> 2) & 15, 8);
    assert.equal(aac[2] >> 6, 1);
    const audioStop = await fetch('http://127.0.0.1:18114/api/soundboard/stop', { method: 'POST', headers: { 'X-Sound-Client': 'smoke', 'X-Sound-Sequence': '2' } });
    assert.equal(audioStop.status, 200);
    const stalePlay = await fetch('http://127.0.0.1:18114/api/soundboard/play', { method: 'POST', headers: { 'X-Sound-Client': 'smoke', 'X-Sound-Sequence': '1' }, body: aac });
    assert.equal(stalePlay.status, 409, 'stop must invalidate playback');
    const stop = await fetch('http://127.0.0.1:18114/api/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', clientId: 'smoke-test', commandSeq: 1 }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(stop.status, 200);
  } finally {
    if (child.exitCode === null) child.stdin.end('stop\n');
    const timer = setTimeout(() => child.kill(), 5000);
    const [code] = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, 'Backend shutdown failed');
  }
  console.log('PASS Windows backend: assets, status, stop, graceful shutdown');
}

async function checkLauncher() {
  const child = spawn(path.join(root, 'ScoutPad.exe'), ['--smoke-test'], { cwd: root, windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'Launcher smoke test failed');
    console.log('PASS Windows launcher: startup and graceful shutdown');
  } finally { clearTimeout(timer); }
}

checkBackend().then(checkLauncher).catch((error) => { console.error(error); process.exitCode = 1; });

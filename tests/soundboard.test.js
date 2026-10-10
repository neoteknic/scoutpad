import test from "node:test";
import assert from "node:assert/strict";
import { pcm16, wav, validateImport } from "../public/soundboard-audio.js";
import { encodePCM } from "../audio-server.js";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

test("PCM attenuates, clamps and replaces nonfinite samples", () => {
  const view = new DataView(pcm16(new Float32Array([-2, -1, 0, 1, 2, NaN])));
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true)), [-32768, -26214, 0, 26214, 32767, 0]);
});
test("WAV stores mono 16k PCM in a valid RIFF header", async () => {
  const data = await wav(pcm16(new Float32Array(160))).arrayBuffer();
  const view = new DataView(data);
  assert.equal(new TextDecoder().decode(data.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 320);
  assert.equal(data.byteLength, 364);
});
test("imports enforce file and duration limits", () => {
  for (const duration of [0, NaN, 30.01]) assert.throws(() => validateImport({ size: 100 }, duration));
  assert.throws(() => validateImport({ size: 11 * 1024 * 1024 }, 1));
  validateImport({ size: 1024 }, 30);
});
test("offline ffmpeg conversion produces AAC-LC mono 16k ADTS", async () => {
  const samples = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.1);
  const data = await encodePCM(ffmpegInstaller.path, Buffer.from(pcm16(samples)));
  let frames = 0;
  for (let offset = 0; offset < data.length;) {
    assert.equal(data[offset], 0xff);
    assert.equal(data[offset + 2] >> 6, 1);
    assert.equal((data[offset + 2] >> 2) & 15, 8);
    assert.equal((data[offset + 3] >> 6) | ((data[offset + 2] & 1) << 2), 1);
    const length = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    assert.ok(length > 7 && length <= 1024 && offset + length <= data.length);
    offset += length; frames++;
  }
  assert.ok(frames >= 4);
});
test("encoding rejects oversized and incomplete PCM", async () => {
  await assert.rejects(encodePCM(ffmpegInstaller.path, Buffer.alloc(960002)));
  await assert.rejects(encodePCM(ffmpegInstaller.path, Buffer.alloc(1)));
});

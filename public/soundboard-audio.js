export const MAX_SOUNDS = 24;
export const MAX_DURATION = 30;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 30 * 1024 * 1024;

export function pcm16(samples) {
  const pcm = new ArrayBuffer(samples.length * 2);
  const view = new DataView(pcm);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] * 0.8 : 0));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return pcm;
}

export function wav(pcm) {
  const result = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(result);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
  view.setUint32(40, pcm.byteLength, true); new Uint8Array(result, 44).set(new Uint8Array(pcm));
  return new Blob([result], { type: "audio/wav" });
}

export function validateImport(file, duration) {
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("Fichier limite a 10 Mo");
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) throw new Error("Son limite a 30 secondes");
}

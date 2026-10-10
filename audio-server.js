import { spawn } from "node:child_process";

export const MAX_PCM_BYTES = 960000;
export const MAX_AAC_BYTES = 262144;

export async function readAudioBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Son trop volumineux");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function encodePCM(executable, pcm, signal) {
  if (!pcm.length || pcm.length > MAX_PCM_BYTES || pcm.length % 2) {
    return Promise.reject(new Error("PCM mono 16 kHz, 30 secondes maximum"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "32k", "-f", "adts", "pipe:1"], { windowsHide: true });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const abort = () => finish(new Error("Conversion annulee"));
    const timer = setTimeout(() => finish(new Error("Delai de conversion depasse")), 20000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new Error("Convertisseur audio indisponible")));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_AAC_BYTES) finish(new Error("Son encode trop volumineux"));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("close", (code) => finish(code || !size ? new Error("Conversion audio impossible") : null));
    if (signal?.aborted) abort();
    else child.stdin.end(pcm);
  });
}

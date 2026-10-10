import { pcm16, wav, validateImport, MAX_SOUNDS, MAX_FILE_BYTES, MAX_LIBRARY_BYTES } from "./soundboard-audio.js";

const list = document.querySelector("#soundList");
const status = document.querySelector("#soundStatus");
const picker = document.querySelector("#soundFile");
const importer = document.querySelector("#importSound");
const client = crypto.randomUUID();
let sequence = 0;
let pending;
let sounds = [];
let db;
let busy = false;
let audioContext;
let preview;
let previewUrl;
let previewId;
let activeId;
let polling = false;
let sending = false;
let hasError = false;

function message(text, error = false) {
  hasError = error;
  status.textContent = text;
  status.classList.toggle("sound-error", error);
}
function icons() { window.lucide?.createIcons({ root: document.querySelector("#soundboard") }); }
function requestStore(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("sounds", mode);
    const request = operation(transaction.objectStore("sounds"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || new Error("Stockage des sons indisponible"));
    transaction.onabort = () => reject(transaction.error || new Error("Stockage des sons indisponible"));
  });
}
function stopPreview() {
  preview?.pause(); preview = null; previewId = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}
function control(icon, label, action) {
  const button = document.createElement("button");
  button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
  button.className = "sound-icon";
  const glyph = document.createElement("i"); glyph.dataset.lucide = icon; button.append(glyph);
  button.addEventListener("click", () => void action());
  return button;
}
function render() {
  list.replaceChildren();
  if (!sounds.length) {
    const empty = document.createElement("p"); empty.className = "sound-empty"; empty.textContent = "Aucun son"; list.append(empty);
  }
  for (const sound of sounds) {
    const row = document.createElement("div"); row.className = "sound-row";
    row.dataset.soundId = sound.id; row.classList.toggle("is-playing", activeId === sound.id);
    const name = document.createElement("input"); name.value = sound.name; name.maxLength = 80;
    name.setAttribute("aria-label", "Nom du son");
    name.addEventListener("change", async () => {
      const previous = sound.name; sound.name = name.value.trim() || previous; name.value = sound.name;
      try { await requestStore("readwrite", (store) => store.put(sound)); }
      catch { sound.name = previous; name.value = previous; message("Nom non sauvegarde", true); }
    });
    const duration = document.createElement("span"); duration.className = "sound-duration";
    duration.textContent = `${sound.duration.toFixed(1)} s`;
    const play = control("radio", "Jouer sur le robot", () => playRobot(sound));
    const local = control("headphones", "Ecouter ici", async () => {
      try {
        if (previewId === sound.id) { stopPreview(); render(); return; }
        stopPreview(); previewUrl = URL.createObjectURL(sound.preview); preview = new Audio(previewUrl); previewId = sound.id;
        preview.addEventListener("ended", () => { stopPreview(); render(); }, { once: true });
        await preview.play(); render();
      } catch { stopPreview(); message("Preecoute indisponible", true); }
    });
    local.setAttribute("aria-pressed", String(previewId === sound.id));
    const remove = control("trash-2", "Supprimer le son", async () => {
      try {
        if (activeId === sound.id) await stopRobot();
        if (previewId === sound.id) stopPreview();
        await requestStore("readwrite", (store) => store.delete(sound.id));
        sounds = sounds.filter((item) => item.id !== sound.id); render();
      } catch (error) { message(error.message, true); }
    });
    row.append(name, duration, play, local, remove); list.append(row);
  }
  importer.disabled = busy || !db || sounds.length >= MAX_SOUNDS;
  icons();
}

async function importSound(file) {
  if (busy) return;
  busy = true; render(); message("Import en cours...");
  try {
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("Fichier limite a 10 Mo");
    if (sounds.length >= MAX_SOUNDS) throw new Error("Bibliotheque limitee a 24 sons");
    audioContext ||= new AudioContext();
    const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
    validateImport(file, decoded.duration);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const mono = await offline.startRendering();
    const pcm = pcm16(mono.getChannelData(0));
    const response = await fetch("/api/soundboard/encode", { method: "POST", body: pcm, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error((await response.json()).error || "Conversion impossible");
    const aac = await response.blob();
    if (!aac.size || aac.size > 262144) throw new Error("Conversion audio invalide");
    const sound = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Son", duration: decoded.duration, createdAt: Date.now(), aac, preview: wav(pcm) };
    const used = sounds.reduce((total, item) => total + item.aac.size + item.preview.size, 0);
    if (used + aac.size + sound.preview.size > MAX_LIBRARY_BYTES) throw new Error("Bibliotheque pleine");
    await requestStore("readwrite", (store) => store.put(sound));
    sounds.push(sound); message("Son ajoute");
  } catch (error) { message(error.message || "Import impossible", true); }
  finally { busy = false; picker.value = ""; render(); }
}

function headers(seq) { return { "X-Sound-Client": client, "X-Sound-Sequence": String(seq) }; }
async function playRobot(sound) {
  const seq = ++sequence;
  pending?.abort(); pending = new AbortController();
  const controller = pending;
  activeId = sound.id; sending = true; message("Connexion au haut-parleur..."); render();
  const query = new URLSearchParams({ robotIp: document.querySelector("#robotIp").value.trim(), name: sound.name, simulation: String(document.querySelector("#simulationToggle").checked) });
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/soundboard/play?${query}`, { method: "POST", headers: headers(seq), body: sound.aac, signal: controller.signal });
    const result = await response.json();
    if (seq !== sequence) return;
    if (!response.ok || !result.ok) throw new Error(result.error || "Lecture impossible");
    if (result.simulated) { activeId = null; message("Simulation : son non envoye"); }
    else message("Preparation du haut-parleur...");
  } catch (error) {
    if (seq === sequence) {
      // A lost response can still have started playback. Invalidate it explicitly.
      await stopRobot(false);
      message(error.name === "AbortError" ? "Delai de lecture depasse" : error.message, true);
    }
  } finally {
    clearTimeout(timer);
    if (seq === sequence) { pending = null; sending = false; render(); }
  }
}
async function stopRobot(show = true) {
  const seq = ++sequence;
  pending?.abort(); pending = null; sending = false; activeId = null; render();
  try {
    const response = await fetch("/api/soundboard/stop", { method: "POST", headers: headers(seq), keepalive: true, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Arret audio non confirme");
    if (seq === sequence && show) message("Son arrete");
  } catch (error) { if (seq === sequence) message(error.message, true); }
}
async function poll() {
  if (document.hidden || polling || sending) return;
  polling = true;
  const seq = sequence;
  try {
    const response = await fetch("/api/soundboard/status", { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("Haut-parleur inaccessible");
    const { audio } = await response.json();
    if (seq !== sequence || sending) return;
    if (audio.playing) {
      message(audio.state === "starting" ? "Preparation du haut-parleur..." : `${audio.name} : ${(audio.position || 0).toFixed(1)} / ${(audio.duration || 0).toFixed(1)} s`);
    } else if (activeId) { activeId = null; render(); if (!hasError) message("Pret"); }
  } catch { if (seq === sequence && activeId) { activeId = null; render(); message("Connexion audio perdue", true); } }
  finally { polling = false; }
}

importer.addEventListener("click", () => picker.click());
picker.addEventListener("change", () => { if (picker.files[0]) void importSound(picker.files[0]); });
document.querySelector("#stopSound").addEventListener("click", () => { stopPreview(); void stopRobot(); });
window.scoutSoundboard = { suspend() { stopPreview(); if (activeId || sending) void stopRobot(false); } };
document.addEventListener("visibilitychange", () => { if (document.hidden) window.scoutSoundboard.suspend(); });
window.addEventListener("pagehide", () => window.scoutSoundboard.suspend());
document.querySelector("#simulationToggle").addEventListener("change", () => window.scoutSoundboard.suspend());

async function init() {
  icons(); importer.disabled = true;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("scoutpad-sounds", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("sounds", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    sounds = (await requestStore("readonly", (store) => store.getAll())).sort((a, b) => a.createdAt - b.createdAt);
    render(); setInterval(() => void poll(), 1000);
  } catch { message("Stockage des sons indisponible", true); }
}
void init();

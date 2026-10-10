const CLIENT_VERSION = 10;

const state = {
  armed: false,
  armPending: false,
  armGeneration: 0,
  armPromise: null,
  rosConnectPromise: null,
  autoInputActive: false,
  gamepadIndex: null,
  gamepadSeenAt: 0,
  lastGamepadId: "",
  gamepadApiWarned: false,
  commandInFlight: false,
  pendingDrive: null,
  actionQueue: [],
  activeRequest: null,
  commandSequence: 0,
  clientId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  lastSendAt: 0,
  idleSent: false,
  buttonLatch: new Set(),
  keyActionLatch: new Set(),
  lastVector: { x: 0, y: 0, turn: 0 },
  keys: new Set(),
  hls: null,
  videoEnabled: true,
  nativeGamepad: null,
  nativeControllers: [],
  controllerChoice: "auto",
  controllerOptionsKey: "",
  controllerMenuOpen: false,
  android: false,
  suspended: false,
  awaitingNeutral: false,
  manualVector: null,
  navigationBusy: false,
  returnRequested: false,
  cancellationUncertain: false,
  audioContext: null,
  videoStartedAt: 0,
  videoRetryAt: 0,
  videoRetryCount: 0,
  statusInFlight: false,
  commandLatencyMs: null,
  backendLost: false
};

const elements = {
  connectionText: document.querySelector("#connectionText"),
  gamepadBadge: document.querySelector("#gamepadBadge"),
  rosLinkBadge: document.querySelector("#rosLinkBadge"),
  gamepadList: document.querySelector("#gamepadList"),
  activateGamepad: document.querySelector("#activateGamepad"),
  controllerSelect: document.querySelector("#controllerSelect"),
  armButton: document.querySelector("#armButton"),
  stopButton: document.querySelector("#stopButton"),
  speedRange: document.querySelector("#speedRange"),
  speedValue: document.querySelector("#speedValue"),
  strafeRange: document.querySelector("#strafeRange"),
  strafeValue: document.querySelector("#strafeValue"),
  turnRange: document.querySelector("#turnRange"),
  turnValue: document.querySelector("#turnValue"),
  frameAge: document.querySelector("#frameAge"),
  commandLatency: document.querySelector("#commandLatency"),
  deadzoneRange: document.querySelector("#deadzoneRange"),
  deadzoneValue: document.querySelector("#deadzoneValue"),
  intervalRange: document.querySelector("#intervalRange"),
  intervalValue: document.querySelector("#intervalValue"),
  axisX: document.querySelector("#axisX"),
  axisY: document.querySelector("#axisY"),
  axisTurn: document.querySelector("#axisTurn"),
  axisAngle: document.querySelector("#axisAngle"),
  robotIp: document.querySelector("#robotIp"),
  videoUrl: document.querySelector("#videoUrl"),
  commandUrl: document.querySelector("#commandUrl"),
  commandMethod: document.querySelector("#commandMethod"),
  bodyTemplate: document.querySelector("#bodyTemplate"),
  protocolMode: document.querySelector("#protocolMode"),
  rosHost: document.querySelector("#rosHost"),
  localHost: document.querySelector("#localHost"),
  simulationToggle: document.querySelector("#simulationToggle"),
  sendState: document.querySelector("#sendState"),
  saveSettings: document.querySelector("#saveSettings"),
  connectRos: document.querySelector("#connectRos"),
  log: document.querySelector("#log"),
  videoElement: document.querySelector("#videoElement"),
  mjpegElement: document.querySelector("#mjpegElement"),
  videoFrame: document.querySelector("#videoFrame"),
  videoMessage: document.querySelector("#videoMessage"),
  videoState: document.querySelector("#videoState"),
  reloadVideo: document.querySelector("#reloadVideo"),
  startProxy: document.querySelector("#startProxy")
};

const actionVectors = {
  forward: { x: 0, y: -1, turn: 0 },
  back: { x: 0, y: 1, turn: 0 },
  left: { x: -1, y: 0, turn: 0 },
  right: { x: 1, y: 0, turn: 0 },
  turnLeft: { x: 0, y: 0, turn: -1 },
  turnRight: { x: 0, y: 0, turn: 1 },
  stop: { x: 0, y: 0, turn: 0 }
};

function log(message, detail = "") {
  const line = document.createElement("div");
  line.className = "log-entry";
  const suffix = detail ? ` | ${detail}` : "";
  line.textContent = `${new Date().toLocaleTimeString()} - ${message}${suffix}`;
  elements.log.prepend(line);
  while (elements.log.children.length > 40) elements.log.lastElementChild.remove();
}

function getSettings() {
  return {
    robotIp: elements.robotIp.value.trim() || "192.168.0.142",
    videoUrl: elements.videoUrl.value.trim(),
    urlTemplate: elements.commandUrl.value.trim(),
    method: elements.commandMethod.value,
    bodyTemplate: elements.bodyTemplate.value,
    protocol: elements.protocolMode.value,
    rosHost: elements.rosHost.value.trim(),
    localHost: elements.localHost.value.trim(),
    simulation: elements.simulationToggle.checked,
    speed: Number(elements.speedRange.value),
    strafeSpeed: Number(elements.strafeRange.value),
    turnSpeed: Number(elements.turnRange.value),
    deadzone: Number(elements.deadzoneRange.value),
    interval: Number(elements.intervalRange.value)
  };
}

function saveSettings() {
  localStorage.setItem("scout-control-settings", JSON.stringify(getSettings()));
  updateLabels();
  log("Reglages sauvegardes");
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("scout-control-settings") || "{}"); } catch { /* Ignore corrupt saved settings. */ }
  if (saved.robotIp) elements.robotIp.value = saved.robotIp;
  if (saved.videoUrl) elements.videoUrl.value = saved.videoUrl;
  if (saved.urlTemplate) elements.commandUrl.value = saved.urlTemplate;
  if (saved.method) elements.commandMethod.value = saved.method;
  if (saved.bodyTemplate) elements.bodyTemplate.value = saved.bodyTemplate;
  if (saved.protocol) elements.protocolMode.value = saved.protocol;
  if (saved.rosHost) elements.rosHost.value = saved.rosHost;
  if (saved.localHost) elements.localHost.value = saved.localHost;
  elements.simulationToggle.checked = false;
  if (saved.speed) elements.speedRange.value = saved.speed;
  if (saved.strafeSpeed) elements.strafeRange.value = saved.strafeSpeed;
  if (saved.turnSpeed) elements.turnRange.value = saved.turnSpeed;
  if (saved.deadzone !== undefined) elements.deadzoneRange.value = saved.deadzone;
  if (saved.interval) elements.intervalRange.value = Math.min(Number(saved.interval), 50);
  updateLabels();
}

function updateLabels() {
  const settings = getSettings();
  elements.connectionText.textContent = `Robot: ${settings.robotIp}`;
  elements.speedValue.textContent = `${Math.round(settings.speed * 100)}%`;
  elements.strafeValue.textContent = `${Math.round(settings.strafeSpeed * 100)}%`;
  elements.turnValue.textContent = `${Math.round(settings.turnSpeed * 100)}%`;
  elements.deadzoneValue.textContent = settings.deadzone.toFixed(2);
  elements.intervalValue.textContent = `${settings.interval} ms`;
  elements.sendState.textContent = settings.simulation ? "Simulation active" : "Envoi actif";
  elements.sendState.classList.toggle("muted", settings.simulation);
  if (!elements.rosHost.value.trim()) elements.rosHost.value = `${settings.robotIp}:11311`;
}

function setArmed(next, { sendStop = true, writeLog = true } = {}) {
  if (!next) {
    state.armGeneration++;
    state.armPending = false;
  }
  state.armed = Boolean(next);
  if (state.armed) state.awaitingNeutral = true;
  elements.armButton.textContent = state.armed ? "Desarmer" : "Armer";
  elements.armButton.classList.toggle("armed", state.armed);
  sessionStorage.setItem("scout-control-armed", state.armed ? "true" : "false");
  if (writeLog) log(state.armed ? "Controle arme" : "Controle desarme");
  if (!state.armed && sendStop) sendCommand("stop", { x: 0, y: 0, turn: 0 }, true);
}

function setSpeedByStep(step) {
  const next = clamp(Number(elements.speedRange.value) + step);
  elements.speedRange.value = Math.max(Number(elements.speedRange.min), Math.min(Number(elements.speedRange.max), next)).toFixed(2);
  updateLabels();
  log("Vitesse", `${Math.round(Number(elements.speedRange.value) * 100)}%`);
}

function commandLabel(action) {
  const labels = {
    undock: "sortir / annuler retour base",
    dock: "retour base",
    cancelDock: "annuler retour base",
    photo: "photo",
    recordStart: "demarrer l'enregistrement",
    recordStop: "arreter l'enregistrement",
    lightLow: "vision nuit -",
    lightHigh: "vision nuit +",
    stop: "stop",
    drive: "pilotage"
  };
  return labels[action] || action;
}

function applyDeadzone(value, deadzone) {
  if (Math.abs(value) < deadzone) return 0;
  const sign = Math.sign(value);
  return sign * ((Math.abs(value) - deadzone) / (1 - deadzone));
}

function buttonPressed(button) {
  return Boolean(button?.pressed || button?.value > 0.55);
}

function onButtonPress(pad, index, action) {
  const key = `${pad.index}:${index}`;
  const pressed = buttonPressed(pad.buttons[index]);
  if (pressed && !state.buttonLatch.has(key)) {
    state.buttonLatch.add(key);
    action();
  } else if (!pressed) {
    state.buttonLatch.delete(key);
  }
}

function latchPressedButtons(pad) {
  if (!pad) return;
  pad.buttons.forEach((button, index) => {
    if (buttonPressed(button)) state.buttonLatch.add(`${pad.index}:${index}`);
  });
}

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function computeAngle(x, y) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < 0.001) return 0;
  return Math.round((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
}

function setGamepadStatus(text, detail, active = false) {
  elements.gamepadBadge.textContent = text;
  elements.gamepadBadge.classList.toggle("muted", !active);
  elements.gamepadList.textContent = detail;
}

async function requestArm() {
  if (state.armed) return true;
  if (state.suspended || document.hidden) return false;
  if (state.armPending) return state.armPromise;
  const generation = ++state.armGeneration;
  state.armPending = true;
  elements.armButton.textContent = "Connexion ROS...";
  state.armPromise = (async () => {
    const settings = getSettings();
    const ready = settings.simulation || settings.protocol !== "ros" || await connectRos({ reconnect: false });
    if (generation !== state.armGeneration || state.suspended || document.hidden) return false;
    state.armPending = false;
    if (ready) setArmed(true);
    else {
      setArmed(false);
      log("Armement impossible", "Connexion ROS indisponible");
    }
    return Boolean(ready);
  })();
  return state.armPromise;
}

function toggleArmed() {
  if (state.armed || state.armPending) setArmed(false);
  else requestArm();
}

function clearControllerInput() {
  state.nativeGamepad = null;
  state.gamepadIndex = null;
  state.lastGamepadId = "";
  state.autoInputActive = false;
  suspendInputs(state.suspended);
  setArmed(false, { sendStop: false, writeLog: false });
}

window.scoutNativeControllerChanged = clearControllerInput;

window.scoutNativeControllersUpdate = (devices = [], selection = {}) => {
  state.android = true;
  state.nativeControllers = devices;
  state.controllerChoice = selection.mode === "manual" ? String(selection.selectedId ?? "missing") : "auto";
  renderControllerOptions();
};

function renderControllerOptions() {
  const options = [{ value: "auto", label: "Automatique" }];
  if (state.android) {
    for (const device of state.nativeControllers) {
      const kind = device.virtual ? "virtuel" : device.analog ? "analogique" : "boutons";
      options.push({ value: String(device.id), label: `${device.name} (#${device.id}, ${kind})` });
    }
  } else {
    for (const pad of getRawGamepads()) {
      if (pad.connected !== false) options.push({ value: String(pad.index), label: `${pad.id} (#${pad.index})` });
    }
  }
  if (!options.some((option) => option.value === state.controllerChoice)) {
    options.push({ value: state.controllerChoice, label: "Manette choisie absente" });
  }
  const key = JSON.stringify(options);
  if (state.controllerOptionsKey !== key) {
    const nodes = options.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    });
    elements.controllerSelect.replaceChildren(...nodes);
    state.controllerOptionsKey = key;
  }
  elements.controllerSelect.value = state.controllerChoice;
}

function selectGamepad(value) {
  clearControllerInput();
  state.controllerChoice = value;
  if (state.android) {
    window.ScoutInput?.select(value);
  } else {
    state.gamepadIndex = value === "auto" ? null : Number(value);
    latchPressedButtons(pickGamepad());
  }
  renderControllerOptions();
  log("Manette choisie", elements.controllerSelect.selectedOptions[0]?.textContent || value);
}

window.scoutNativeGamepadUpdate = (axes = [], pressedButtons = [], connected = true, id = "Manette Android", deviceId = null) => {
  state.android = true;
  if (connected && state.controllerChoice !== "auto" && String(deviceId) !== state.controllerChoice) return;
  if (!connected) {
    state.nativeGamepad = null;
    state.gamepadIndex = null;
    state.lastGamepadId = "";
    state.buttonLatch.clear();
    suspendInputs(false);
    setGamepadStatus("Manette absente", "Aucune manette connectee.", false);
    return;
  }
  const buttons = Array.from({ length: 16 }, (_, index) => ({
    pressed: Boolean(pressedButtons[index]),
    value: pressedButtons[index] ? 1 : 0
  }));
  if (state.nativeGamepad && state.nativeGamepad.deviceId !== deviceId) clearControllerInput();
  state.nativeGamepad = {
    id,
    deviceId,
    index: 99,
    connected: true,
    axes: [Number(axes[0] || 0), Number(axes[1] || 0), Number(axes[2] || 0), Number(axes[3] || 0)],
    buttons
  };
  rememberGamepad(state.nativeGamepad);
};

window.scoutNativeButton = (index, deviceId = null) => {
  if (deviceId !== state.nativeGamepad?.deviceId) return;
  if (state.controllerMenuOpen) return;
  if (!state.suspended && !document.hidden) handleGamepadButton(index);
};

window.scoutNativeInput = (deviceId) => {
  if (!state.controllerMenuOpen && state.nativeGamepad?.deviceId === deviceId) requestArm();
};

window.scoutNativeLifecycle = (resumed) => {
  suspendInputs(!resumed);
  if (!resumed) window.scoutSoundboard?.suspend();
  if (resumed && state.videoEnabled) loadVideo();
};

function suspendInputs(suspended) {
  if (state.armPending) setArmed(false, { sendStop: false, writeLog: false });
  state.suspended = suspended;
  state.awaitingNeutral = true;
  state.keys.clear();
  state.keyActionLatch.clear();
  state.buttonLatch.clear();
  state.manualVector = null;
  state.lastVector = actionVectors.stop;
  if (state.nativeGamepad) {
    state.nativeGamepad.axes.fill(0);
    state.nativeGamepad.buttons.forEach((button) => { button.pressed = false; button.value = 0; });
  }
  sendCommand("stop", actionVectors.stop, true);
}

function getRawGamepads() {
  const nativePads = state.nativeGamepad ? [state.nativeGamepad] : [];
  if (state.android) return nativePads;
  if (!navigator.getGamepads) {
    if (!state.gamepadApiWarned) {
      state.gamepadApiWarned = true;
      log("Gamepad API absente", "essaie Chrome/Edge sur http://127.0.0.1:5173");
    }
    return nativePads;
  }
  return [...nativePads, ...Array.from(navigator.getGamepads()).filter(Boolean)];
}

function rememberGamepad(pad) {
  if (!pad) return;
  state.gamepadIndex = pad.index;
  state.gamepadSeenAt = Date.now();
  state.lastGamepadId = pad.id || `Manette ${pad.index}`;
}

function pickGamepad() {
  const pads = getRawGamepads();
  if (!state.android && state.controllerChoice !== "auto") {
    const selected = pads.find((pad) => String(pad.index) === state.controllerChoice && pad.connected !== false);
    if (selected) rememberGamepad(selected);
    return selected || null;
  }
  const preferred = Number.isInteger(state.gamepadIndex) ? pads.find((pad) => pad?.index === state.gamepadIndex) : null;
  const firstConnected = pads.find((pad) => pad && pad.connected !== false);
  const pad = preferred && preferred.connected !== false ? preferred : firstConnected;
  if (pad) rememberGamepad(pad);
  return pad || null;
}

function activateGamepad() {
  window.focus();
  if (state.android) {
    if (state.controllerChoice === "auto") selectGamepad("auto");
    window.ScoutInput?.refresh();
    renderControllerOptions();
    return;
  }
  renderControllerOptions();
  const pad = pickGamepad();
  if (pad) {
    setGamepadStatus("Manette active", `${pad.id}\nA sortie/annule | B base | Start armer | L1 video | R1 plein ecran`, true);
    log("Manette active", pad.id);
    return;
  }
  const detail = state.lastGamepadId
    ? `${state.lastGamepadId}\nDetection recue, mais les axes ne sont pas exposes. Clique dans la page puis appuie sur A.`
    : "Clique dans la page, puis appuie sur un bouton de la manette.";
  setGamepadStatus(state.lastGamepadId ? "Manette detectee" : "Manette absente", detail, false);
  log("Manette non lisible", "clique dans la page puis appuie sur un bouton");
}

function renderVector(vector) {
  elements.axisX.textContent = vector.x.toFixed(2);
  elements.axisY.textContent = vector.y.toFixed(2);
  elements.axisTurn.textContent = vector.turn.toFixed(2);
  elements.axisAngle.textContent = `${computeAngle(vector.x, vector.y)} deg`;
}

async function sendCommand(action, vector = state.lastVector, force = false) {
  if (action === "undock" && state.returnRequested) action = "cancelDock";
  if (action === "cancelDock") vector = actionVectors.stop;
  const settings = getSettings();
  const scaled = {
    x: clamp(vector.x) * settings.strafeSpeed,
    y: clamp(vector.y) * settings.speed,
    turn: clamp(vector.turn) * settings.turnSpeed
  };
  renderVector(scaled);

  const isIdleDrive = action === "drive" && Math.hypot(scaled.x, scaled.y, scaled.turn) < 0.01;
  if (isIdleDrive && state.idleSent && !force) return;

  if (action !== "stop" && (state.suspended || document.hidden)) return;
  if (action === "drive" && (state.navigationBusy || state.returnRequested)) return;

  if (!state.armed && action !== "stop" && !settings.simulation) {
    if (force || action !== "drive") {
      log("Commande bloquee", "clique sur Armer avant l'envoi reel");
    }
    return;
  }

  if (!force && !isIdleDrive) {
    const now = performance.now();
    if (now - state.lastSendAt < settings.interval) return;
    state.lastSendAt = now;
  }

  state.idleSent = isIdleDrive || action === "stop";
  if (isIdleDrive) action = "stop";

  const payload = {
    ...settings,
    clientVersion: CLIENT_VERSION,
    action,
    x: scaled.x,
    y: scaled.y,
    turn: scaled.turn
  };

  if (settings.simulation) {
    if (force || action !== "drive") {
      log("Simulation", `${commandLabel(action)} non envoyee au robot`);
    }
    return;
  }

  queueCommand({ payload, action, force });
}

function queueCommand(command) {
  command.payload.clientId = state.clientId;
  command.payload.commandSeq = ++state.commandSequence;
  if (command.action === "cancelDock") {
    state.pendingDrive = null;
    state.actionQueue.length = 0;
    state.actionQueue.unshift(command);
    state.navigationBusy = true;
    state.idleSent = true;
    state.activeRequest?.abort();
  } else if (command.action === "stop") {
    state.pendingDrive = null;
    state.actionQueue.length = 0;
    state.actionQueue.unshift(command);
    state.activeRequest?.abort();
  } else if (command.action === "drive") {
    state.pendingDrive = command;
  } else {
    state.pendingDrive = null;
    if (command.action === "dock" || command.action === "undock") {
      state.navigationBusy = true;
      state.idleSent = true;
    }
    if (command.action === "dock") state.returnRequested = true;
    state.actionQueue.push(command);
  }
  flushCommandQueue();
}

async function flushCommandQueue() {
  if (state.commandInFlight) return;

  const command = state.actionQueue.shift() || state.pendingDrive;
  if (!command) return;
  if (command === state.pendingDrive) state.pendingDrive = null;
  state.commandInFlight = true;
  const abort = new AbortController();
  state.activeRequest = abort;
  const startedAt = performance.now();
  const timeout = setTimeout(() => abort.abort(), command.action === "drive" || command.action === "stop" ? 1200 : 5000);

  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.payload),
      signal: abort.signal
    });
    const data = await response.json();
    state.commandLatencyMs = Math.round(performance.now() - startedAt);
    elements.commandLatency.textContent = `${state.commandLatencyMs} ms`;
    const mode = data.simulated ? "simulation" : `${data.protocol === "ros" ? "ROS" : "HTTP"} ${data.responseStatus}`;
    if (data.ok && !data.simulated && command.payload.commandSeq === state.commandSequence) {
      if (data.feedback === "dock") state.returnRequested = true;
      if (data.feedback === "cancelDock") {
        state.returnRequested = false;
        state.cancellationUncertain = false;
      }
      playNavigationFeedback(data.feedback);
    }
    if (data.ok && (command.force || command.action !== "drive")) {
      log("Commande envoyee", `${commandLabel(command.action)} | ${mode}`);
    } else if (!data.ok) {
      if (command.action === "cancelDock") state.cancellationUncertain = true;
      const detail = data.responseText || data.error || mode;
      log("Commande refusee", detail);
    }
  } catch (error) {
    if (command.action === "cancelDock") state.cancellationUncertain = true;
    if (error.name !== "AbortError" || !["stop", "cancelDock"].includes(state.actionQueue[0]?.action)) {
      log("Erreur commande", error.name === "AbortError" ? "Delai depasse" : error.message);
    }
    if (command.action === "drive") state.idleSent = false;
  } finally {
    clearTimeout(timeout);
    state.activeRequest = null;
    state.commandInFlight = false;
    state.navigationBusy = state.actionQueue.some((item) => ["dock", "undock", "cancelDock"].includes(item.action));
    if (state.actionQueue.length || state.pendingDrive) flushCommandQueue();
  }
}

function getKeyboardVector() {
  const x = (state.keys.has("ArrowRight") ? 1 : 0) - (state.keys.has("ArrowLeft") ? 1 : 0);
  const y = (state.keys.has("ArrowDown") ? 1 : 0) - (state.keys.has("ArrowUp") ? 1 : 0);
  const turn = (state.keys.has("KeyS") ? 1 : 0) - (state.keys.has("KeyQ") ? 1 : 0);
  return { x: clamp(x), y: clamp(y), turn: clamp(turn) };
}

function readGamepadVector() {
  const pad = pickGamepad();
  if (!pad) {
    if (state.lastGamepadId && Date.now() - state.gamepadSeenAt < 60000) {
      setGamepadStatus("Manette detectee", `${state.lastGamepadId}\nClique dans la page puis appuie sur un bouton pour liberer les axes.`, false);
      return null;
    }
    state.gamepadIndex = null;
    setGamepadStatus("Manette absente", state.controllerChoice !== "auto" ? "Manette choisie absente." :
      state.android && state.nativeControllers.length ? "En attente d'entree manette." : "Aucune manette connectee.", false);
    return null;
  }

  setGamepadStatus("Manette active", `${pad.id}\nA sortie/annule | B base | Start armer | L1 video | R1 plein ecran`, true);

  const settings = getSettings();
  const leftX = applyDeadzone(pad.axes[0] || 0, settings.deadzone);
  const leftY = applyDeadzone(pad.axes[1] || 0, settings.deadzone);
  const rightX = applyDeadzone(pad.axes[2] || 0, settings.deadzone);
  const active = Math.hypot(leftX, leftY, rightX) > 0.05;
  if (active && !state.autoInputActive && !state.controllerMenuOpen) requestArm();
  state.autoInputActive = active;

  if (pad.index !== 99 && !state.controllerMenuOpen) {
    pad.buttons.forEach((_, index) => onButtonPress(pad, index, () => handleGamepadButton(index)));
  }

  return { x: rightX, y: leftY, turn: leftX };
}

function unlockFeedbackAudio() {
  if (window.ScoutInput?.feedback) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    state.audioContext ||= new AudioContext();
    state.audioContext.resume().catch(() => {});
  } catch { /* Audio may be disabled by the browser. */ }
}

function playNavigationFeedback(event) {
  if (!["dock", "cancelDock"].includes(event)) return;
  if (window.ScoutInput?.feedback) { window.ScoutInput.feedback(event); return; }
  unlockFeedbackAudio();
  const audio = state.audioContext;
  if (!audio || audio.state !== "running") return;
  const notes = event === "dock" ? [440, 660, 880] : [880, 660, 440];
  notes.forEach((frequency, index) => {
    const start = audio.currentTime + index * 0.13;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  });
}

function handleGamepadButton(index) {
  if (index === 9) { toggleArmed(); return; }
  if (index === 4) toggleVideo();
  if (index === 5) toggleVideoFullscreen();
  const action = () => {
    if (index === 0) sendCommand("undock", { x: 0, y: -1, turn: 0 }, true);
    if (index === 1) sendCommand("dock", actionVectors.stop, true);
  };
  if (state.armed && !state.suspended && !document.hidden) action();
  else requestArm().then((ready) => { if (ready && state.armed) action(); });
}

async function refreshRosStatus() {
  if (state.statusInFlight || state.suspended || document.hidden) return;
  state.statusInFlight = true;
  let status;
  try {
    status = await fetchJSON("/api/ros/status", {}, 2000);
  } catch {
    if (!state.backendLost) { state.backendLost = true; suspendInputs(false); }
    elements.rosLinkBadge.textContent = "Connexion indisponible";
    elements.rosLinkBadge.classList.add("muted");
    return;
  } finally {
    state.statusInFlight = false;
  }
  const network = status?.network;
  const ros = status?.ros;
  const bridge = status?.bridge;
  const docking = ros?.docking ?? bridge?.status?.docking;
  if (!state.navigationBusy && typeof docking === "boolean" && (docking || !state.cancellationUncertain)) state.returnRequested = docking;
  const frameAge = ros?.lastFrameAt ? Math.max(0, Date.now() - ros.lastFrameAt) : null;
  elements.frameAge.textContent = frameAge === null ? "--" : `${(frameAge / 1000).toFixed(1)} s`;
  if (state.videoEnabled && getSettings().videoUrl.includes("/api/ros/camera.mjpg")) {
    const stale = frameAge === null || frameAge > 5000;
    if (stale) {
      elements.videoState.textContent = "Reconnexion video";
      if (Date.now() - state.videoStartedAt > 5000 && Date.now() >= state.videoRetryAt) {
        state.videoRetryCount++;
        state.videoRetryAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(state.videoRetryCount, 4));
        loadVideo();
      }
    } else {
      elements.videoState.textContent = "Video en direct";
      state.videoRetryCount = 0;
      state.videoRetryAt = 0;
    }
  }
  if (network?.rosMaster && !network.rosMaster.ok) {
    if (!state.backendLost) { state.backendLost = true; suspendInputs(false); }
    elements.rosLinkBadge.textContent = "Robot ROS timeout";
    elements.rosLinkBadge.classList.add("muted");
    return;
  }
  if (bridge?.running) {
    state.backendLost = false;
    elements.rosLinkBadge.textContent = "ROS commande OK";
    elements.rosLinkBadge.classList.remove("muted");
    return;
  }
  if (!ros?.connected) {
    elements.rosLinkBadge.textContent = "ROS commande absent";
    elements.rosLinkBadge.classList.add("muted");
    return;
  }
  if (ros.cmdSubscribers > 0) {
    elements.rosLinkBadge.textContent = "ROS commande OK";
    elements.rosLinkBadge.classList.remove("muted");
    return;
  }
  elements.rosLinkBadge.textContent = ros.lastRequestTopicAt ? "ROS /cmd_vel attente" : "ROS connecte";
  elements.rosLinkBadge.classList.add("muted");
}

async function fetchJSON(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function controlLoop() {
  if (state.suspended || document.hidden) {
    requestAnimationFrame(controlLoop);
    return;
  }
  const keyboard = getKeyboardVector();
  const gamepad = readGamepadVector();
  const activeVector = state.manualVector || (gamepad && (Math.hypot(gamepad.x, gamepad.y, gamepad.turn) > 0.01) ? gamepad : keyboard);
  if (state.awaitingNeutral) {
    if (Math.hypot(activeVector.x, activeVector.y, activeVector.turn) < 0.01) state.awaitingNeutral = false;
    requestAnimationFrame(controlLoop);
    return;
  }
  state.lastVector = activeVector;
  sendCommand("drive", activeVector);
  requestAnimationFrame(controlLoop);
}

function resetVideoDisplay() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  elements.videoElement.pause();
  elements.videoElement.removeAttribute("src");
  elements.videoElement.style.display = "none";
  elements.mjpegElement.removeAttribute("src");
  elements.mjpegElement.style.display = "none";
  elements.videoMessage.style.display = "block";
}

function loadVideo(url = getSettings().videoUrl) {
  state.videoEnabled = true;
  state.videoStartedAt = Date.now();
  resetVideoDisplay();
  elements.videoState.textContent = "Chargement";

  if (!url) {
    elements.videoMessage.textContent = "Aucune URL video configuree.";
    elements.videoState.textContent = "Sans flux";
    return;
  }

  if (/^rtsp:\/\//i.test(url)) {
    elements.videoMessage.textContent = "Le navigateur ne lit pas RTSP directement. Clique sur Proxy RTSP pour convertir le flux en HLS local.";
    elements.videoState.textContent = "RTSP direct indisponible";
    return;
  }

  if (/\.m3u8($|\?)/i.test(url)) {
    elements.videoElement.style.display = "block";
    elements.videoMessage.style.display = "none";
    if (window.Hls?.isSupported()) {
      state.hls = new window.Hls({ lowLatencyMode: true });
      state.hls.loadSource(url);
      state.hls.attachMedia(elements.videoElement);
    } else {
      elements.videoElement.src = url;
    }
    elements.videoElement.play().catch(() => {});
    elements.videoState.textContent = "HLS";
    return;
  }

  elements.mjpegElement.style.display = "block";
  elements.videoMessage.style.display = "none";
  elements.mjpegElement.src = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  elements.videoState.textContent = "MJPEG/Image";
}

async function toggleVideo() {
  if (state.videoEnabled) {
    state.videoEnabled = false;
    resetVideoDisplay();
    fetchJSON("/api/video/stop", { method: "POST" }, 1500).catch(() => {});
    elements.videoMessage.textContent = "Video coupee.";
    elements.videoMessage.style.display = "block";
    elements.videoState.textContent = "Off";
    log("Video coupee");
    return;
  }

  state.videoEnabled = true;
  log("Video activee");
  loadVideo();
}

async function toggleVideoFullscreen() {
  try {
    if (elements.videoFrame.classList.contains("local-fullscreen")) {
      elements.videoFrame.classList.remove("local-fullscreen");
      log("Plein ecran quitte");
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      log("Plein ecran quitte");
      return;
    }
    await elements.videoFrame.requestFullscreen();
    log("Video plein ecran");
  } catch (error) {
    elements.videoFrame.classList.add("local-fullscreen");
    log("Video plein ecran", "mode fenetre");
  }
}

async function connectRos({ reconnect = true } = {}) {
  if (state.rosConnectPromise) return state.rosConnectPromise;
  state.rosConnectPromise = performRosConnection(reconnect);
  try { return await state.rosConnectPromise; }
  finally { state.rosConnectPromise = null; }
}

async function performRosConnection(reconnect) {
  const settings = getSettings();
  try {
    elements.connectRos.disabled = true;
    elements.connectRos.textContent = "Connexion...";
    const data = await fetchJSON("/api/ros/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...settings, reconnect })
    }, 5000);
    if (data.cameraUrl) elements.videoUrl.value = data.cameraUrl;
    updateLabels();
    if (state.videoEnabled && data.cameraUrl && reconnect) loadVideo(data.cameraUrl);
    state.backendLost = false;
    log("ROS connecte", data.ros?.masterUri || settings.robotIp);
    return true;
  } catch (error) {
    log("Erreur ROS", error.message);
    return false;
  } finally {
    elements.connectRos.disabled = false;
    elements.connectRos.textContent = "Connecter ROS";
  }
}

async function startRtspProxy() {
  const streamUrl = getSettings().videoUrl;
  try {
    elements.videoState.textContent = "Demarrage proxy";
    const response = await fetch("/api/video/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamUrl })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Proxy impossible");
    log("Proxy RTSP demarre", data.ffmpegPath || streamUrl);
    await waitForHlsReady(data.hlsUrl);
    loadVideo(data.hlsUrl);
  } catch (error) {
    await fetch("/api/video/stop", { method: "POST" }).catch(() => {});
    elements.videoState.textContent = "Erreur proxy";
    elements.videoMessage.textContent = error.message;
    elements.videoMessage.style.display = "block";
    log("Erreur proxy RTSP", error.message);
  }
}

async function waitForHlsReady(hlsUrl) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const status = await fetch("/api/video/status").then((response) => response.json()).catch(() => null);
    if (status?.hlsReady) return;
    if (status && !status.rtspProxyRunning && status.lastFfmpegError) {
      throw new Error(`ffmpeg a quitte: ${status.lastFfmpegError}`);
    }
  }
  throw new Error(`Flux HLS non pret: ${hlsUrl}. Verifie le chemin RTSP du Scout.`);
}

function bindEvents() {
  window.addEventListener("pointerdown", () => {
    unlockFeedbackAudio();
    if (!pickGamepad()) return;
    const pad = pickGamepad();
    setGamepadStatus("Manette active", `${pad.id}\nA sortie/annule | B base | Start armer | L1 video | R1 plein ecran`, true);
  });

  elements.armButton.addEventListener("click", () => {
    toggleArmed();
  });

  elements.stopButton.addEventListener("click", () => {
    if (state.armPending) setArmed(false, { sendStop: false });
    sendCommand("stop", actionVectors.stop, true);
  });
  elements.saveSettings.addEventListener("click", saveSettings);
  elements.connectRos.addEventListener("click", connectRos);
  elements.activateGamepad.addEventListener("click", activateGamepad);
  elements.controllerSelect.addEventListener("change", () => {
    selectGamepad(elements.controllerSelect.value);
    elements.controllerSelect.blur();
    state.controllerMenuOpen = false;
  });
  elements.controllerSelect.addEventListener("focus", () => {
    state.controllerMenuOpen = true;
    suspendInputs(state.suspended);
    setArmed(false, { sendStop: false, writeLog: false });
  });
  elements.controllerSelect.addEventListener("blur", () => {
    state.controllerMenuOpen = false;
    latchPressedButtons(pickGamepad());
    state.awaitingNeutral = true;
  });
  elements.reloadVideo.addEventListener("click", () => loadVideo());
  elements.startProxy.addEventListener("click", startRtspProxy);

  for (const input of [elements.speedRange, elements.strafeRange, elements.turnRange, elements.deadzoneRange, elements.intervalRange, elements.robotIp, elements.videoUrl, elements.commandUrl, elements.commandMethod, elements.bodyTemplate, elements.protocolMode, elements.rosHost, elements.localHost, elements.simulationToggle]) {
    input.addEventListener("input", updateLabels);
    input.addEventListener("change", updateLabels);
  }

  elements.simulationToggle.addEventListener("change", () => {
    log(elements.simulationToggle.checked ? "Simulation activee" : "Envoi reel active", elements.simulationToggle.checked ? "rien ne part au robot" : "pense a cliquer sur Armer");
  });

  document.querySelectorAll("[data-manual]").forEach((button) => {
    const action = button.dataset.manual;
    button.addEventListener("pointerdown", (event) => {
      button.setPointerCapture(event.pointerId);
      state.manualVector = actionVectors[action];
      sendCommand("drive", state.manualVector, true);
    });
    const release = () => {
      state.manualVector = null;
      sendCommand("stop", actionVectors.stop, true);
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => sendCommand(button.dataset.action, { x: 0, y: 0, turn: 0 }, true));
  });

  window.addEventListener("keydown", (event) => {
    unlockFeedbackAudio();
    pickGamepad();
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
      event.preventDefault();
    }

    if (event.code === "Space") {
      if (!state.keyActionLatch.has(event.code)) {
        state.keyActionLatch.add(event.code);
        sendCommand("undock", { x: 0, y: -1, turn: 0 }, true);
      }
      return;
    }

    if (event.code === "KeyB") {
      if (!state.keyActionLatch.has(event.code)) {
        state.keyActionLatch.add(event.code);
        sendCommand("dock", { x: 0, y: 0, turn: 0 }, true);
      }
      return;
    }

    state.keys.add(event.code);
  });

  window.addEventListener("keyup", (event) => {
    state.keys.delete(event.code);
    state.keyActionLatch.delete(event.code);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      suspendInputs(true);
      resetVideoDisplay();
    } else {
      suspendInputs(false);
      latchPressedButtons(pickGamepad());
      if (state.videoEnabled) loadVideo();
    }
  });
  window.addEventListener("blur", () => suspendInputs(true));
  window.addEventListener("focus", () => suspendInputs(false));
  window.addEventListener("pagehide", () => suspendInputs(true));
  document.addEventListener("contextmenu", (event) => { if (state.android) event.preventDefault(); });
  document.addEventListener("selectstart", (event) => {
    if (state.android && !event.target.closest("input, textarea, [contenteditable='true']")) event.preventDefault();
  });
  elements.mjpegElement.addEventListener("error", () => {
    if (!state.videoEnabled) return;
    elements.videoState.textContent = "Reconnexion video";
    elements.videoMessage.textContent = "Connexion video interrompue.";
    elements.videoMessage.style.display = "block";
  });

  window.addEventListener("gamepadconnected", (event) => {
    if (state.android) return;
    renderControllerOptions();
    log("Manette connectee", event.gamepad.id);
  });

  window.addEventListener("gamepaddisconnected", (event) => {
    if (state.android) return;
    if (event.gamepad.index === state.gamepadIndex) clearControllerInput();
    renderControllerOptions();
    log("Manette deconnectee");
  });
}

async function init() {
  const status = await fetchJSON("/api/status", {}, 2000).catch(() => null);
  state.android = Boolean(status?.android || window.scoutAndroid);
  if (status?.defaultRobotIp) {
    elements.robotIp.value = status.defaultRobotIp;
    elements.rosHost.value = `${status.defaultRobotIp}:11311`;
    elements.videoUrl.value = "/api/ros/camera.mjpg";
  }
  loadSettings();
  if (state.android || status?.native) {
    if (state.android) document.body.classList.add("android-console");
    elements.protocolMode.value = "ros";
    elements.videoUrl.value = "/api/ros/camera.mjpg";
    document.querySelectorAll("[data-desktop-only]").forEach((element) => { element.hidden = true; });
    if (state.android) {
      document.querySelector('[data-action="undock"]').textContent = "A Sortir / annuler retour";
      elements.activateGamepad.textContent = "Actualiser manettes";
    }
  }
  bindEvents();
  renderControllerOptions();
  setArmed(false, { sendStop: false, writeLog: false });
  loadVideo();
  controlLoop();
  refreshRosStatus();
  setInterval(refreshRosStatus, 2000);
  log("Interface prete");
}

init();

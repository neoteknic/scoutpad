import { createServer } from "node:http";
import { stat, mkdir, rm } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { RosScoutClient } from "./ros-client.js";

const root = process.cwd();
const publicDir = resolve(root, "public");
const runtimeDir = resolve(root, ".runtime");
const hlsDir = resolve(runtimeDir, "hls");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);
const defaultRobotIp = process.env.SCOUT_IP || "192.168.0.142";
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || "ffmpeg";
const bridgePath = process.env.SCOUT_BRIDGE_PATH || resolve(root, ".runtime", "scout-bridge.exe");
const bridgeListen = process.env.SCOUT_BRIDGE_LISTEN || "127.0.0.1:18114";
const bridgeUrl = `http://${bridgeListen}`;
const minClientVersion = 10;
const rosClient = new RosScoutClient();

let recentCommands = [];
let ffmpegProcess = null;
let bridgeProcess = null;
let bridgeConfigKey = "";
let lastBridgeError = "";
let bridgeFailureCount = 0;
let bridgeRetryAfter = 0;
let currentStreamUrl = "";
let lastFfmpegError = "";
let networkStatusCache = null;
const mjpegClients = new Set();

rosClient.on("frame", (frame) => {
  const chunk = Buffer.concat([
    Buffer.from(`--scoutframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
    frame,
    Buffer.from("\r\n")
  ]);
  for (const client of mjpegClients) client.write(chunk);
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t"
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkTcp(hostname, portNumber, timeoutMs = 700) {
  return new Promise((resolveCheck) => {
    const startedAt = Date.now();
    const socket = new Socket();
    let settled = false;

    const finish = (ok, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveCheck({
        ok,
        latencyMs: Date.now() - startedAt,
        error
      });
    };

    socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.code || error.message));
    socket.connect(portNumber, hostname);
  });
}

async function getNetworkStatus(robotIp = defaultRobotIp) {
  const now = Date.now();
  if (networkStatusCache && networkStatusCache.robotIp === robotIp && now - networkStatusCache.checkedAt < 3000) {
    return networkStatusCache;
  }

  const rosMaster = await checkTcp(robotIp, 11311);
  networkStatusCache = {
    robotIp,
    checkedAt: now,
    rosMaster
  };
  return networkStatusCache;
}

function buildCommandValues(body) {
  const x = numberOrZero(body.x);
  const y = numberOrZero(body.y);
  const turn = numberOrZero(body.turn);
  const speed = numberOrZero(body.speed || 1);
  const magnitude = Math.min(1, Math.hypot(x, y));
  const angle = magnitude > 0.001 ? Math.round((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360 : 0;
  const left = Math.max(-1, Math.min(1, -y + turn));
  const right = Math.max(-1, Math.min(1, -y - turn));

  return {
    ip: body.robotIp || defaultRobotIp,
    action: body.action || "drive",
    x: x.toFixed(3),
    y: y.toFixed(3),
    turn: turn.toFixed(3),
    speed: Number(speed).toFixed(3),
    magnitude: magnitude.toFixed(3),
    angle,
    direction: angle,
    left: left.toFixed(3),
    right: right.toFixed(3),
    timestamp: Date.now()
  };
}

async function relayCommand(body) {
  const action = body.action || "drive";
  if (action !== "stop" && Number(body.clientVersion || 0) < minClientVersion) {
    throw new Error("Interface ancienne: recharge la page avant d'envoyer des commandes.");
  }

  if ((body.protocol || "ros") === "ros") {
    return relayRosCommand(body);
  }

  const values = buildCommandValues(body);
  const method = String(body.method || "POST").toUpperCase();
  const urlTemplate = body.urlTemplate || "http://{ip}/api/drive";
  const bodyTemplate = body.bodyTemplate || "{\"x\":{x},\"y\":{y},\"turn\":{turn},\"speed\":{speed},\"action\":\"{action}\"}";
  const timeoutMs = Math.max(250, Math.min(5000, Number(body.timeoutMs || 900)));
  const url = renderTemplate(urlTemplate, values);
  const payload = renderTemplate(bodyTemplate, values);
  const headers = { "content-type": "application/json" };

  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Endpoint invalide: l'URL doit commencer par http:// ou https://");
  }

  const command = { at: new Date().toISOString(), method, url, values };
  recentCommands = [command, ...recentCommands].slice(0, 30);

  if (body.simulation) {
    return { ok: true, simulated: true, command, responseStatus: 0, responseText: "" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : payload,
      signal: controller.signal
    });
    const responseText = await response.text();
    return {
      ok: response.ok,
      simulated: false,
      command,
      responseStatus: response.status,
      responseText: responseText.slice(0, 500)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function relayRosCommand(body) {
  const values = buildCommandValues(body);
  const command = { at: new Date().toISOString(), method: "ROS", url: `${values.ip}:11311`, values };
  recentCommands = [command, ...recentCommands].slice(0, 30);

  if (body.simulation) {
    return { ok: true, simulated: true, protocol: "ros", command, responseStatus: 0, responseText: "" };
  }

  const network = await getNetworkStatus(values.ip);
  if (!network.rosMaster.ok) {
    throw new Error(`ROS Master inaccessible sur ${values.ip}:11311 (${network.rosMaster.error || "timeout"})`);
  }

  await rosClient.connect({
    robotIp: values.ip,
    rosHost: body.rosHost || `${values.ip}:11311`,
    localHost: body.localHost || "",
    commandTopic: body.commandTopic || "/cmd_vel",
    enableCommandPublisher: false
  });

  await ensureBridge({
    rosHost: body.rosHost || `${values.ip}:11311`,
    localHost: body.localHost || rosClient.status().localHost,
    commandTopic: body.commandTopic || "/cmd_vel"
  });

  if (values.action === "dock") {
    const bridge = await sendBridgeCommand({ action: "dock" });
    return { ok: true, simulated: false, protocol: "ros", command, responseStatus: 200, responseText: bridge.action || "nav_low_bat", feedback: bridge.feedback };
  }

  if (["undock", "cancelDock"].includes(values.action)) {
    const bridge = await sendBridgeCommand({ action: values.action, y: Math.max(0.3, Math.min(1, Number(body.speed || 0.45))) });
    return { ok: true, simulated: false, protocol: "ros", command, responseStatus: 200, responseText: bridge.action, feedback: bridge.feedback };
  }

  if (values.action === "lightLow") {
    const bridge = await sendBridgeCommand({ action: "lightLow" });
    return { ok: true, simulated: false, protocol: "ros", command, responseStatus: 200, responseText: bridge.action || "adjust_light 0" };
  }

  if (values.action === "lightHigh") {
    const bridge = await sendBridgeCommand({ action: "lightHigh" });
    return { ok: true, simulated: false, protocol: "ros", command, responseStatus: 200, responseText: bridge.action || "adjust_light 1" };
  }

  if (["photo", "recordStart", "recordStop"].includes(values.action)) {
    return { ok: false, simulated: false, protocol: "ros", command, responseStatus: 501, responseText: `Action ROS non implementee par go-scout: ${values.action}` };
  }

  const bridge = await sendBridgeCommand({
    action: values.action === "stop" ? "stop" : "drive",
    x: Number(values.x),
    y: -Number(values.y),
    turn: Number(values.turn)
  });
  return { ok: true, simulated: false, protocol: "ros", command, responseStatus: 200, responseText: `bridge ${bridge.action || values.action}` };
}

function stopBridge() {
  if (bridgeProcess) {
    bridgeProcess.kill("SIGTERM");
    bridgeProcess = null;
  }
  bridgeConfigKey = "";
}

async function ensureBridge({ rosHost, localHost, commandTopic }) {
  const configKey = `${rosHost}|${localHost}|${commandTopic}`;
  if (bridgeProcess && bridgeConfigKey === configKey) {
    return { ok: true, reused: true };
  }

  const now = Date.now();
  if (bridgeRetryAfter > now) {
    const waitMs = bridgeRetryAfter - now;
    throw new Error(`Bridge ROS en pause ${Math.ceil(waitMs / 1000)}s apres echec: ${lastBridgeError || "ROS Master ne repond pas"}`);
  }

  if (!existsSync(bridgePath)) {
    throw new Error(`Bridge ROS introuvable: ${bridgePath}. Lance le build du dossier bridge.`);
  }

  stopBridge();
  lastBridgeError = "";
  bridgeConfigKey = configKey;
  bridgeProcess = spawn(
    bridgePath,
    [
      "-listen", bridgeListen,
      "-master", rosHost,
      "-host", localHost,
      "-topic", commandTopic,
      "-tcpros-port", "18112"
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  bridgeProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) lastBridgeError = "";
  });
  bridgeProcess.stderr.on("data", (chunk) => {
    lastBridgeError = chunk.toString("utf8").trim().slice(-1200);
  });
  bridgeProcess.on("exit", (code) => {
    lastBridgeError = lastBridgeError || `Bridge arrete: code ${code}`;
    bridgeProcess = null;
    bridgeConfigKey = "";
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(150);
    const status = await fetch(`${bridgeUrl}/status`).then((response) => response.json()).catch(() => null);
    if (status?.ok) {
      bridgeFailureCount = 0;
      bridgeRetryAfter = 0;
      return status;
    }
    if (!bridgeProcess) break;
  }
  bridgeFailureCount += 1;
  const cooldownMs = Math.min(30000, 2500 * bridgeFailureCount);
  bridgeRetryAfter = Date.now() + cooldownMs;
  throw new Error(lastBridgeError || "Bridge ROS non pret");
}

async function sendBridgeCommand(payload) {
  const response = await fetch(`${bridgeUrl}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Bridge ROS HTTP ${response.status}`);
  }
  return data;
}

async function getBridgeStatus() {
  if (!bridgeProcess) {
    return {
      running: false,
      url: bridgeUrl,
      lastError: lastBridgeError,
      retryAfterMs: Math.max(0, bridgeRetryAfter - Date.now()),
      failureCount: bridgeFailureCount
    };
  }
  const status = await fetch(`${bridgeUrl}/status`).then((response) => response.json()).catch(() => null);
  return {
    running: Boolean(status?.ok),
    url: bridgeUrl,
    lastError: lastBridgeError || status?.lastError || "",
    retryAfterMs: Math.max(0, bridgeRetryAfter - Date.now()),
    failureCount: bridgeFailureCount,
    status
  };
}

function safeStaticPath(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(baseDir, clean.replace(/^[/\\]/, ""));
  return filePath.startsWith(baseDir) ? filePath : null;
}

async function serveFile(res, filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const type = mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
  const ext = extname(filePath).toLowerCase();
  const cacheControl = [".html", ".css", ".js", ".m3u8"].includes(ext) ? "no-store" : "public, max-age=3600";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": cacheControl
  });
  createReadStream(filePath).pipe(res);
}

function isFfmpegAvailable() {
  return new Promise((resolveAvailable) => {
    const probe = spawn(ffmpegPath, ["-version"], { windowsHide: true });
    probe.on("error", () => resolveAvailable(false));
    probe.on("exit", (code) => resolveAvailable(code === 0));
  });
}

async function startRtspProxy(streamUrl) {
  if (!streamUrl || !/^rtsp:\/\//i.test(streamUrl)) {
    throw new Error("Le proxy local attend une URL RTSP.");
  }

  if (!(await isFfmpegAvailable())) {
    throw new Error(`ffmpeg est introuvable (${ffmpegPath}). Relance npm install ou utilise un flux MJPEG/HLS HTTP.`);
  }

  stopRtspProxy();
  await mkdir(hlsDir, { recursive: true });
  await rm(hlsDir, { recursive: true, force: true });
  await mkdir(hlsDir, { recursive: true });

  currentStreamUrl = streamUrl;
  lastFfmpegError = "";
  ffmpegProcess = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-rtsp_transport",
      "tcp",
      "-i",
      streamUrl,
      "-an",
      "-c:v",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "4",
      "-hls_flags",
      "delete_segments+append_list+omit_endlist",
      join(hlsDir, "stream.m3u8")
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );

  ffmpegProcess.stderr.on("data", (chunk) => {
    lastFfmpegError = chunk.toString("utf8").trim().slice(-1200);
  });
  ffmpegProcess.on("exit", () => {
    ffmpegProcess = null;
  });

  return { ok: true, hlsUrl: "/hls/stream.m3u8", ffmpegPath };
}

function stopRtspProxy() {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGTERM");
    ffmpegProcess = null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        ok: true,
        defaultRobotIp,
        ffmpegPath,
        ffmpegAvailable: await isFfmpegAvailable(),
        network: await getNetworkStatus(defaultRobotIp),
        ros: rosClient.status(),
        bridge: await getBridgeStatus(),
        recentCommands,
        rtspProxyRunning: Boolean(ffmpegProcess),
        currentStreamUrl,
        lastFfmpegError
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ros/connect") {
      const body = await readBody(req);
      const robotIp = body.robotIp || defaultRobotIp;
      const network = await getNetworkStatus(robotIp);
      if (!network.rosMaster.ok) {
        throw new Error(`ROS Master inaccessible sur ${robotIp}:11311 (${network.rosMaster.error || "timeout"})`);
      }
      const result = await rosClient.connect({
        robotIp,
        rosHost: body.rosHost || `${robotIp}:11311`,
        localHost: body.localHost || "",
        commandTopic: body.commandTopic || "/cmd_vel",
        enableCommandPublisher: false
      });
      sendJson(res, 200, { ok: true, ros: result, bridge: await getBridgeStatus(), cameraUrl: "/api/ros/camera.mjpg" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ros/disconnect") {
      await rosClient.close();
      sendJson(res, 200, { ok: true, ros: rosClient.status() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ros/status") {
      sendJson(res, 200, { ok: true, network: await getNetworkStatus(defaultRobotIp), ros: rosClient.status(), bridge: await getBridgeStatus() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ros/camera.mjpg") {
      if (!rosClient.connected) {
        const network = await getNetworkStatus(defaultRobotIp);
        if (!network.rosMaster.ok) {
          throw new Error(`ROS Master inaccessible sur ${defaultRobotIp}:11311 (${network.rosMaster.error || "timeout"})`);
        }
        await rosClient.connect({ robotIp: defaultRobotIp, rosHost: `${defaultRobotIp}:11311`, enableCommandPublisher: false });
      }
      res.writeHead(200, {
        "content-type": "multipart/x-mixed-replace; boundary=scoutframe",
        "cache-control": "no-store",
        "connection": "close"
      });
      mjpegClients.add(res);
      if (rosClient.lastFrame) {
        res.write(Buffer.concat([
          Buffer.from(`--scoutframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${rosClient.lastFrame.length}\r\n\r\n`),
          rosClient.lastFrame,
          Buffer.from("\r\n")
        ]));
      }
      req.on("close", () => mjpegClients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/video/status") {
      sendJson(res, 200, {
        ok: true,
        ffmpegPath,
        ffmpegAvailable: await isFfmpegAvailable(),
        rtspProxyRunning: Boolean(ffmpegProcess),
        currentStreamUrl,
        lastFfmpegError,
        hlsReady: existsSync(join(hlsDir, "stream.m3u8"))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      const body = await readBody(req);
      const result = await relayCommand(body);
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/video/start") {
      const body = await readBody(req);
      const result = await startRtspProxy(body.streamUrl);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/video/stop") {
      stopRtspProxy();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/hls/")) {
      const filePath = safeStaticPath(hlsDir, url.pathname.replace(/^\/hls/, ""));
      if (filePath && existsSync(filePath)) {
        await serveFile(res, filePath);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/hls.min.js") {
      const vendorPath = resolve(root, "node_modules", "hls.js", "dist", "hls.min.js");
      await serveFile(res, vendorPath);
      return;
    }

    const filePath = safeStaticPath(publicDir, url.pathname === "/" ? "/index.html" : url.pathname);
    if (filePath && existsSync(filePath)) {
      await serveFile(res, filePath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Moorebot Scout control: http://${host}:${port}`);
});

process.on("SIGINT", () => {
  stopRtspProxy();
  stopBridge();
  process.exit(0);
});

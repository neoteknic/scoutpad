import { EventEmitter } from "node:events";
import { createServer, connect as tcpConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const xmlrpc = require("xmlrpc");

const CALLER_ID = "/scout-access";
const TWIST_TYPE = "geometry_msgs/Twist";
const TWIST_MD5 = "9f195f881246fdfa2798d1d3eebca84a";
const TWIST_DEF = "Vector3 linear\nVector3 angular\n================================================================================\nMSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z\n";
const FRAME_TYPE = "roller_eye/Frame";
const XMLRPC_PORT = Number(process.env.ROS_XMLRPC_PORT || 0);
const TCPROS_PORT = Number(process.env.ROS_TCPROS_PORT || 18112);

function chooseLocalHost(robotIp) {
  const prefix = robotIp.split(".").slice(0, 3).join(".");
  const all = Object.values(networkInterfaces()).flat().filter(Boolean);
  const ipv4 = all.filter((item) => item.family === "IPv4" && !item.internal).map((item) => item.address);
  return ipv4.find((address) => address.startsWith(`${prefix}.`)) || ipv4.find((address) => address.startsWith("192.168.")) || ipv4[0] || "127.0.0.1";
}

function parseRosEndpoint(value, fallbackIp = "192.168.0.142") {
  const raw = String(value || "").trim();
  if (!raw) return { host: fallbackIp, port: 11311 };
  const [host, port] = raw.replace(/^https?:\/\//, "").split(":");
  return { host: host || fallbackIp, port: Number(port || 11311) };
}

function xmlrpcClientFromUri(uri, fallbackHost = "") {
  const parsed = new URL(uri);
  const host = /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname === "localhost" ? parsed.hostname : fallbackHost || parsed.hostname;
  return xmlrpc.createClient({
    host,
    port: Number(parsed.port || 80),
    path: parsed.pathname || "/"
  });
}

function tcpTargetFromUri(uri, fallbackHost = "") {
  const parsed = new URL(uri);
  const host = /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname === "localhost" ? parsed.hostname : fallbackHost || parsed.hostname;
  return { host, port: Number(parsed.port) };
}

function callXmlrpc(client, method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout XML-RPC ROS: ${method}`)), timeoutMs);
    client.methodCall(method, params, (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function encodeRosHeader(fields) {
  const chunks = Object.entries(fields).map(([key, value]) => {
    const field = Buffer.from(`${key}=${value}`, "utf8");
    const chunk = Buffer.alloc(4 + field.length);
    chunk.writeUInt32LE(field.length, 0);
    field.copy(chunk, 4);
    return chunk;
  });
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function decodeRosHeader(buffer) {
  const fields = {};
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    const field = buffer.slice(offset, offset + length).toString("utf8");
    offset += length;
    const eq = field.indexOf("=");
    if (eq !== -1) fields[field.slice(0, eq)] = field.slice(eq + 1);
  }
  return fields;
}

function serializeTwist({ linearX = 0, linearY = 0, angularZ = 0 }) {
  const body = Buffer.alloc(48);
  body.writeDoubleLE(linearX, 0);
  body.writeDoubleLE(linearY, 8);
  body.writeDoubleLE(0, 16);
  body.writeDoubleLE(0, 24);
  body.writeDoubleLE(0, 32);
  body.writeDoubleLE(angularZ, 40);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function parseFrameMessage(body) {
  if (body.length < 41) return null;
  let offset = 0;
  offset += 4; // seq
  offset += 8; // stamp
  offset += 4; // session
  const type = body.readInt8(offset);
  offset += 1;
  offset += 4; // oseq
  offset += 16; // par1-par4
  const dataLength = body.readUInt32LE(offset);
  offset += 4;
  if (offset + dataLength > body.length) return null;
  return { type, data: body.slice(offset, offset + dataLength) };
}

function readLengthPrefixed(socket, onMessage) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      const body = pending.slice(4, 4 + length);
      pending = pending.slice(4 + length);
      onMessage(body);
    }
  });
}

function readOneLengthPrefixed(socket) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) return;
      const body = pending.slice(4, 4 + length);
      cleanup();
      resolve(body);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function readServiceResponse(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout reponse service ROS"));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      cleanup();
      resolve(chunk);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

export class RosScoutClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.masterUri = "";
    this.robotHost = "";
    this.localHost = "";
    this.callerApi = "";
    this.masterClient = null;
    this.commandTopic = "/cmd_vel";
    this.xmlrpcServer = null;
    this.publisherServer = null;
    this.publisherSockets = new Set();
    this.publisherConnections = new Set();
    this.subscriberSockets = new Set();
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.lastRequestTopicAt = 0;
    this.lastRequestTopicParams = [];
    this.lastCmdConnectAt = 0;
    this.lastCmdRemote = "";
    this.lastCmdHeader = {};
    this.lastError = "";
  }

  async connect({ robotIp = "192.168.0.142", rosHost = "", localHost = "", commandTopic = "/cmd_vel", enableCommandPublisher = false } = {}) {
    if (this.connected && this.robotHost === robotIp && this.commandTopic === commandTopic) return this.status();
    await this.close();

    const endpoint = parseRosEndpoint(rosHost || `${robotIp}:11311`, robotIp);
    this.robotHost = endpoint.host;
    this.commandTopic = commandTopic || "/cmd_vel";
    this.localHost = localHost || chooseLocalHost(endpoint.host);
    this.masterUri = `http://${endpoint.host}:${endpoint.port}/`;
    this.masterClient = xmlrpc.createClient({ host: endpoint.host, port: endpoint.port, path: "/" });

    await this.startXmlrpcServer();
    if (enableCommandPublisher) {
      await this.startPublisherServer();
      await this.registerPublisher(this.commandTopic, TWIST_TYPE);
      await this.notifyCmdSubscribers();
    }
    this.connected = true;
    try {
      await this.registerSubscriber("/CoreNode/jpg", FRAME_TYPE);
    } catch (err) {
      this.setError(err);
    }
    return this.status();
  }

  async startXmlrpcServer() {
    await new Promise((resolve) => {
      this.xmlrpcServer = xmlrpc.createServer({ host: this.localHost, port: XMLRPC_PORT }, resolve);
    });
    const address = this.xmlrpcServer.httpServer.address();
    this.callerApi = `http://${this.localHost}:${address.port}/`;

    this.xmlrpcServer.on("getBusStats", (error, params, callback) => callback(null, [1, "", []]));
    this.xmlrpcServer.on("getBusInfo", (error, params, callback) => callback(null, [1, "", []]));
    this.xmlrpcServer.on("getMasterUri", (error, params, callback) => callback(null, [1, "", this.masterUri]));
    this.xmlrpcServer.on("getPid", (error, params, callback) => callback(null, [1, "", process.pid]));
    this.xmlrpcServer.on("shutdown", (error, params, callback) => callback(null, [1, "", 0]));
    this.xmlrpcServer.on("publisherUpdate", (error, params, callback) => {
      const topic = params?.[1];
      const publishers = params?.[2] || [];
      if (topic === "/CoreNode/jpg") this.connectFramePublishers(publishers).catch((err) => this.setError(err));
      callback(null, [1, "", 0]);
    });
    this.xmlrpcServer.on("requestTopic", (error, params, callback) => {
      const topic = params?.[1];
      if (topic === this.commandTopic && this.publisherServer) {
        this.lastRequestTopicAt = Date.now();
        this.lastRequestTopicParams = params;
        const port = this.publisherServer.address().port;
        callback(null, [1, `Allocated topic connection on port ${port}`, ["TCPROS", this.localHost, port]]);
      } else {
        callback(null, [0, `unsupported topic ${topic}`, []]);
      }
    });
    this.xmlrpcServer.on("NotFound", () => {});
  }

  async startPublisherServer() {
    this.publisherServer = createServer((socket) => {
      this.publisherConnections.add(socket);
      this.lastCmdConnectAt = Date.now();
      this.lastCmdRemote = `${socket.remoteAddress}:${socket.remotePort}`;
      socket.once("data", (headerPacket) => {
        const headerLength = headerPacket.length >= 4 ? headerPacket.readUInt32LE(0) : 0;
        const header = headerLength > 0 && headerPacket.length >= 4 + headerLength ? decodeRosHeader(headerPacket.slice(4, 4 + headerLength)) : {};
        this.lastCmdHeader = header;
        if (header.topic === "/cmd_vel" || header.type === TWIST_TYPE || header.md5sum === TWIST_MD5 || header.md5sum === "*") {
          this.publisherSockets.add(socket);
        }
        socket.write(encodeRosHeader({
          callerid: CALLER_ID,
          topic: this.commandTopic,
          type: TWIST_TYPE,
          md5sum: TWIST_MD5,
          message_definition: TWIST_DEF,
          latching: "1"
        }));
      });
      socket.on("close", () => {
        this.publisherSockets.delete(socket);
        this.publisherConnections.delete(socket);
      });
      socket.on("error", (err) => this.setError(err));
    });
    await new Promise((resolve, reject) => {
      this.publisherServer.once("error", reject);
      this.publisherServer.listen(TCPROS_PORT, this.localHost, resolve);
    });
  }

  async registerPublisher(topic, type) {
    const result = await callXmlrpc(this.masterClient, "registerPublisher", [CALLER_ID, topic, type, this.callerApi]);
    if (Array.isArray(result?.[2])) return result[2];
    return [];
  }

  async registerSubscriber(topic, type) {
    const result = await callXmlrpc(this.masterClient, "registerSubscriber", [CALLER_ID, topic, type, this.callerApi]);
    const publishers = Array.isArray(result?.[2]) ? result[2] : [];
    await this.connectFramePublishers(publishers);
    return publishers;
  }

  async notifyCmdSubscribers() {
    try {
      const state = await callXmlrpc(this.masterClient, "getSystemState", [CALLER_ID]);
      const subscribers = state?.[2]?.[1]?.find((entry) => entry[0] === this.commandTopic)?.[1] || [];
      await Promise.all(subscribers.map(async (nodeName) => {
        try {
          const lookup = await callXmlrpc(this.masterClient, "lookupNode", [CALLER_ID, nodeName]);
          if (!lookup?.[2]) return;
          const client = xmlrpcClientFromUri(lookup[2], this.robotHost);
          await callXmlrpc(client, "publisherUpdate", [CALLER_ID, this.commandTopic, [this.callerApi]]);
        } catch (err) {
          this.setError(new Error(`publisherUpdate ${nodeName}: ${err.message}`));
        }
      }));
    } catch (err) {
      this.setError(err);
    }
  }

  async connectFramePublishers(publisherApis) {
    for (const api of publisherApis) {
      if (!api || [...this.subscriberSockets].some((socket) => socket.rosPublisherApi === api)) continue;
      let protocol = null;
      try {
        const publisherClient = xmlrpcClientFromUri(api, this.robotHost);
        const response = await callXmlrpc(publisherClient, "requestTopic", [CALLER_ID, "/CoreNode/jpg", [["TCPROS"]]]);
        protocol = response?.[2];
      } catch (err) {
        this.setError(new Error(`Camera requestTopic ${api}: ${err.message}`));
        continue;
      }
      if (!Array.isArray(protocol) || protocol[0] !== "TCPROS") continue;
      const socketHost = /^\d+\.\d+\.\d+\.\d+$/.test(protocol[1]) || protocol[1] === "localhost" ? protocol[1] : this.robotHost;
      const socket = tcpConnect({ host: socketHost, port: Number(protocol[2]) });
      socket.rosPublisherApi = api;
      this.subscriberSockets.add(socket);
      socket.on("connect", () => {
        socket.write(encodeRosHeader({
          callerid: CALLER_ID,
          topic: "/CoreNode/jpg",
          type: FRAME_TYPE,
          md5sum: "*"
        }));
      });
      let headerRead = false;
      readLengthPrefixed(socket, (body) => {
        if (!headerRead) {
          decodeRosHeader(body);
          headerRead = true;
          return;
        }
        const frame = parseFrameMessage(body);
        if (frame?.data?.length) {
          this.lastFrame = frame.data;
          this.lastFrameAt = Date.now();
          this.emit("frame", frame.data);
        }
      });
      socket.on("close", () => this.subscriberSockets.delete(socket));
      socket.on("error", (err) => this.setError(err));
    }
  }

  async publishTwist({ x = 0, y = 0, turn = 0 } = {}) {
    const linearX = Number(x) * 0.2;
    const linearY = -Number(y);
    const angularZ = -Number(turn) * 1.8;
    const packet = serializeTwist({ linearX, linearY, angularZ });
    for (const socket of this.publisherSockets) {
      if (!socket.destroyed) socket.write(packet);
    }
    return { linearX, linearY, angularZ, subscribers: this.publisherSockets.size };
  }

  async callService(serviceName, payload = Buffer.alloc(0)) {
    const lookup = await callXmlrpc(this.masterClient, "lookupService", [CALLER_ID, serviceName]);
    const serviceUri = lookup?.[2];
    if (!serviceUri) throw new Error(`Service ROS introuvable: ${serviceName}`);
    const target = tcpTargetFromUri(serviceUri, this.robotHost);
    const socket = tcpConnect(target);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(encodeRosHeader({
      callerid: CALLER_ID,
      service: serviceName,
      md5sum: "*",
      persistent: "0"
    }));
    await readOneLengthPrefixed(socket);
    socket.write(payload);
    const response = await readServiceResponse(socket);
    socket.end();
    if (response[0] !== 1) throw new Error(`Service ROS refuse: ${serviceName}`);
    return true;
  }

  async goHome() {
    await this.callService("/nav_low_bat");
    return { ok: true };
  }

  async adjustLight(cmd) {
    const payload = Buffer.alloc(4);
    payload.writeInt32LE(Number(cmd) || 0, 0);
    await this.callService("/CoreNode/adjust_light", payload);
    return { ok: true, cmd: Number(cmd) || 0 };
  }

  setError(error) {
    this.lastError = error?.message || String(error);
    this.emit("errorState", this.lastError);
  }

  status() {
    return {
      connected: this.connected,
      masterUri: this.masterUri,
      robotHost: this.robotHost,
      commandTopic: this.commandTopic,
      localHost: this.localHost,
      callerApi: this.callerApi,
      xmlrpcPort: this.xmlrpcServer?.httpServer?.address()?.port || 0,
      tcprosPort: this.publisherServer?.address()?.port || 0,
      cmdSubscribers: this.publisherSockets.size,
      cmdConnections: this.publisherConnections.size,
      framePublishers: this.subscriberSockets.size,
      lastFrameAt: this.lastFrameAt,
      lastRequestTopicAt: this.lastRequestTopicAt,
      lastRequestTopicParams: this.lastRequestTopicParams,
      lastCmdConnectAt: this.lastCmdConnectAt,
      lastCmdRemote: this.lastCmdRemote,
      lastCmdHeader: this.lastCmdHeader,
      lastError: this.lastError
    };
  }

  async close() {
    for (const socket of this.publisherSockets) socket.destroy();
    for (const socket of this.publisherConnections) socket.destroy();
    for (const socket of this.subscriberSockets) socket.destroy();
    this.publisherSockets.clear();
    this.publisherConnections.clear();
    this.subscriberSockets.clear();
    if (this.publisherServer) await new Promise((resolve) => this.publisherServer.close(resolve));
    if (this.xmlrpcServer) await new Promise((resolve) => this.xmlrpcServer.close(resolve));
    this.publisherServer = null;
    this.xmlrpcServer = null;
    this.connected = false;
  }
}

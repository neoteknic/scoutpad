import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\binit\(\);\s*$/, "");

function harness({ timeoutImmediately = false } = {}) {
  const requests = [];
  let now = 100;
  const nodes = new Map();
  const values = { speedRange:"0.45", strafeRange:"0.65", turnRange:"0.8", deadzoneRange:"0.12", intervalRange:"50", robotIp:"127.0.0.1", protocolMode:"ros" };
  const events = new Map();
  const getNode = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: values[selector.slice(1)] || "", checked: false, textContent: "", children: [],
      classList: { toggle(){}, add(){}, remove(){}, contains(){return false;} },
      prepend(){}, style:{}, pause(){}, removeAttribute(){}, addEventListener(){},
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { hidden:false, querySelector:getNode, querySelectorAll:()=>[], createElement:()=>({}), addEventListener:(name,fn)=>events.set(name,fn) },
    window: { addEventListener:(name,fn)=>events.set(name,fn), focus(){} },
    navigator: { getGamepads:()=>[] }, performance: { now:()=>now }, Date, Math, Number, Boolean, Array, Set, AbortController,
    sessionStorage:{setItem(){},getItem(){return null;}}, localStorage:{getItem(){return null;}}, requestAnimationFrame(){},
    setTimeout: timeoutImmediately ? (fn)=>setTimeout(fn, 0) : setTimeout, clearTimeout,
    fetch: (url, options) => new Promise((resolve,reject) => {
      const request = {url, payload:JSON.parse(options.body), signal:options.signal,
        resolve:()=>resolve({ok:true,json:async()=>({ok:true,protocol:"ros",responseStatus:200})})};
      requests.push(request);
      options.signal.addEventListener("abort", ()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});
    }),
  });
  vm.runInContext(source,context);
  vm.runInContext("state.armed=true; state.awaitingNeutral=false;",context);
  return { context, requests, events, run:(code)=>vm.runInContext(code,context), time:(value)=>{now=value;}, node:getNode,
    async drain() { for(let i=0;i<10;i++){ requests.find((request)=>!request.resolved && !request.signal.aborted)?.resolve(); requests.forEach((request)=>{request.resolved=true;}); await new Promise(setImmediate); } },
  };
}

test("releasing a stick bypasses throttling and preempts an in-flight drive", async()=>{
  const h=harness();
  h.run('sendCommand("drive",{x:0,y:-1,turn:0})');
  h.time(110);
  h.run('sendCommand("drive",{x:0,y:0,turn:0})');
  await new Promise(setImmediate);
  assert.equal(h.requests[0].signal.aborted,true);
  assert.equal(h.requests[1].payload.action,"stop");
  h.time(180);
  h.run('sendCommand("drive",{x:0,y:0,turn:0})');
  assert.equal(h.requests.length,2);
  await h.drain();
});

test("A and B actions cannot be overwritten by joystick samples", async()=>{
  const h=harness();
  h.run('sendCommand("drive",{x:0,y:-1,turn:0},true); sendCommand("undock",{x:0,y:-1,turn:0},true); sendCommand("dock",{x:0,y:0,turn:0},true);');
  h.time(200);
  h.run('sendCommand("drive",{x:0,y:-0.5,turn:0})');
  await h.drain();
  assert.deepEqual(h.requests.map((request)=>request.payload.action),["drive","undock","dock"]);
});

test("stop discards queued actions and movement", async()=>{
  const h=harness();
  h.run('sendCommand("drive",{x:0,y:-1,turn:0},true); sendCommand("dock",{x:0,y:0,turn:0},true); sendCommand("stop",{x:0,y:0,turn:0},true);');
  await h.drain();
  assert.deepEqual(h.requests.map((request)=>request.payload.action),["drive","stop"]);
  assert.ok(h.requests[1].payload.commandSeq>h.requests[0].payload.commandSeq);
});

test("hung requests release the queue on timeout", async()=>{
  const h=harness({timeoutImmediately:true});
  h.run('sendCommand("drive",{x:0,y:-1,turn:0},true); sendCommand("lightHigh",{x:0,y:0,turn:0},true);');
  await new Promise((resolve)=>setTimeout(resolve,30));
  assert.deepEqual(h.requests.map((request)=>request.payload.action),["drive","lightHigh"]);
  assert.equal(h.run("state.commandInFlight"),false);
});

test("native short taps are preserved independently of animation frames", async()=>{
  const h=harness();
  h.run('window.scoutNativeGamepadUpdate([0,0,0,0],[true],true,"console"); window.scoutNativeButton(0); window.scoutNativeGamepadUpdate([0,0,0,0],[false],true,"console"); controlLoop();');
  assert.equal(h.requests[0].payload.action,"undock");
  await h.drain();
});

test("native controller removal reports disconnected and stops", async()=>{
  const h=harness();
  h.run('window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"console"); window.scoutNativeGamepadUpdate([],[],false,"");');
  assert.equal(h.run("pickGamepad()"),null);
  assert.equal(h.node("#gamepadBadge").textContent,"Manette absente");
  assert.equal(h.requests[0].payload.action,"stop");
  await h.drain();
});

test("suspension clears inputs and resumes only after a neutral sample", async()=>{
  const h=harness();
  h.run('state.keys.add("ArrowUp"); state.manualVector={x:0,y:-1,turn:0}; window.scoutNativeLifecycle(false);');
  assert.equal(h.run("state.keys.size"),0);
  assert.equal(h.run("state.manualVector"),null);
  h.run('window.scoutNativeLifecycle(true); window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"console"); controlLoop();');
  assert.equal(h.run("state.awaitingNeutral"),true);
  h.run('window.scoutNativeGamepadUpdate([0,0,0,0],[],true,"console"); controlLoop();');
  assert.equal(h.run("state.awaitingNeutral"),false);
  await h.drain();
  assert.ok(h.requests.every((request)=>request.payload.action==="stop"));
});

test("advance, translation and rotation speeds are independent", async()=>{
  const h=harness();
  h.run('sendCommand("drive",{x:1,y:-1,turn:1},true)');
  assert.equal(h.requests[0].payload.x,0.65);
  assert.equal(h.requests[0].payload.y,-0.45);
  assert.equal(h.requests[0].payload.turn,0.8);
  await h.drain();
});

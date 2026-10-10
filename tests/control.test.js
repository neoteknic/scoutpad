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
      prepend(){}, style:{}, pause(){}, removeAttribute(){}, addEventListener(){}, selectedOptions:[],
      replaceChildren(...children){this.children=children;},
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
        resolve:(data={ok:true,protocol:"ros",responseStatus:200})=>resolve({ok:data.ok!==false,json:async()=>data})};
      requests.push(request);
      options.signal.addEventListener("abort", ()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});
    }),
  });
  vm.runInContext(source,context);
  vm.runInContext("state.armed=true; state.awaitingNeutral=false;",context);
  return { context, requests, events, run:(code)=>vm.runInContext(code,context), time:(value)=>{now=value;}, node:getNode,
    async drain() { for(let i=0;i<10;i++){ for(const request of requests.filter((request)=>!request.resolved && !request.signal.aborted)){ request.resolve(); request.resolved=true; } await new Promise(setImmediate); } },
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

test("A preempts B and sends cancellation without forward motion", async()=>{
  const h=harness();
  h.run('handleGamepadButton(1); handleGamepadButton(0)');
  await new Promise(setImmediate);
  assert.equal(h.requests[0].payload.action,"dock");
  assert.equal(h.requests[0].signal.aborted,true);
  assert.equal(h.requests[1].payload.action,"cancelDock");
  assert.equal(h.requests[1].payload.y,0);
  await h.drain();
  assert.ok(!h.requests.some((r)=>r.payload.action==="undock"));
});

test("navigation sounds play only after a successful current acknowledgement", async()=>{
  const h=harness();
  const sounds=[];
  h.context.window.ScoutInput={feedback:(event)=>sounds.push(event)};
  h.run('handleGamepadButton(1)');
  assert.deepEqual(sounds,[]);
  h.requests[0].resolve({ok:true,feedback:"dock"}); h.requests[0].resolved=true;
  await new Promise(setImmediate);
  assert.deepEqual(sounds,["dock"]);
  h.run('handleGamepadButton(0)');
  h.requests[1].resolve({ok:true,feedback:"cancelDock"}); h.requests[1].resolved=true;
  await h.drain();
  assert.deepEqual(sounds,["dock","cancelDock"]);
  assert.equal(h.run("state.returnRequested"),false);
  h.run('handleGamepadButton(1)');
  h.requests[2].resolve({ok:false,error:"offline",feedback:"dock"}); h.requests[2].resolved=true;
  await h.drain();
  assert.deepEqual(sounds,["dock","cancelDock"]);
});

test("late dock acknowledgements cannot restore return mode or play a sound", async()=>{
  const h=harness();
  const sounds=[];
  h.context.window.ScoutInput={feedback:(event)=>sounds.push(event)};
  h.run('handleGamepadButton(1)');
  h.requests[0].resolve({ok:true,feedback:"dock"}); h.requests[0].resolved=true;
  h.run('handleGamepadButton(0)');
  await new Promise(setImmediate);
  assert.deepEqual(sounds,[]);
  await h.drain();
});

test("failed cancellation keeps A in cancel mode for a safe retry", async()=>{
  const h=harness();
  h.run('handleGamepadButton(1)');
  await h.drain();
  h.run('handleGamepadButton(0)');
  h.requests[1].resolve({ok:false,error:"partial cancellation"}); h.requests[1].resolved=true;
  await h.drain();
  assert.equal(h.run("state.cancellationUncertain"),true);
  assert.equal(h.run("state.returnRequested"),true);
  h.run('handleGamepadButton(0)');
  assert.equal(h.requests[2].payload.action,"cancelDock");
  h.requests[2].resolve({ok:true,feedback:"cancelDock"}); h.requests[2].resolved=true;
  await h.drain();
  assert.equal(h.run("state.cancellationUncertain"),false);
});

test("manual stick commands cannot interfere with an ongoing return", async()=>{
  const h=harness();
  h.run('handleGamepadButton(1)');
  await h.drain();
  h.run('sendCommand("drive",{x:1,y:-1,turn:1},true); sendCommand("drive",{x:0,y:0,turn:0},true)');
  assert.equal(h.requests.length,1);
  assert.equal(h.run("state.returnRequested"),true);
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

test("native selector lists Android devices instead of just the current pad", ()=>{
  const h=harness();
  h.run('window.scoutNativeControllersUpdate([{id:2,name:"Xbox Wireless Controller",virtual:true},{id:7,name:"Mangmi Air X",analog:true}],{mode:"auto"})');
  const options=h.node("#controllerSelect").children;
  assert.deepEqual(options.map((option)=>option.value),["auto","2","7"]);
  assert.match(options[1].textContent,/virtuel/);
  assert.match(options[2].textContent,/Mangmi Air X/);
});

test("choosing a native device stops and disarms before accepting the new pad", async()=>{
  const h=harness();
  const selections=[];
  h.context.window.ScoutInput={select:(value)=>selections.push(value)};
  h.run('window.scoutNativeControllersUpdate([{id:2,name:"Xbox"},{id:7,name:"Mangmi"}],{mode:"auto"}); window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"Xbox",2); selectGamepad("7");');
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.run("state.nativeGamepad"),null);
  assert.deepEqual(selections,["7"]);
  h.run('window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"Xbox",2); window.scoutNativeButton(9,2);');
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.run("state.nativeGamepad"),null);
  h.run('window.scoutNativeGamepadUpdate([0,0,0,0],[],true,"Mangmi",7); window.scoutNativeButton(9,7);');
  assert.equal(h.run("state.armed"),false);
  await h.drain();
  assert.equal(h.run("state.armed"),true);
  assert.equal(h.run("pickGamepad().id"),"Mangmi");
  await h.drain();
  assert.ok(h.requests.filter((request)=>request.url==="/api/command").every((request)=>request.payload.action==="stop"));
});

test("missing manual controller remains selected instead of falling back to the phantom pad", ()=>{
  const h=harness();
  h.run('window.scoutNativeControllersUpdate([{id:2,name:"Xbox"}],{mode:"manual",selectedId:null}); window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"Xbox",2);');
  assert.equal(h.run("pickGamepad()"),null);
  assert.equal(h.node("#controllerSelect").value,"missing");
});

test("browser selection ignores other controllers and survives unrelated hotplug events", async()=>{
  const h=harness();
  const pads=[{index:0,id:"Xbox",connected:true,buttons:[],axes:[0,0,0,0]},
    {index:1,id:"Selected pad",connected:true,buttons:[],axes:[0,0,0,0]}];
  h.context.navigator.getGamepads=()=>pads;
  h.run('bindEvents(); selectGamepad("1"); state.armed=true;');
  assert.equal(h.run("pickGamepad().index"),1);
  h.events.get("gamepaddisconnected")({gamepad:pads[0]});
  assert.equal(h.run("state.armed"),true);
  h.events.get("gamepadconnected")({gamepad:pads[0]});
  assert.equal(h.run("pickGamepad().index"),1);
  pads[1].connected=false;
  h.events.get("gamepaddisconnected")({gamepad:pads[1]});
  assert.equal(h.run("pickGamepad()"),null);
  assert.equal(h.run("state.armed"),false);
  await h.drain();
});

test("arming connects ROS once before enabling commands", async()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); requestArm(); requestArm();');
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].url,"/api/ros/connect");
  assert.equal(h.requests[0].payload.reconnect,false);
  await h.drain();
  assert.equal(h.run("state.armed"),true);
});

test("a new selected joystick input arms automatically but a held stick does not undo disarming", async()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); window.scoutNativeGamepadUpdate([0,-0.8,0,0],[],true,"Mangmi",7); readGamepadVector();');
  assert.equal(h.requests[0].url,"/api/ros/connect");
  await h.drain();
  assert.equal(h.run("state.armed"),true);
  h.run('setArmed(false); readGamepadVector();');
  await h.drain();
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.requests.filter((request)=>request.url==="/api/ros/connect").length,1);
  h.run('window.scoutNativeGamepadUpdate([0,0,0,0],[],true,"Mangmi",7); readGamepadVector(); window.scoutNativeGamepadUpdate([0,-0.8,0,0],[],true,"Mangmi",7); readGamepadVector();');
  await h.drain();
  assert.equal(h.run("state.armed"),true);
});

test("A auto-arms and waits for ROS before sending undock", async()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); window.scoutNativeGamepadUpdate([0,0,0,0],[],true,"Mangmi",7); window.scoutNativeButton(0,7);');
  assert.deepEqual(h.requests.map((request)=>request.url),["/api/ros/connect"]);
  await h.drain();
  assert.equal(h.run("state.armed"),true);
  assert.equal(h.requests[1].payload.action,"undock");
});

test("canceling pending arming prevents delayed ROS success from enabling motion", async()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); handleGamepadButton(0); toggleArmed();');
  await h.drain();
  assert.equal(h.run("state.armed"),false);
  assert.ok(!h.requests.some((request)=>request.payload.action==="undock"));
});

test("ROS failure leaves control disarmed", async()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); requestArm();');
  h.requests[0].resolve({ok:false,error:"ROS unavailable"});
  h.requests[0].resolved=true;
  await h.drain();
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.run("state.armPending"),false);
});

test("Android context menus and noneditable text selection are suppressed", ()=>{
  const h=harness();
  h.run('bindEvents(); state.android=true;');
  let prevented=0;
  h.events.get("contextmenu")({preventDefault:()=>prevented++});
  h.events.get("selectstart")({target:{closest:()=>null},preventDefault:()=>prevented++});
  assert.equal(prevented,2);
  h.events.get("selectstart")({target:{closest:()=>({})},preventDefault:()=>prevented++});
  assert.equal(prevented,2);
});

test("opening the controller menu prevents native buttons or axes from auto-arming", ()=>{
  const h=harness();
  h.run('setArmed(false,{sendStop:false}); state.controllerMenuOpen=true; window.scoutNativeGamepadUpdate([0,-1,0,0],[],true,"Mangmi",7); window.scoutNativeButton(0,7); window.scoutNativeInput(7); readGamepadVector();');
  assert.equal(h.run("state.armed"),false);
  assert.equal(h.requests.length,0);
});

// Re-records the README media (docs/media) from a running dashboard.
//   1. .venv\Scripts\python dashboard\server.py --port 8771   (and load the Pearson scenario once)
//   2. msedge --headless=new --remote-debugging-port=9333 --window-size=1600,1000 about:blank
//   3. node tools/record_media.mjs <frames dir> storm|tour|stills, then encode with ffmpeg (palettegen/paletteuse).
// Records dashboard frames over the Chrome DevTools Protocol (headless Edge on port 9333).
// Usage: node record.mjs <outDir> <scene>   scenes: storm, tour, stills
import fs from "node:fs";
import path from "node:path";

const [outDir, scene] = process.argv.slice(2);
const BASE = "http://127.0.0.1:8771/";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
};
const shot = async (file, clip) => {
  const r = await send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" });
  fs.writeFileSync(path.join(outDir, file), Buffer.from(r.data, "base64"));
};
const waitFor = async (expr, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evaluate(expr)) return; } catch (e) { /* page still loading */ } await sleep(300); }
  throw new Error("timeout waiting for " + expr);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const open = async (hash) => {
  await send("Page.navigate", { url: "about:blank" });           // a real reload, not a same-page hash change
  await sleep(500);
  await send("Page.navigate", { url: BASE + "#" + hash });
  await sleep(1500);
  await waitFor("typeof state !== 'undefined' && state.run && state.run.mode === 'yyz' && typeof M !== 'undefined' && !!M.map");
  await sleep(2500);                                         // home fit + first tiles
};
fs.mkdirSync(outDir, { recursive: true });
const pad = n => String(n).padStart(3, "0");

if (scene === "storm") {
  // map only, with a label: plan name, clock, planes waiting for a gate
  const W = 760, H = 560, X = (1600 - W) / 2, Y = (1000 - H) / 2;
  for (const [kind, label, colour] of [["greedy", "GREEDY RULES", "#c92a2a"], ["aerogate", "AEROGATE", "#2b8a3e"]]) {
    await open("t=17:58");
    if (kind === "greedy") { await evaluate("showPlan('greedy')"); await waitFor("state.run.solver === 'greedy_rules'"); await sleep(1500); }
    await evaluate(`(() => {
      const st = document.createElement("style");
      st.textContent = ".hud-left,.hud-right,.hud-bottom,.hud-top,.leaflet-control-container,.plan-banner{display:none!important}" +
        "#gifLabel{position:fixed;left:${X + 14}px;top:${Y + 12}px;z-index:5000;background:${colour};color:#fff;padding:7px 12px 8px;box-shadow:0 2px 8px rgba(0,0,0,.35);font-family:'IBM Plex Sans Condensed','Arial Narrow',sans-serif}" +
        "#gifLabel b{display:block;font-size:21px;letter-spacing:.08em}#gifLabel span{display:block;font:600 15px 'IBM Plex Mono',monospace;margin-top:2px}";
      document.head.append(st);
      const d = document.createElement("div"); d.id = "gifLabel"; d.innerHTML = "<b>${label}</b><span id='gifClock'></span><span id='gifWait'></span>"; document.body.append(d);
      const S = state.run.map.hold_spots, c = state.run.map.center;
      const lat = (S.reduce((a, s) => a + s.p[0], 0) + 2 * c[0]) / (S.length + 2), lon = (S.reduce((a, s) => a + s.p[1], 0) + 2 * c[1]) / (S.length + 2);
      M.map.setView([lat, lon], 14.75, { animate: false });
      return true; })()`);
    await sleep(4000);                                       // tiles at the new view
    let f = 0;
    for (let T = 17 * 60 + 58; T <= 18 * 60 + 22; T += 0.4) {
      await evaluate(`(() => { M.T = ${T}; renderMapView({ panels: false });
        const n = traffic(state.run, M.T).items.filter(i => i.phase === "HLD").length;
        document.getElementById("gifClock").textContent = hm(M.T);
        document.getElementById("gifWait").textContent = n + (n === 1 ? " plane" : " planes") + " waiting for a gate";
        return n; })()`);
      await sleep(120);
      await shot(`${kind}_${pad(f++)}.png`, { x: X, y: Y, width: W, height: H });
    }
    console.log(kind, f, "frames");
  }
} else if (scene === "tour") {
  await open("t=16:12");
  let f = 0;
  for (let T = 16 * 60 + 12; T <= 16 * 60 + 40; T += 0.5) {
    await evaluate(`(() => { M.T = ${T}; renderMapView(); return true; })()`);
    await sleep(150);
    await shot(`tour_${pad(f++)}.png`);
  }
  console.log("tour", f, "frames");
} else if (scene === "stills") {
  await open("t=18:20");
  await sleep(1500);
  await shot("dashboard.png");
  await open("t=18:20&rtab=res");
  await sleep(1500);
  await shot("resources.png");
  await open("t=18:10&rtab=res&sel=ACA1557&zoom=gates");
  await sleep(4000);
  await shot("gate_options.png");
  await open("t=17:15&sel=AAL4738");
  await sleep(1500);
  await shot("decision.png");
  console.log("stills done");
}
ws.close();

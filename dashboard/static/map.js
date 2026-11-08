"use strict";
/* Pearson map: the real OpenStreetMap map of Toronto Pearson with every flight in
   AeroGate's plan animated: landing on 24R or 24L, taxiing on the real taxiways to
   its assigned stand, then pushback, taxi-out and take-off from 23 (traffic.js).
   Plan updates draw an arrow for every gate change; clicking any aircraft opens
   its gate decision. Uses globals from app.js and traffic.js.
   Map and airport data (c) OpenStreetMap contributors (ODbL). */

const PLANE_PATH = "M50,0 C54,2 55.5,8 55.5,15 L55.5,37 L100,58 L100,64 L55.5,52 L55.5,84 L71,93 L71,97 L54,94 L50,100 L46,94 L29,97 L29,93 L44.5,84 L44.5,52 L0,64 L0,58 L44.5,37 L44.5,15 C44.5,8 46,2 50,0 Z";
const PAD = { paddingTopLeft: [340, 60], paddingBottomRight: [560, 80] };
const CAT_CLS = { domestic: "dom", transborder: "usa", international: "intl", cargo: "cgo" };
const PHASE_TXT = { APP: "APPROACH", LDG: "LANDING", TXI: "TAXI IN", STD: "PARKING", HPS: "HOLDING POSITION", PSH: "PUSHBACK",
  TXO: "TAXI OUT", HS: "HOLD SHORT", QUE: "QUEUE", LUP: "LINE UP", DEP: "TAKE-OFF", CLB: "CLIMB", HLD: "WAITING FOR GATE" };
const phaseTxt = (it, lower) => (lower ? (PHASE_TXT[it.phase] || it.phase).toLowerCase() : PHASE_TXT[it.phase] || it.phase)
  + (it.phase === "HS" && it.hsRwy ? ` ${it.hsRwy}` : "")
  + ((it.phase === "APP" || it.phase === "LDG") && it.rwy ? ` ${it.rwy}` : "");
const hm = m => fmt(m).slice(0, 5);

const M = { view: "map", T: null, timer: null, last: null, speed: 1, map: null, layers: null, staticFor: null, lastRun: null,
  home: null, planes: new Map(), routes: new Map(), widths: [], stopbars: [], rwy: {}, tileErrors: 0, vector: false, panelStep: null };

/* ---------- map ---------- */
function ensureMap() {
  if (M.map || typeof L === "undefined") return M.map;
  const map = L.map("leaflet", { zoomControl: false, minZoom: 12, maxZoom: 19, zoomSnap: 0.25 });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" });
  osm.addTo(map);
  // no internet (venue Wi-Fi)? draw the airport from the bundled OSM vectors instead
  osm.on("tileerror", () => { if (++M.tileErrors === 6 && state.run) { M.vector = true; drawSurface(); } });
  M.layers = {
    ground: L.layerGroup().addTo(map), stands: L.layerGroup().addTo(map), rwy: L.layerGroup().addTo(map),
    options: L.layerGroup().addTo(map), piers: L.layerGroup().addTo(map),
    arrows: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map), planes: L.layerGroup().addTo(map),
  };
  const optPane = map.createPane("opts");                            // the selected flight's gate options, above every tag
  optPane.style.zIndex = 660; optPane.style.pointerEvents = "none";
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.layers({ "Map": osm, "Satellite": sat }, { "Taxi routes": M.layers.routes, "Gate labels": M.layers.stands },
    { position: "topright", collapsed: true }).addTo(map);
  L.control.scale({ imperial: false, position: "topright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.on("zoomend", () => { applyWidths(); syncZoom(); for (const p of M.planes.values()) p.key = null; renderMapView({ panels: false }); });
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(map.getContainer());
  M.map = map;
  return map;
}
const mpp = () => 40075016.686 * Math.cos(43.68 * Math.PI / 180) / Math.pow(2, M.map.getZoom() + 8);
function syncZoom() {
  const z = M.map.getZoom(), c = M.map.getContainer();
  c.classList.toggle("z-far", z < 15.25);
  c.classList.toggle("z-mid", z < 16.5);
}
function applyWidths() { const m = mpp(); for (const w of M.widths) w.layer.setStyle({ weight: Math.max(w.min, w.metres / m + (w.extra || 0)) }); }
function widthLine(latlngs, metres, cls, min, layer, extra = 0) {
  const l = L.polyline(latlngs, { className: cls, weight: 1, interactive: false, lineCap: "butt" }).addTo(layer);
  M.widths.push({ layer: l, metres, min, extra });
  return l;
}

/* offline fallback: the airport surface from the bundled OSM extract */
async function drawSurface() {
  const g = M.layers.ground;
  g.clearLayers();
  M.map.getContainer().classList.add("vector");
  let geo = null;
  try { geo = await (await fetch("yyz_osm.json")).json(); } catch (err) { return; }
  const ll = c => c.map(([x, y]) => [y, x]), F = geo.features, kind = k => F.filter(f => f.properties.kind === k);
  for (const f of kind("apron")) if (f.geometry.type === "Polygon") L.polygon(ll(f.geometry.coordinates[0]), { className: "smr-apron", stroke: false, interactive: false }).addTo(g);
  for (const f of [...kind("taxiway"), ...kind("taxilane")]) widthLine(ll(f.geometry.coordinates), f.properties.kind === "taxiway" ? 23 : 15, "smr-taxiway", 1.5, g);
  for (const f of kind("runway")) { widthLine(ll(f.geometry.coordinates), 61, "smr-runway-edge", 3, g, 2); widthLine(ll(f.geometry.coordinates), 61, "smr-runway", 2, g); }
  for (const f of kind("terminal")) if (f.geometry.type === "Polygon") L.polygon(ll(f.geometry.coordinates[0]), { className: "smr-terminal", weight: 1, interactive: false }).addTo(g);
  for (const f of kind("parking_position")) L.polyline(ll(f.geometry.coordinates), { className: "smr-stand-other", weight: 1, interactive: false }).addTo(g);
  applyWidths();
}

function drawStatic(run) {
  const { stands, rwy } = M.layers;
  stands.clearLayers(); rwy.clearLayers();
  M.widths = M.widths.filter(w => M.layers.ground.hasLayer(w.layer));
  M.stopbars = [];
  const R = run.map.runways;
  M.rwy = {};
  for (const rw of R.arrs) M.rwy[rw.ref] = widthLine([...rw.line], 61, "rwy-active arr", 3, rwy);
  M.rwy[R.dep.ref] = widthLine([...R.dep.roll], 61, "rwy-active dep", 3, rwy);
  // stop bars wherever a taxi route has to hold short of a landing runway (24L arrivals crossing 24R)
  const seen = [], bar = (path, x) => {
    if (!x) return;
    const a = at(path, x.s);
    if (seen.some(p => dist(p, a.p) < 25)) return;
    seen.push(a.p);
    const h = a.hdg * Math.PI / 180, n = Math.cos(h), e = Math.sin(h);
    const l = L.polyline([offset(a.p, -e * 16, n * 16), offset(a.p, e * 16, -n * 16)], { className: "stopbar", weight: 4, interactive: false }).addTo(rwy);
    l.rwy = x.rwy;
    M.stopbars.push(l);
  };
  for (const g of run.gates) {
    if (!g.routes) continue;
    for (const rw of R.arrs) for (const hold of [false, true]) bar(arrPath(g.routes.arr[rw.ref], hold), arrCrossing(g.routes.arr[rw.ref], rw.ref, R, hold));
    bar(makePath([taxiOut(g, R)]), depCrossing(g, R));
  }
  // labels: 24R (north) above its threshold, 24L (south) below, so the two never touch
  R.arrs.forEach((rw, i) => L.marker(rw.line[0], { interactive: false,
    icon: L.divIcon({ className: `rwy-cfg ${i ? "below" : ""}`, html: `<span>ARRIVALS ${rw.ref}</span>`, iconSize: null }) }).addTo(rwy));
  L.marker(R.dep.roll[0], { interactive: false, icon: L.divIcon({ className: "rwy-cfg dep", html: `<span>DEPARTURES ${R.dep.ref}</span>`, iconSize: null }) }).addTo(rwy);
  for (const g of run.gates) {
    if (!g.stand) continue;
    L.marker(g.gate_ll, { icon: L.divIcon({ className: "gate-lbl", html: `<span data-gate="${g.id}">${g.id}</span>`, iconSize: null }), interactive: false, keyboard: false }).addTo(stands);
  }
  // pier badges: a dot at each pier's baggage area (inside the terminal, behind its gates) and a label
  // pushed outward from the terminal on a short leader line, showing crews free and bag load
  M.layers.piers.clearLayers();
  M.pierBadges = {};
  for (const P of Object.keys(PIERS)) {
    const gs = run.gates.filter(g => g.pier === P && g.gate_ll);
    if (!gs.length) continue;
    const c = [gs.reduce((a, g) => a + g.gate_ll[0], 0) / gs.length, gs.reduce((a, g) => a + g.gate_ll[1], 0) / gs.length], m = run.map.center;
    const pos = P === "C" ? c : [c[0] + (m[0] - c[0]) * 0.45, c[1] + (m[1] - c[1]) * 0.45];
    const brg = bearing(m, c) * Math.PI / 180, out = P === "C" ? 50 : 120;
    const mk = L.marker(pos, { keyboard: false, title: `${PIERS[P].name}: ground crew and baggage (estimates)` })
      .on("click", () => showRTab("res")).addTo(M.layers.piers);
    mk._dx = Math.round(Math.sin(brg) * out); mk._dy = Math.round(-Math.cos(brg) * out);
    M.pierBadges[P] = mk;
  }
  M.optsFor = null;
  applyWidths();
}
function zoomToGates(run) {
  if (!M.map) return;
  M.map.fitBounds(L.latLngBounds(run.gates.filter(g => g.gate_ll && g.pier !== "C").map(g => g.gate_ll)).pad(0.12), PAD);
}
function updatePierBadges(run, tr, T) {
  const res = resources(run, tr.sch);
  for (const [P, mk] of Object.entries(M.pierBadges || {})) {
    const c = crewAt(res, P, T), b = bagsAt(res, P, T);
    const cls = c.free <= 0 || (b.pct != null && b.pct >= 100) ? "bad" : c.free === 1 || (b.pct != null && b.pct >= 80) ? "warn" : "";
    const dx = mk._dx, dy = mk._dy;
    const html = `<i class="pb-dot"></i><svg class="pb-lead" width="1" height="1"><line x1="0" y1="0" x2="${dx}" y2="${dy}"/></svg>`
      + `<span style="left:${dx}px;top:${dy}px"><b>${P === "C" ? "CGO" : P}</b> ${Math.max(0, c.free)}/${c.total} crews${b.pct != null ? ` &middot; ${b.pct}% bags` : ""}</span>`;
    if (mk._html !== html + cls) { mk.setIcon(L.divIcon({ className: `pier-badge ${cls}`, html, iconSize: null })); mk._html = html + cls; }
  }
}
/* the selected flight's gates, drawn above every tag: green planned, blue legal (+pts if moved there),
   small grey taken; gates it may not use are left off. Other aircraft's tags fade while one is selected. */
function drawOptions(run) {
  const layer = M.layers.options;
  layer.clearLayers();
  M.map.getContainer().classList.toggle("has-sel", !!state.selected);
  if (!state.selected) return;
  const { out } = gateOptions(state.selected);
  const cheap = new Set([...out].filter(([, a]) => a.verdict === "costlier").sort((a, b) => (a[1].delta ?? 0) - (b[1].delta ?? 0)).slice(0, 4).map(([g]) => g));
  for (const g of run.gates) {
    const a = out.get(g.id);
    if (!a || !g.gate_ll || a.verdict === "rule") continue;
    const r = a.verdict === "chosen" ? 9 : a.verdict === "costlier" ? 7 : 4;
    L.circleMarker(g.gate_ll, { pane: "opts", radius: r, className: `opt-dot ${a.verdict}`, interactive: false }).addTo(layer);
    if (a.verdict === "chosen" || cheap.has(g.id))
      L.marker(g.gate_ll, { pane: "opts", interactive: false, keyboard: false, icon: L.divIcon({ className: `opt-lbl ${a.verdict}`, iconSize: null,
        html: `<span>${g.id}${a.verdict === "chosen" ? "" : a.delta != null ? ` +${a.delta.toFixed(2)}` : ""}</span>` }) }).addTo(layer);
  }
}

/* ---------- aircraft ---------- */
/* Icon size. True size when zoomed in. Zoomed out, a plane is drawn bigger (up to 17 px across, 12 px
   parked) so it stays visible, but only as far as its neighbours allow: two icons never overlap.
   Neighbours whose shapes would touch even at true size (wingtips at corner stands, a pushback beside
   a parked widebody) are drawn up to 20% smaller. Shapes: fuselage, wing and tail of PLANE_PATH. */
const SHAPE = [[0.11, 1, 0.5], [1, 0.2, 0.5], [0.42, 0.13, 0.905]];   // [width x span, length x len, centre from nose x len]
const footprint = it => { const span = Math.max(20, it.F.info.wingspan || 36); return { span, len: AC_LENGTH[it.F.info.aircraft] || span }; };
function shapeRects(it, fp, k) {
  const h = it.hdg * Math.PI / 180, f = [Math.sin(h), Math.cos(h)], r = [Math.cos(h), -Math.sin(h)], c = [it.p[1] * KX, it.p[0] * KY];
  return SHAPE.map(([w, l, y]) => { const o = (0.5 - y) * fp.len * k; return { c: [c[0] + f[0] * o, c[1] + f[1] * o], f, r, hw: w * fp.span * k / 2, hl: l * fp.len * k / 2 }; });
}
function rectsHit(a, b) {                    // separating-axis test for two oriented rectangles
  for (const ax of [a.f, a.r, b.f, b.r]) {
    const pr = o => Math.abs(o.hl * (o.f[0] * ax[0] + o.f[1] * ax[1])) + Math.abs(o.hw * (o.r[0] * ax[0] + o.r[1] * ax[1]));
    if (Math.abs((b.c[0] - a.c[0]) * ax[0] + (b.c[1] - a.c[1]) * ax[1]) > pr(a) + pr(b)) return false;
  }
  return true;
}
function iconScales(items) {
  const m = mpp(), P = items.map(it => {
    const fp = footprint(it), kMax = Math.max(1, (it.kind === "stand" ? 12 : 17) / (fp.span / m));
    return { it, fp, kMax, k: kMax, r: 0.56 * Math.max(fp.span, fp.len) };   // reaches the wingtip and tail corners
  });
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    if (dist(a.it.p, b.it.p) > a.r * a.kMax + b.r * b.kMax) continue;
    // largest common scale up to which the two shapes never touch (each capped at its own maximum). Grown
    // from small to large, since a big cross-shaped icon can straddle a small one without its rectangles touching.
    const ladder = [0.8, 0.85, 0.92, 1];
    for (let t = 1.14; t < Math.max(a.kMax, b.kMax); t *= 1.14) ladder.push(t);
    ladder.push(Math.max(a.kMax, b.kMax));
    let s = 0.8;
    for (const t of ladder) {
      const A = shapeRects(a.it, a.fp, Math.min(t, a.kMax)), B = shapeRects(b.it, b.fp, Math.min(t, b.kMax));
      if (A.some(x => B.some(y => rectsHit(x, y)))) break;
      s = t;
    }
    a.k = Math.min(a.k, Math.min(s, a.kMax)); b.k = Math.min(b.k, Math.min(s, b.kMax));
  }
  const q = k => Math.floor(k * 20 + 1e-6) / 20;                  // 0.05 steps, rounded down
  for (const a of P) a.k = Math.max(0.8, q(a.k));
  // final sizes differ per plane: re-check close pairs as drawn and shrink the bigger icon until they clear
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j];
      if (dist(a.it.p, b.it.p) > a.r * a.k + b.r * b.k) continue;
      const A = shapeRects(a.it, a.fp, a.k), B = shapeRects(b.it, b.fp, b.k);
      if (!A.some(x => B.some(y => rectsHit(x, y)))) continue;
      const big = a.k >= b.k ? a : b;
      if (big.k <= 0.8) continue;
      big.k = Math.max(0.8, q(big.k * 0.88)); changed = true;
    }
    if (!changed) break;
  }
  return new Map(P.map(p => [p.it.F.fid, p.k]));
}
function planeHtml(it, cls, k) {
  const m = mpp(), { span, len } = footprint(it);
  const w = span / m * k, hgt = len / m * k, sz = Math.ceil(Math.max(w, hgt)) + 6;
  return { sz, html: `<div class="ac ${cls}" style="width:${sz}px;height:${sz}px"><svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:${w}px;height:${hgt}px"><path d="${PLANE_PATH}" vector-effect="non-scaling-stroke"/></svg></div>` };
}
/* data tag: callsign, then the rest in .x so a crowded tag can shrink to the callsign alone */
function tagHtml(it) {
  const F = it.F;
  if (it.kind === "stand") return `<b>${F.cs}</b>`;
  if (it.phase === "HLD") return `<b>${F.cs}</b><span class="x"> waiting ${it.waited ?? 0} min${it.to ? ` for ${it.to}` : ""}</span>`;
  const dest = it.to && it.phase !== "CLB" ? ` &#8594; ${it.to}` : "";
  return `<b>${F.cs}</b><span class="x"> ${icao(F.info)}<br>${phaseTxt(it)}${it.gs ? ` ${it.gs} kt` : ""}${dest}</span>`;
}

/* ---------- label declutter ----------
   Tags are monospace (IBM Plex Mono 11 px: 6.6 px per character, 14.3 px lines), so their screen
   boxes are computed, not measured. Highest-priority aircraft are placed first; a tag that would
   overlap one already placed, or another aircraft, tries the left side, then shrinks to the
   callsign, then hides. The selected aircraft and anything landing always keep a full tag. */
const TAG = { ch: 6.6, line: 14.3, padX: 14, padY: 4, gap: 16, lift: 10 };
function tagRank(it) {
  if (state.selected === it.F.fid) return 0;
  if (it.phase === "APP" || it.phase === "LDG") return 1;
  if (it.kind === "hold") return 2;
  if (it.kind === "stand") return 5;
  return it.phase === "DEP" || it.phase === "CLB" ? 4 : 3;
}
function tagSize(html, compact) {
  const lines = (compact ? html.replace(/<span class="x">[\s\S]*<\/span>/, "") : html)
    .split("<br>").map(l => l.replace(/<[^>]+>/g, "").replace(/&#?\w+;/g, "x").length);
  return [Math.max(...lines) * TAG.ch + TAG.padX, lines.length * TAG.line + TAG.padY];
}
function declutter(items) {
  const map = M.map, standTags = map.getZoom() >= 16.5, placed = [], planes = [];
  // pier badges and the selected flight's gate labels are fixed obstacles: tags move out of their way
  const mc = map.getContainer().getBoundingClientRect(), fixed = [...Object.values(M.pierBadges || {})];
  M.layers.options.eachLayer(l => { if (l.getElement && l instanceof L.Marker) fixed.push(l); });
  for (const mk of fixed) {
    const s = mk.getElement() && mk.getElement().querySelector("span");
    const r = s && s.getBoundingClientRect();
    if (r && r.width) placed.push([r.left - mc.left, r.top - mc.top, r.right - mc.left, r.bottom - mc.top]);   // hidden badges have no size
  }
  const overlaps = (b, fid) => placed.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])
    || planes.some(o => o.fid !== fid && b[0] < o.b[2] && b[2] > o.b[0] && b[1] < o.b[3] && b[3] > o.b[1]);
  const list = [];
  for (const it of items) {
    const p = M.planes.get(it.F.fid);
    if (!p) continue;
    const c = map.latLngToContainerPoint(it.p);
    if (it.kind !== "stand") { const r = (p.sz || 20) * 0.32; planes.push({ fid: it.F.fid, b: [c.x - r, c.y - r, c.x + r, c.y + r] }); }
    list.push({ it, p, c, rank: tagRank(it) });
  }
  list.sort((a, b) => a.rank - b.rank);
  for (const { it, p, c, rank } of list) {
    let place = "hid";
    if (it.kind !== "stand" || standTags) {
      const opts = rank <= 1 ? [["R", false], ["L", false]] : [["R", false], ["L", false], ["R", true], ["L", true]];
      for (const [side, compact] of opts) {
        const [w, h] = tagSize(p.tag || "", compact), top = c.y - TAG.lift - h / 2;
        const b = side === "R" ? [c.x + TAG.gap, top, c.x + TAG.gap + w, top + h] : [c.x - TAG.gap - w, top, c.x - TAG.gap, top + h];
        if (rank <= 1 && side === "L" && !overlaps(b, it.F.fid)) { place = "L"; placed.push(b); break; }
        if (rank <= 1 && side === "L") { place = "R"; placed.push([c.x + TAG.gap, top, c.x + TAG.gap + w, top + h]); break; }  // must show: keep right
        if (!overlaps(b, it.F.fid)) { place = side + (compact ? "c" : ""); placed.push(b); break; }
      }
    }
    if (p.place === place) continue;
    p.place = place;
    const te = p.marker.getTooltip() && p.marker.getTooltip().getElement();
    if (!te) { p.place = null; continue; }
    te.classList.toggle("hid", place === "hid");
    te.classList.toggle("cmp", place.endsWith("c"));
    te.classList.toggle("flip", place.startsWith("L"));
    const [w] = tagSize(p.tag || "", place.endsWith("c"));
    te.style.marginLeft = place.startsWith("L") ? `${-(w + 2 * TAG.gap - 6)}px` : "";
  }
}
/* the next stretch of a route (a short leader), so moving aircraft don't paint the whole apron */
function leader(lines, metres) {
  const out = [];
  let left = metres;
  for (const l of lines) {
    if (left <= 0 || !l || l.length < 2) continue;
    const L = polyLen(l);
    if (L <= left) { out.push(l); left -= L; } else { out.push(between(l, 0, left)); left = 0; }
  }
  return out;
}

function updatePlanes(run, tr) {
  const { planes, routes } = M.layers, seen = new Set(), zoom = M.map.getZoom(), showRoutes = M.map.hasLayer(routes);
  const scales = iconScales(tr.items);
  for (const it of tr.items) {
    const k = scales.get(it.F.fid) || 1, key = `${zoom}:${k}`;
    const fid = it.F.fid;
    seen.add(fid);
    const cls = [it.kind, it.kind === "stand" ? CAT_CLS[it.F.info.category] || "dom" : "", it.F.info.priority ? "priority" : "", state.selected === fid ? "selected" : ""].join(" ");
    let p = M.planes.get(fid);
    if (!p) {
      const marker = L.marker(it.p, { keyboard: true, title: it.F.cs, riseOnHover: true }).addTo(planes);
      marker.on("click", () => select(fid));
      marker.bindTooltip("", { permanent: true, direction: "right", offset: [10, -10], className: "dtag", interactive: false });
      p = { marker, key: null, cls: null, tag: null };
      M.planes.set(fid, p);
    }
    if (p.key !== key || p.cls !== cls) {
      const { sz, html } = planeHtml(it, cls, k);
      p.marker.setIcon(L.divIcon({ className: "ac-icon", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], html }));
      p.key = key; p.cls = cls; p.tag = null; p.sz = sz; p.place = null;
    }
    p.marker.setLatLng(it.p);
    const el = p.marker.getElement();
    if (el && el.firstElementChild) el.firstElementChild.style.transform = `rotate(${it.hdg}deg)`;
    const tag = tagHtml(it);
    if (tag !== p.tag) { p.marker.setTooltipContent(tag); p.tag = tag; p.place = null; }
    const te = p.marker.getTooltip() && p.marker.getTooltip().getElement();
    if (te) { for (const k of ["arr", "dep", "hold", "stand"]) te.classList.toggle(k, it.kind === k); te.classList.toggle("sel", state.selected === fid); }
    // route ahead: the whole way to the gate for the selected aircraft and anything landing,
    // a short leader (about 40 s of taxi) for everything else on the ground
    const want = showRoutes && it.route && it.kind !== "stand" && it.kind !== "hold";
    let r = M.routes.get(fid);
    if (want) {
      const full = state.selected === fid || it.phase === "APP" || it.phase === "LDG";
      const lines = full ? it.route.filter(x => x && x.length > 1) : leader(it.route, 320);
      if (!r) { r = L.polyline(lines, { className: `route ${it.kind}`, weight: 3, interactive: false }).addTo(routes); M.routes.set(fid, r); }
      else r.setLatLngs(lines);
    } else if (r) { routes.removeLayer(r); M.routes.delete(fid); }
  }
  for (const [fid, p] of M.planes) {
    if (seen.has(fid)) continue;
    planes.removeLayer(p.marker); M.planes.delete(fid);
    if (M.routes.has(fid)) { routes.removeLayer(M.routes.get(fid)); M.routes.delete(fid); }
  }
  declutter(tr.items);
  const lit = (layer, on, c) => { const e = layer && layer.getElement && layer.getElement(); if (e) e.classList.toggle(c, on); };
  for (const [ref, layer] of Object.entries(M.rwy)) lit(layer, !!tr.lit[ref], "lit");
  for (const b of M.stopbars) lit(b, !!tr.red[b.rwy], "red");
}
function clearPlanes() {
  if (!M.layers) return;
  ["planes", "routes", "arrows"].forEach(k => M.layers[k].clearLayers());
  M.planes.clear(); M.routes.clear();
}

/* gate changes made at the current plan update: arrow from the old gate to the new one */
function curve(a, b) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = dist(a, b), h = (bearing(a, b) - 90) * Math.PI / 180;
  const c = offset(mid, Math.cos(h) * d * 0.25, Math.sin(h) * d * 0.25), pts = [];
  for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]); }
  return pts;
}
function drawArrows(run, idx) {
  const layer = M.layers.arrows;
  layer.clearLayers();
  if (idx === 0) return;
  const tk = run.ticks[idx], gateById = Object.fromEntries(run.gates.map(g => [g.id, g])), was = {};
  for (const [gid, bs] of Object.entries(run.ticks[idx - 1].plan)) for (const b of bs) was[b.flight_id] = gid;
  const hot = new Set();
  for (const [fid, to] of (tk.decisions && tk.decisions.reassignments) || []) {
    const from = was[fid], ga = gateById[from], gb = gateById[to];
    if (!ga || !gb || !ga.gate_ll || !gb.gate_ll) continue;
    hot.add(to);
    L.polyline(curve(ga.gate_ll, gb.gate_ll), { className: `move-arrow ${state.selected === fid ? "sel" : ""}`, weight: 3, interactive: false }).addTo(layer);
    L.marker(gb.gate_ll, { icon: L.divIcon({ className: "move-tag", html: `<span>${callsign(fid)} ${from} &#8594; ${to}</span>`, iconSize: null }) })
      .on("click", () => select(fid)).addTo(layer);
  }
  document.querySelectorAll("#leaflet .gate-lbl span").forEach(s => s.classList.toggle("hot", hot.has(s.dataset.gate)));
}

/* ---------- side panels ---------- */
function renderClock(run, tr, T) {
  $("#mapClock").textContent = hm(T);
  $("#mapTime").value = T;
  const moving = tr.items.filter(i => i.kind === "arr" || i.kind === "dep").length;
  const waiting = tr.items.filter(i => i.kind === "hold").length;
  $("#mapNow").textContent = `${tr.items.filter(i => i.kind === "stand").length} on stand, ${moving} moving${waiting ? `, ${waiting} waiting for a gate` : ""}`;
  $("#playKey").textContent = M.timer ? "Pause" : "Play";
  $$("#speedKeys [data-speed]").forEach(b => b.classList.toggle("on", Number(b.dataset.speed) === M.speed));
}
function renderLists(run, tr, T) {
  const sch = tr.sch, byFid = new Map(tr.items.map(i => [i.F.fid, i]));
  const row = (F, t, gate, st) => h("div", { class: `lrow ${state.selected === F.fid ? "sel" : ""}`, onclick: () => select(F.fid) },
    h("span", { class: "t" }, hm(t)), h("span", { class: "cs" }, F.cs), h("span", { class: "ty" }, st), h("span", { class: "g" }, gate));
  const arr = sch.arrs.filter(F => { const it = byFid.get(F.fid); return (it && it.kind === "arr") || (F.td > T && F.td < T + 45); })
    .sort((a, b) => a.td - b.td).slice(0, 5);
  const dep = sch.deps.filter(F => { const it = byFid.get(F.fid); return (it && it.kind === "dep") || (F.offBlock > T && F.offBlock < T + 30); })
    .sort((a, b) => (a.tot ?? a.offBlock) - (b.tot ?? b.offBlock)).slice(0, 5);
  const fill = (box, rows, empty) => { box.innerHTML = ""; if (!rows.length) box.append(h("div", { class: "lrow empty" }, empty)); rows.forEach(r => box.append(r)); };
  fill($("#arrList"), arr.map(F => { const it = byFid.get(F.fid); return row(F, F.td, F.gid, it && it.kind === "arr" ? phaseTxt(it, true) : `lands ${F.rw}`); }), "None in the next 45 min");
  fill($("#depList"), dep.map(F => { const it = byFid.get(F.fid); return row(F, isFinite(F.tot) ? F.tot : F.offBlock, it && it.kind === "dep" ? run.map.runways.dep.ref : F.gid, it && it.kind === "dep" ? phaseTxt(it, true) : "pushes"); }), "None in the next 30 min");
}

/* plan health: the numbers behind "you can trust this plan" (computed once per run) */
function renderHealth(run) {
  const box = $("#health");
  box.innerHTML = "";
  const last = run.ticks[run.ticks.length - 1];
  const flights = Object.keys(last.flights || {}).length;
  const gated = Object.values(last.plan || {}).reduce((a, bs) => a + bs.length, 0);
  let moves = 0, decisions = 0, optimal = 0, ms = 0, n = 0;
  for (const tk of run.ticks) {
    moves += ((tk.decisions || {}).reassignments || []).length;
    if (tk.audit) { decisions += (tk.audit.entries || []).length; n++; ms += tk.audit.solve_ms || 0; if (tk.audit.solver === "OPTIMAL") optimal++; }
  }
  const holds = Object.values(last.plan || {}).flat().filter(b => b.hold);
  const r = run.result;
  // side by side with the same evening re-planned by greedy rules (no optimisation): why this is better
  const C = run.rules_compare;
  if (C) {
    const a = C.aerogate, g = C.greedy, less = (x, y) => (y ? Math.round(100 * (y - x) / y) : 0);
    const row = (label, av, gv, win, tip) => h("div", { class: "vs-row", title: tip || "" },
      h("span", {}, label), h("b", { class: win ? "win" : "" }, av), h("span", { class: "g" }, gv));
    box.append(h("div", { class: "box-title" }, "AeroGate vs greedy rules, same evening"),
      h("div", { class: "vs-row th" }, h("span", {}, ""), h("span", {}, "AEROGATE"), h("span", {}, "GREEDY")),
      row("Flights with a gate", `${a.assigned}/${a.flights}`, `${g.assigned}/${g.flights}`),
      row("Rule violations", a.status === "OK" ? "0" : "!", g.status === "OK" ? "0" : "!"),
      row("Flights held on tarmac", `${a.holds}`, `${g.holds}`, a.holds < g.holds, "Flights waiting on the taxiway for a gate"),
      row("Minutes held on tarmac", `${a.hold_min}`, `${g.hold_min}`, a.hold_min < g.hold_min),
      row("Passenger-hours held", `${a.hold_pax_h}`, g.hold_pax_h.toLocaleString("en-US"), a.hold_pax_h < g.hold_pax_h, "Passengers kept on board on the tarmac, 85% load factor"),
      row("Gate changes", `${a.moves}`, `${g.moves}`, a.moves < g.moves),
      row("Score (lower is better)", a.score.toFixed(1), g.score.toFixed(1), a.score < g.score),
      h("div", { class: "vs-big" }, `${less(a.hold_pax_h, g.hold_pax_h)}% fewer passenger-hours stuck on the tarmac, ${less(a.score, g.score)}% lower score`),
      run.solver === "greedy_rules"
        ? h("button", { class: "hud-key vs-btn", onclick: () => showPlan("aerogate") }, "Back to the AeroGate plan")
        : h("button", { class: "hud-key vs-btn", onclick: () => showPlan("greedy") }, "Play the greedy plan on the map"),
      h("div", { class: "box-foot", title: `AeroGate: ${optimal}/${n} updates proven optimal, ${decisions} decisions explained` },
        "Greedy = same rules, no optimisation (first good free gate)."));
    return;
  }
  const stat = (num, label, cls) => h("div", { class: `stat ${cls || ""}` }, h("b", {}, num), h("span", {}, label));
  box.append(h("div", { class: "box-title" }, "Plan health"),
    h("div", { class: "stats" },
      stat(`${gated}/${flights}`, "flights with a gate"),
      stat(r.status === "OK" ? "0" : "!", "rule violations", r.status === "OK" ? "good" : "bad"),
      stat(`${moves}`, "gate changes, all explained"),
      stat(`${holds.length}`, holds.length ? `tarmac holds, ${holds.reduce((a, b) => a + b.hold, 0)} min total` : "tarmac holds"),
      stat(`${optimal}/${n}`, "updates proven optimal"),
      stat(`${decisions}`, "decisions with a full audit trail")),
    h("div", { class: "box-foot" }, `Score ${r.score != null ? r.score.toFixed(1) : "-"} (lower is better). Planner time ${Math.round(ms)} ms in total.`));
}

/* Switch the map between the AeroGate plan and the same evening re-planned by greedy rules, at the
   same moment, so the audience can watch the difference (e.g. planes waiting in the storm). */
async function showPlan(kind) {
  const T = M.T, playing = !!M.timer, solver = kind === "greedy" ? "greedy_rules" : "solution_aerogate";
  try {
    const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: $("#scenario").value, solver }) });
    const run = await res.json();
    if (!run || !run.ticks) return;
    state.run = run; state.baseline = run; state.selected = null; state.overrides = {};
    state.tick = T != null ? tickAt(run, T) : run.ticks.length - 1;
    renderAll();
    if (T != null) { M.T = T; renderMapView(); }
    if (playing) play();
  } catch (err) { /* keep the current plan on screen */ }
}
function syncPlanBanner(run) {
  let b = document.getElementById("planBanner");
  const greedy = run && run.solver === "greedy_rules";
  if (!b && greedy) {
    b = h("div", { id: "planBanner", class: "plan-banner" },
      h("b", {}, "GREEDY RULES PLAN"), h("span", {}, " no optimisation: same evening, same storm and failures "),
      h("button", { class: "hud-key", onclick: () => showPlan("aerogate") }, "Back to AeroGate"));
    document.body.append(b);
  }
  if (b) b.classList.toggle("hidden", !greedy);
  document.body.classList.toggle("plan-greedy", greedy);
}

/* ---------- render ---------- */
function renderMapView(opts = {}) {
  const run = state.run;
  if (!run || run.mode !== "yyz" || M.view !== "map" || typeof L === "undefined") return;
  const map = ensureMap();
  if (M.staticFor !== run.run_id) {
    M.staticFor = run.run_id;
    map.invalidateSize();
    clearPlanes();
    if (M.vector) drawSurface();
    drawStatic(run);
    const R = run.map.runways;
    // terminal, the landing runways and the last stretch of every taxi-out (where the departure queue forms)
    const queue = run.gates.filter(g => g.routes).map(g => along(taxiOut(g, R), Math.max(0, polyLen(taxiOut(g, R)) - 450)).p);
    M.home = L.latLngBounds(run.gates.filter(g => g.stand && g.pier !== "C").map(g => g.gate_ll)
      .concat(R.arrs.flatMap(rw => [rw.roll[0], rw.roll[rw.roll.length - 1]]), [R.dep.roll[0]], queue)).pad(0.04);
    map.fitBounds(M.home, PAD);
    setTimeout(() => { map.invalidateSize({ pan: false }); map.fitBounds(M.home, PAD); }, 200);
    syncZoom();
    M.arrowsFor = null;
  }
  const T = M.T ?? run.ticks[state.tick].time;
  const tr = traffic(run, T);
  if (state.tick !== tr.sch.idx) { state.tick = tr.sch.idx; renderStepper(); renderLog(); renderResult(); renderWhy(); }
  if (M.arrowsFor !== `${tr.sch.idx}:${state.selected}`) { M.arrowsFor = `${tr.sch.idx}:${state.selected}`; drawArrows(run, tr.sch.idx); }
  const optKey = `${tr.sch.idx}:${state.selected}:${JSON.stringify(state.overrides[tr.sch.idx] || [])}`;
  if (M.optsFor !== optKey) { M.optsFor = optKey; drawOptions(run); }
  updatePlanes(run, tr);
  renderClock(run, tr, T);
  const step = Math.floor(T * 2);                               // lists refresh every 30 s of airport time
  if (opts.panels !== false || M.panelStep !== step) { M.panelStep = step; renderLists(run, tr, T); updatePierBadges(run, tr, T); renderResources(run, tr, T); }
}

/* ---------- playback, views, drawer ---------- */
function frame() {
  const run = state.run, now = performance.now();
  const dt = M.last == null ? 0 : (now - M.last) / 1000;
  M.last = now;
  M.T = Math.min(run.time_max, (M.T ?? run.time_min) + Math.min(dt, 0.5) * M.speed);
  renderMapView({ panels: false });
  if (M.T >= run.time_max) stopPlay();
}
function stopPlay() { if (M.timer) clearInterval(M.timer); M.timer = null; M.last = null; const b = $("#playKey"); if (b) b.textContent = "Play"; }
function play() {
  const run = state.run;
  if (!run || run.mode !== "yyz") return;
  if (M.timer) { stopPlay(); return; }
  if ((M.T ?? 0) >= run.time_max - 1) M.T = run.time_min;
  M.timer = setInterval(frame, 33);
  $("#playKey").textContent = "Pause";
}
function setView(v) {
  if (v === "map" && (!state.run || state.run.mode !== "yyz")) v = "timeline";
  M.view = v;
  $$(".vbtn[data-view]").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  document.body.classList.toggle("mode-map", v === "map");
  document.body.classList.toggle("mode-timeline", v === "timeline");
  $("#mapview").classList.toggle("hidden", v !== "map");
  $("#timelineView").classList.toggle("hidden", v !== "timeline");
  if (v === "map") { if (M.map) M.map.invalidateSize(); renderMapView(); }
  else { stopPlay(); state.ppm = null; renderTimeline(); }
}
window.onTab = name => {
  const how = name === "how";
  $("#drawer").classList.toggle("hidden", !how);
  if (!how) $("#pane-how").classList.remove("hidden");
};
function closeDrawer() { $("#drawer").classList.add("hidden"); $$(".tab").forEach(t => t.classList.remove("active")); }

window.onRender = why => {
  const run = state.run;
  if (!run) return;
  const mapBtn = $('.vbtn[data-view="map"]');
  mapBtn.disabled = run.mode !== "yyz";
  mapBtn.title = run.mode === "yyz" ? "" : "The map needs real airport geometry: pick the Pearson scenario";
  if (why === "all" && M.lastRun !== run.run_id) {
    M.lastRun = run.run_id;
    stopPlay();
    renderHealth(run);
    const slider = $("#mapTime");
    slider.min = Math.floor(run.time_min);
    slider.max = Math.ceil(run.time_max);
    M.T = run.ticks[state.tick].time;
    syncPlanBanner(run);
    if (M.linked) { setView(run.mode === "yyz" ? "map" : "timeline"); return; }   // switching plans: keep the view
    M.linked = true;
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("t")) { const [hh, mm] = q.get("t").split(":").map(Number); M.T = hh * 60 + mm; }
    if (q.get("speed")) M.speed = Number(q.get("speed"));
    setView(run.mode === "yyz" ? "map" : "timeline");
    // deep links for the demo: #rtab=res opens Gates & resources, #sel=ACA1557 selects a flight (callsign or id),
    // #plan=greedy plays the greedy-rules plan
    if (q.get("rtab")) showRTab(q.get("rtab"));
    if (q.get("sel") && run.mode === "yyz") {
      const s = q.get("sel"), tk = run.ticks[tickAt(run, M.T)];
      const fid = Object.keys(tk.flights || {}).find(f => f === s || callsign(f) === s || (tk.flights[f].label || "") === s);
      if (fid) select(fid);
    }
    if (q.get("zoom") === "gates") setTimeout(() => zoomToGates(run), 400);   // after the home fit settles
    if (q.get("plan") === "greedy" && run.mode === "yyz") { showPlan("greedy").then(() => { if (q.get("play") === "1") play(); }); return; }
    if (q.get("play") === "1" && run.mode === "yyz") play();
    return;
  }
  if (why === "tick" || (M.T != null && tickAt(run, M.T) !== state.tick)) M.T = run.ticks[state.tick].time;
  if (why === "select") M.arrowsFor = null;
  if (M.view === "map") renderMapView();
};

$$(".vbtn[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
$("#playKey").addEventListener("click", play);
$$("#speedKeys [data-speed]").forEach(b => b.addEventListener("click", () => { M.speed = Number(b.dataset.speed); if (!M.timer) play(); else renderClock(state.run, traffic(state.run, M.T), M.T); }));
$("#mapTime").step = "any";
$("#mapTime").addEventListener("input", e => { stopPlay(); M.T = Number(e.target.value); renderMapView(); });
$("#drawerClose").addEventListener("click", closeDrawer);
$("#homeKey").addEventListener("click", () => { if (M.map && M.home) M.map.fitBounds(M.home, PAD); });
document.addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); play(); }
  else if (e.key === "Escape") { closeDrawer(); if (state.selected) { state.selected = null; renderWhy(); M.arrowsFor = null; renderMapView(); } }
});

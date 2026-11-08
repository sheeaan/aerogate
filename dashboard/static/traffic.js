"use strict";
/* Ground traffic model for the Pearson surface display.

   1. West flow, the usual Pearson setup: land on 24R and 24L, depart from 23.
      AeroGate's plan gives each arrival a gate-in time; touchdowns are worked back
      from it, and each landing goes to the runway that gets it to its gate soonest
      (equal: the runway idle longest). Spacing is by wake category (3 / 4 / 5 NM) on
      each runway, landings on the two parallels are at least 0.65 min apart, and
      24R landings leave a gap for the 24L arrivals that must cross it.
   2. Ground movement is a small time-stepped simulation (3 s steps):
        - an aircraft never moves into the one ahead of it on its route (105 m gap)
        - at merges and crossings, the aircraft that started moving later gives way
        - meeting head-on, the one giving way pulls aside until the other has passed
        - 24L arrivals hold short of 24R until the last 24R landing has turned off
          and the next is more than 0.8 min out
        - departures queue nose-to-tail at the 23 holding point and line up 1.5 min
          apart (2 min behind a heavy)
   Results (in-block, take-off times, every position) are cached per plan update.
   Uses tickPlan() and state from app.js. */

const AC_LENGTH = { E75: 31.7, "73G": 33.6, "7M8": 39.5, "321": 44.5, "789": 62.8, "333": 63.7, "77W": 73.9, "76F": 54.9 };
const ICAO_TYPE = { E75: "E75L", "73G": "B737", "7M8": "B38M", "321": "A321", "789": "B789", "333": "A333", "77W": "B77W", "76F": "B763" };
const WAKE = { E75: "M", "73G": "M", "7M8": "M", "321": "M", "789": "H", "333": "H", "77W": "H", "76F": "H" };
const CALLSIGN = { AC: "ACA", WS: "WJA", PD: "POE", F8: "FLE", UA: "UAL", AA: "AAL", DL: "DAL", BA: "BAW", LH: "DLH",
  EK: "UAE", KL: "KLM", AF: "AFR", LX: "SWR", FX: "FDX", TK: "THY", QK: "JZA" };
const SEATS = { E75: 76, "73G": 126, "7M8": 169, "321": 190, "789": 298, "333": 297, "77W": 400 };
const BAGS_PER_PAX = { domestic: 0.75, transborder: 0.85, international: 1.25, cargo: 0 };
const LOAD_FACTOR = 0.85;
const ZONE_TAG = { domestic: "DOM", transborder: "USA", international: "INT", cargo: "CGO" };
const SPEED = { approach: 4300, taxi: 480, stand: 110, push: 70 };     // metres per minute
const KT = { APP: 140, TXI: 16, TXO: 16, STD: 4, PSH: 3, LUP: 8, CLB: 175 };
const SIM_DT = 0.05;              // minutes per simulation step (3 s)
const CONFLICT_R = 60;            // metres: closer than this = conflict
const ASIDE_M = 60;               // metres an aircraft pulls aside to let another pass head-on
const FOLLOW_M = 105;             // metres an aircraft stops short of the one ahead in the same direction
const ROLLOUT = 1.1;              // minutes from touchdown to the runway exit
const ARR_STAGGER = 0.65;         // minutes between landings on the two parallels (about 1.5 NM)
const XING_SPACING = 2.6;         // minutes between landings on a runway others must cross, so a crossing fits between
const XING_BEFORE = 0.8;          // no crossing once a landing is this many minutes from touchdown (about 2 NM)

const callsign = fid => { const [c, n] = fid.split("-"); return (CALLSIGN[c] || c) + n; };
const icao = info => ICAO_TYPE[info.aircraft] || info.aircraft || "----";
const wakeOf = info => WAKE[info.aircraft] || "M";
const arrSepNM = (lead, follow) => (lead === "H" ? (follow === "H" ? 4 : 5) : 3);
const nmToMin = nm => Math.max(1.4, nm / KT.APP * 60);
const depSepMin = lead => (lead === "H" ? 2 : 1.5);
function bagsFor(info) {
  if (!info || info.category === "cargo") return 0;
  return Math.round((SEATS[info.aircraft] || 150) * LOAD_FACTOR * (BAGS_PER_PAX[info.category] ?? 0.8));
}

/* ---------- geometry (local metres around Pearson) ---------- */
const KY = 110540, KX = 111320 * Math.cos(43.68 * Math.PI / 180);
const dist = (a, b) => Math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * KX);
const bearing = (from, to) => (Math.atan2((to[1] - from[1]) * KX, (to[0] - from[0]) * KY) * 180 / Math.PI + 360) % 360;
const offset = (p, north, east) => [p[0] + north / KY, p[1] + east / KX];
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const zoneOf = g => g.pier || g.group;
function polyLen(line) { let s = 0; for (let i = 1; i < line.length; i++) s += dist(line[i - 1], line[i]); return s; }
function along(line, d) {
  for (let i = 0; i < line.length - 1; i++) {
    const seg = dist(line[i], line[i + 1]);
    if (d <= seg || i === line.length - 2) {
      const f = seg ? Math.max(0, Math.min(1, d / seg)) : 0;
      return { p: [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f], i, hdg: bearing(line[i], line[i + 1]) };
    }
    d -= seg;
  }
  const n = line.length;
  return { p: line[n - 1], i: n - 2, hdg: bearing(line[n - 2], line[n - 1]) };
}
function between(line, d0, d1) { const a = along(line, d0), b = along(line, d1); return [a.p, ...line.slice(a.i + 1, b.i + 1), b.p]; }
function standPose(g, info) {
  const len = AC_LENGTH[info.aircraft] || info.wingspan || 40;
  const nose = along(g.stand.line, 4).p, centre = along(g.stand.line, 4 + len / 2).p;
  return { centre, heading: bearing(centre, nose) };
}
/* a path with cumulative distances for fast lookup */
function makePath(parts) {
  const pts = [];
  for (const part of parts) for (const q of part) if (!pts.length || dist(pts[pts.length - 1], q) > 0.5) pts.push(q);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, L: cum[cum.length - 1] };
}
function at(path, s) {
  const { pts, cum } = path;
  s = Math.max(0, Math.min(path.L, s));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo], f = seg ? (s - cum[lo]) / seg : 0;
  return { p: [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f], hdg: bearing(pts[lo], pts[hi]) };
}
function rest(path, s) {                  // remaining polyline from distance s
  const a = at(path, s);
  let i = 0;
  while (i < path.cum.length && path.cum[i] <= s) i++;
  return [a.p, ...path.pts.slice(i)];
}
/* the OSM shortest path can run past the departure threshold and double back along the runway;
   cut it where it first passes the threshold so the line-up never runs beside the queue */
function taxiOut(g, R) {
  if (g._out) return g._out;
  const line = g.routes.out, end = R.dep.roll[0], L = polyLen(line);
  for (let s = 0; s < L; s += 10) {
    if (dist(along(line, s).p, end) < 45) return (g._out = [...between(line, 0, s), end]);
  }
  return (g._out = line);
}
function segDist(p, a, b) {               // metres from p to segment a-b
  const ax = (a[1] - p[1]) * KX, ay = (a[0] - p[0]) * KY, dx = (b[1] - a[1]) * KX, dy = (b[0] - a[0]) * KY, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function lineDist(p, line) { let m = Infinity; for (let i = 1; i < line.length; i++) m = Math.min(m, segDist(p, line[i - 1], line[i])); return m; }

/* runway crossings: where a path first comes within 30 m of a landing runway other than its own,
   as the hold-short point 60 m before it. Cached on the route, since routes are fixed per gate. */
function crossing(path, R, own) {
  for (let s = 0; s < path.L; s += 10) {
    const p = at(path, s).p;
    for (const rw of R.arrs) if (rw.ref !== own && lineDist(p, rw.line) < 30) return { s: Math.max(0, s - 60), rwy: rw.ref };
  }
  return null;
}
function arrPath(r, hold) { return makePath(hold ? [r.in_hold[0], r.in_hold[1]] : [r.in]); }
function arrCrossing(r, rwy, R, hold) {
  const k = hold ? "_xh" : "_x";
  if (r[k] === undefined) r[k] = crossing(arrPath(r, hold), R, rwy);
  return r[k];
}
function depCrossing(g, R) {
  if (g._xo === undefined) g._xo = crossing(makePath([taxiOut(g, R)]), R, null);
  return g._xo;
}
/* where an arrival waits while its stand is still taken: departures from that stand often taxi out
   along the last stretch of the arrival's route, head-on. Wait just before that shared stretch, at
   least 90 m from the taxi-out route, so the departure can get past. null = no shared stretch. */
function standWait(r, hold, g, R) {
  const k = hold ? "_wh" : "_w";
  if (r[k] !== undefined) return r[k];
  const path = arrPath(r, hold), out = taxiOut(g, R), clear = s => lineDist(at(path, s).p, out);
  let s = path.L - 10;
  while (s > 0 && clear(s) < 80) s -= 10;                      // back to where the routes come together
  if (s >= path.L - 260) return (r[k] = null);                  // short or no shared stretch: wait near the stand as before
  while (s > 0 && clear(s) < 90) s -= 10;
  return (r[k] = s > 0 ? s : null);
}
function closestS(path, p) { let best = 0, bd = Infinity; for (let s = 0; s <= path.L; s += 10) { const d = dist(at(path, s).p, p); if (d < bd) { bd = d; best = s; } } return best; }
/* landing runways that some taxi route crosses (24R, for 24L arrivals) */
function crossedRunways(run) {
  if (run._crossed) return run._crossed;
  const R = run.map.runways, out = new Set();
  for (const g of run.gates) {
    if (!g.routes) continue;
    for (const rw of R.arrs) for (const hold of [false, true]) { const x = arrCrossing(g.routes.arr[rw.ref], rw.ref, R, hold); if (x) out.add(x.rwy); }
    const x = depCrossing(g, R);
    if (x) out.add(x.rwy);
  }
  return (run._crossed = out);
}

/* Holding spots: points on real, unused taxiways (no taxi route or stand within 80 m, no runway within
   150 m, terminal side of the runways; picked by yyz/build_osm_layout.py). An arrival with a gate hold,
   or one that would otherwise wait on the apron for its stand, taxis to one over the OSM taxiway
   network and waits there. Shortest paths: Dijkstra from each spot (runway edges cost x12), cached. */
function holdSpots(run) { return (run.map && run.map.hold_spots) || []; }
function spotTree(run, k) {
  run._trees = run._trees || [];
  if (run._trees[k]) return run._trees[k];
  const G = run.map.taxi_graph, n = G.nodes.length;
  if (!G._adj) { G._adj = Array.from({ length: n }, () => []); for (const [a, b, w] of G.edges) { G._adj[a].push([b, w]); G._adj[b].push([a, w]); } }
  const D = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), heap = [];
  const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const src = run.map.hold_spots[k].node;
  D[src] = 0; push(0, src);
  while (heap.length) {
    const [d, u] = pop();
    if (d > D[u]) continue;
    for (const [v, w] of G._adj[u]) if (d + w < D[v]) { D[v] = d + w; prev[v] = u; push(D[v], v); }
  }
  return (run._trees[k] = { D, prev });
}
function treePath(run, k, node) {                                      // node ... spot k
  const { prev, D } = spotTree(run, k), N = run.map.taxi_graph.nodes, out = [];
  if (!isFinite(D[node])) return null;
  for (let v = node; v !== -1; v = prev[v]) out.push(N[v]);
  return out;
}
/* via spot k: runway exit -> spot, spot -> stand (cached on the route) */
function spotRoute(run, g, rwy, k) {
  const r = g.routes.arr[rwy];
  r._spots = r._spots || [];
  if (r._spots[k] !== undefined) return r._spots[k];
  const p1 = treePath(run, k, r.exit_node), back = treePath(run, k, g.routes.tail_node);
  if (!p1 || !back) return (r._spots[k] = null);
  const p2 = back.reverse().concat([g.stand.line[g.stand.line.length - 1]]);
  return (r._spots[k] = { k, p1, p2, L: polyLen(p1) + polyLen(p2) });
}
function bestSpots(run, g, rwy) {                                      // reachable spots, shortest detour first
  if (!holdSpots(run).length || !run.map.taxi_graph || g.routes.tail_node == null) return [];
  return holdSpots(run).map((_, k) => spotRoute(run, g, rwy, k)).filter(Boolean).sort((a, b) => a.L - b.L);
}

/* holding pads (older layouts without holding spots): spots beside the holding taxiway that no taxi
   route, stand or runway comes within 70 m of */
function holdPads(run) {
  if (run._pads) return run._pads;
  const R = run.map.runways, hp = R.hold_point, hl = run.map.holding_line;
  const lines = [...R.arrs.map(a => a.roll), R.dep.roll];
  for (const g of run.gates) {
    if (g.stand) lines.push(g.stand.line);
    const r = g.routes;
    if (!r) continue;
    if (r.out) lines.push(r.out);
    for (const a of Object.values(r.arr || {})) for (const l of [a.roll, a.in, ...(a.in_hold || [])]) if (l && l.length > 1) lines.push(l);
  }
  const segs = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const d0 = dist(l[i - 1], hp), d1 = dist(l[i], hp);
    if (Math.min(d0, d1) - dist(l[i - 1], l[i]) < 1000) segs.push([l[i - 1], l[i]]);
  }
  const clear = p => { let m = Infinity; for (const [a, b] of segs) { const d = segDist(p, a, b); if (d < m) m = d; } return m; };
  const cands = [];
  for (let d = 0, Lh = polyLen(hl); d <= Lh; d += 25) {
    const a = along(hl, d);
    if (dist(a.p, hp) > 850) continue;
    for (const side of [90, -90]) for (const off of [60, 85, 110, 135]) {
      const h = (a.hdg + side) * Math.PI / 180, p = offset(a.p, Math.cos(h) * off, Math.sin(h) * off), dh = dist(p, hp);
      if (dh < 750) cands.push({ p, hdg: a.hdg, c: clear(p), d: dh });
    }
  }
  const pick = min => {
    const out = [];
    for (const c of cands.filter(c => c.c >= min).sort((a, b) => a.d - b.d)) {
      if (out.every(o => dist(o.p, c.p) >= 95)) out.push(c);
      if (out.length === 12) break;
    }
    return out;
  };
  let pads = pick(70);
  if (pads.length < 6) pads = pick(50);
  return (run._pads = pads);
}

/* ---------- plan -> schedule ---------- */
const TRAFFIC = { cache: new Map() };
function tickAt(run, T) { let idx = 0; run.ticks.forEach((tk, i) => { if (tk.time <= T) idx = i; }); return idx; }

function schedule(run, idx) {
  const key = `${run.run_id}:${idx}:${JSON.stringify(state.overrides[idx] || [])}`;
  if (TRAFFIC.cache.has(key)) return TRAFFIC.cache.get(key);
  const tk = run.ticks[idx], plan = tickPlan(idx), R = run.map.runways;
  const gateById = Object.fromEntries(run.gates.map(g => [g.id, g]));
  const all = [], arrs = [], deps = [];
  for (const [gid, bs] of Object.entries(plan)) {
    const g = gateById[gid];
    if (!g || !g.routes) continue;
    for (const b of bs) {
      const info = tk.flights[b.flight_id];
      if (!info) continue;
      const route = info.route || "";
      const F = { fid: b.flight_id, cs: callsign(b.flight_id), info, g, gid, b, wake: wakeOf(info),
        isArr: !route.startsWith("YYZ"), isDep: !route.endsWith("YYZ"),
        gateIn: b.intervals[0][0], eobt: b.intervals[b.intervals.length - 1][1], park: standPose(g, info) };
      if (F.isArr) {
        const hold = b.hold || 0, entry = polyLen([g.stand.line[g.stand.line.length - 1], F.park.centre]) / SPEED.stand;
        // one option per landing runway, touchdown worked back from the gate-in time
        F.opts = R.arrs.map(rw => {
          const r = g.routes.arr[rw.ref], via = hold ? bestSpots(run, g, rw.ref)[0] : null;
          const taxi = hold ? (via ? via.L : polyLen(r.in_hold[0]) + polyLen(r.in_hold[1])) : polyLen(r.in);
          return { rw, r, td0: F.gateIn - hold - ROLLOUT - taxi / SPEED.taxi - entry };
        });
        F.td0 = Math.min(...F.opts.map(o => o.td0));
        arrs.push(F);
      }
      if (F.isDep) deps.push(F);
      all.push(F);
    }
  }
  // each landing takes the runway that gets it to the gate soonest; equal (within 3 s): the runway idle longest
  const crossed = crossedRunways(run), lastOn = {};
  let lastTd = -Infinity;
  arrs.sort((a, b) => a.td0 - b.td0);
  for (const F of arrs) {
    let best = null;
    for (const o of F.opts) {
      const P = lastOn[o.rw.ref], sep = P ? arrSepNM(P.wake, F.wake) : 0;
      const gap = P ? Math.max(nmToMin(sep), crossed.has(o.rw.ref) ? XING_SPACING : 0) : 0;
      const td = Math.max(o.td0, P ? P.td + gap : -Infinity, lastTd + ARR_STAGGER);
      const c = { o, P, sep, td, late: td - o.td0, idle: P ? P.td : -Infinity };
      if (!best || c.late < best.late - 0.05 || (c.late <= best.late + 0.05 && c.idle < best.idle)) best = c;
    }
    const { o, P } = best;
    Object.assign(F, { rw: o.rw.ref, rt: o.r, roll: o.r.roll, appr: o.rw.approach, td0: o.td0, td: best.td });
    F.appDur = polyLen(F.appr) / SPEED.approach;
    if (P) { F.sepNM = best.sep; F.leader = P.cs; }
    lastOn[F.rw] = F;
    lastTd = Math.max(lastTd, F.td);
  }
  arrs.sort((a, b) => a.td - b.td);
  const sch = { idx, tk, plan, all, arrs, deps, gateById, R };
  simulate(run, sch);
  TRAFFIC.cache.set(key, sch);
  return sch;
}

/* ---------- ground simulation ---------- */
const higher = (a, b) => a.prio < b.prio || (a.prio === b.prio && a.F.fid < b.F.fid);

/* Rules (designed so nothing can gridlock):
   - stop only for things that always clear: the aircraft ahead in the same direction,
     a runway to cross that is in use (hold short), the departure queue, an occupied
     stand, and traffic behind the stand before pushback;
   - everywhere else (crossings, head-on, merges at an angle) the aircraft that started
     later keeps going but moves to a parallel lane while the other passes. */
/* Two passes: the first finds the arrivals that end up waiting for their stand on the apron; the
   second sends those to a holding spot on an unused taxiway instead, like a controller would. */
function simulate(run, sch) {
  const first = simPass(run, sch, new Map(), new Map());
  if (holdSpots(run).length && (first.waits.size || first.holds.size)) simPass(run, sch, first.waits, first.holds);
}
/* spots a route passes within 70 m of (an aircraft holding there would be in the way) */
function spotsPassed(run, sp) {
  if (sp._passes) return sp._passes;
  const line = sp.p1.concat(sp.p2);
  return (sp._passes = new Set(holdSpots(run).map((s, k) => (k !== sp.k && lineDist(s.p, line) < 70 ? k : -1)).filter(k => k >= 0)));
}
function simPass(run, sch, viaSpot, prevHold) {
  for (const F of sch.all) for (const k of ["inBlock", "offBlock", "tot", "standFrom", "standTo", "hsDur", "waitDur", "depLeader", "depSep"]) delete F[k];
  const movers = [], stands = new Map(), spots = holdSpots(run), spotFor = new Map(), booked = [];
  const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
  // holding spots for gate holds and (second pass) stand waits: the shortest detour whose spot is free
  // while it holds there, whose route passes no occupied spot, and that sits on no one else's route.
  // Hold times come from the previous pass when there is one.
  for (const F of sch.arrs.filter(F => (F.b.hold || 0) > 0 || viaSpot.has(F.fid)).sort((a, b) => a.td - b.td)) {
    const opts = bestSpots(run, F.g, F.rw);
    if (!opts.length) continue;
    const planned = (F.b.hold || 0) > 0, seen = prevHold.get(F.fid);
    let pick = null, firstFree = null;
    for (const o of opts) {
      const tArr = F.td + ROLLOUT + polyLen(o.p1) / SPEED.taxi;
      const tLeave = seen ? Math.max(seen[1], tArr + 1) : planned ? F.gateIn + (F.td - F.td0) : Math.max(tArr + 1, viaSpot.get(F.fid) ?? tArr + 5);
      const hold = [(seen ? Math.min(seen[0], tArr) : tArr) - 1.5, tLeave + 1.5], move = [F.td + ROLLOUT, tLeave + (polyLen(o.p2) + 60) / SPEED.taxi];
      const passes = spotsPassed(run, o);
      if (!booked.some(b => b.k === o.k && overlap(hold, b.hold))) firstFree = firstFree || { o, hold, move, passes };
      if (booked.some(b => (b.k === o.k && overlap(hold, b.hold)) || (passes.has(b.k) && overlap(move, b.hold)) || (b.passes.has(o.k) && overlap(hold, b.move)))) continue;
      pick = { o, hold, move, passes };
      break;
    }
    if (!pick && planned) pick = firstFree;             // a planned hold still needs a spot; a stand wait can wait as before
    if (!pick) continue;
    booked.push({ k: pick.o.k, hold: pick.hold, move: pick.move, passes: pick.passes });
    spotFor.set(F.fid, pick.o);
  }
  for (const F of sch.arrs) {
    const r = F.rt, hold = F.b.hold || 0, sp = spotFor.get(F.fid);
    const entry = [F.g.stand.line[F.g.stand.line.length - 1], F.park.centre];
    const path = makePath(sp ? [sp.p1, sp.p2, entry] : hold ? [r.in_hold[0], r.in_hold[1], entry] : [r.in, entry]);
    if (sp && sp._x === undefined) sp._x = crossing(makePath([sp.p1, sp.p2]), sch.R, F.rw);
    const x = sp ? sp._x : arrCrossing(r, F.rw, sch.R, !!hold), w = sp ? null : standWait(r, !!hold, F.g, sch.R);
    const m = { F, kind: "arr", path, ready: F.td + ROLLOUT, sEntry: path.L - polyLen(entry), s: 0,
      sHS: x ? x.s : null, hsRwy: x ? x.rwy : null };
    m.sWait = w != null ? w : Math.max(0, m.sEntry - 250);
    if (sp || hold) {
      m.holdAt = polyLen(sp ? sp.p1 : r.in_hold[0]);
      m.sWait = sp ? m.holdAt : Math.max(m.sWait, m.holdAt);       // the holding spot is clear of every route: wait there
      m.spot = sp ? spots[sp.k] : null;
      m.holdUntil = hold ? F.gateIn + (F.td - F.td0) - (polyLen(sp ? sp.p2 : r.in_hold[1]) + polyLen(entry)) / SPEED.taxi : -Infinity;
    }
    F.arrM = m;
    movers.push(m);
  }
  for (const F of sch.deps) {
    const push = [F.park.centre, F.g.stand.line[F.g.stand.line.length - 1]];
    const path = makePath([push, taxiOut(F.g, sch.R)]);
    const pushLen = polyLen(push), x = depCrossing(F.g, sch.R);
    F.depM = { F, kind: "dep", path, pushLen, s: 0, tail: push[1],
      sHS: x ? pushLen + x.s : null, hsRwy: x ? x.rwy : null, sHP: path.L - 90 };
    movers.push(F.depM);
  }
  const towIns = sch.deps.filter(F => !F.isArr).map(F => ({ F, at: F.gateIn }));
  if (!movers.length) return new Map();
  const occupied = (gid, me) => { const o = stands.get(gid); return o && o !== me ? o : null; };
  const lastDep = new Map();                                       // gate -> the departure that last pushed from it
  // the stand is taken, or the aircraft that just left it hasn't got past the arrival's waiting point yet
  const standBlocked = m => {
    if (occupied(m.F.gid, m.F)) return true;
    const v = lastDep.get(m.F.gid);
    if (!v || v.done || m.s > m.sWait + 1) return false;
    if (m.vacFor !== v) { m.vacFor = v; m.vacS = closestS(v.path, at(m.path, m.sWait).p); }
    return v.s < m.vacS + 40;
  };
  const t0 = Math.floor(Math.min(...movers.map(m => m.kind === "arr" ? m.ready : m.F.eobt - 70), ...towIns.map(x => x.at)));
  const tEnd = Math.max(...movers.map(m => m.kind === "arr" ? m.ready + 240 : m.F.eobt + 180));
  const active = [], pads = holdPads(run), padUse = pads.map(() => null);
  let lastTOT = -Infinity, lastWake = "M", pending = movers.slice();
  // a landing runway can't be crossed from XING_BEFORE before a touchdown until that aircraft has
  // turned off and taxied 120 m clear (the crossings are at the 24R exits); 10 min cap as a backstop
  const runwayBusy = (rwy, T) => sch.arrs.some(F => F.rw === rwy && T > F.td - XING_BEFORE && T < F.td + 10
    && !(F.arrM.done || (F.arrM.st && F.arrM.s > 120)));
  const holdingShort = o => o.cur && o.cur[0] === "HS";
  // out of everyone's way: on a holding pad, or pulled at least 40 m off its route
  const clearOff = o => o.holdingAside && (o.pad || o.onSpot || (o.pos && o.pathPos && dist(o.pos, o.pathPos) > 40));
  const near = (p, r, me, skip) => active.some(o => o !== me && !clearOff(o) && o.pathPos && !(skip && skip(o)) && dist(o.pos || o.pathPos, p) < r);
  // an arrival holding position for a stand never blocks the aircraft that is about to vacate it
  const waitsForMe = (m, o) => m.kind === "dep" && o.waitStand === m.F.gid;
  // taxilane clear: nobody is within r of p now, and nobody on the move will pass it in the next 240 m of their route
  const approaching = (p, r, me) => active.some(o => o !== me && !clearOff(o) && o.path && !waitsForMe(me, o)
    && (dist(o.pos || o.pathPos, p) < r || (o.cur && o.cur[1] > 0 && [60, 120, 180, 240].some(k => dist(at(o.path, Math.min(o.path.L, o.s + k)).p, p) < r))));
  const inFront = (a, b) => {                                   // b is ahead of a along a's route (now or round the bend)
    const dir = at(a.path, a.s).hdg, dirA = at(a.path, Math.min(a.path.L, a.s + 60)).hdg, brg = bearing(a.pathPos, b.pathPos);
    return (angDiff(b.dir, dir) <= 70 || angDiff(b.dir, dirA) <= 70) && (angDiff(brg, dir) < 70 || angDiff(brg, dirA) < 70);
  };

  /* the aircraft ahead of m in the same direction, if moving to sNext would close on it */
  const ahead = (m, sNext) => {
    const pN = at(m.path, sNext).p, look = at(m.path, Math.min(m.path.L, sNext + 60)), pL = look.p, dir = at(m.path, m.s).hdg, dirA = look.hdg;
    const dirB = at(m.path, Math.min(m.path.L, sNext + 120)).hdg;   // a turn onto another aircraft's taxiway, seen early enough to stop
    for (const o of active) {
      if (o === m || clearOff(o) || !o.pathPos || waitsForMe(m, o)) continue;
      const dC = dist(m.pathPos, o.pathPos);
      if (dC > 240) continue;
      // where o is now and, if it is moving, about 4 s on (so a merge is seen before o is alongside)
      const oF = o.gsPrev && o.path ? at(o.path, Math.min(o.path.L, o.s + 30)).p : o.pathPos;
      const dN = Math.min(dist(pN, o.pathPos), dist(pN, oF)), dL = Math.min(dist(pL, o.pathPos), dist(pL, oF));
      const queueing = m.kind === "dep" && o.kind === "dep" && m.s > m.sHP - 400 && o.s > o.sHP - 400;
      if (Math.min(dN, dL) > (queueing ? 130 : FOLLOW_M)) continue;
      if (dN >= dC - 0.01 && dL >= dC - 0.01) continue;              // not closing in
      if (o.kind === "dep" && (o.st === "push" || o.st === "start")) return o;   // pushback in progress blocks the taxilane for a minute
      // near the 24L holding point every departure joins one queue, ordered by distance to the runway
      if (m.kind === "dep" && o.kind === "dep" && m.s > m.sHP - 400 && o.s > o.sHP - 400) {
        if (o.path.L - o.s < m.path.L - m.s || (o.path.L - o.s === m.path.L - m.s && higher(o, m))) return o;
        continue;
      }
      // same direction now or just round the bend; anything else is a crossing and lanes handle it
      if (angDiff(o.dir, dir) > 70 && angDiff(o.dir, dirA) > 70 && angDiff(o.dir, dirB) > 70) continue;
      const brg = bearing(m.pathPos, o.pathPos);
      let front = dC < 5 ? higher(o, m) : angDiff(brg, dir) < 70 || angDiff(brg, dirA) < 70 || angDiff(brg, dirB) < 70;
      if (front && dC >= 5 && !higher(o, m) && inFront(o, m)) front = false;   // each sees the other ahead: priority goes first
      if (front) return o;
    }
    return null;
  };
  // will m and o come within 75 m of each other at an angle in the next ~15 s (paths can bend into a head-on)
  const meetSoon = (m, o) => {
    for (const k of [40, 80, 120]) {
      const a = at(m.path, Math.min(m.path.L, m.s + k)), b = o.gsPrev ? at(o.path, Math.min(o.path.L, o.s + k)) : { p: o.pos || o.pathPos, hdg: o.dir };
      if (dist(a.p, b.p) < 75 && angDiff(a.hdg, b.hdg) >= 70) return true;
    }
    return false;
  };
  const advance = (m, v, phase, kt, hdg) => {
    // a stopped aircraft does not pull out in front of one that is about to pass it
    if (m.gsPrev === 0 && active.some(o => o !== m && o.gsPrev > 0 && !o.holdingAside && meetSoon(m, o))) { m.stopped += SIM_DT; m.cur = ["HPS", 0, hdg]; return; }
    const sNext = Math.min(m.path.L, m.s + v * SIM_DT);
    if (m.stuck < 6 && ahead(m, sNext)) { m.stuck += SIM_DT; m.stopped += SIM_DT; m.cur = [m.kind === "dep" && m.s > m.sHP - 600 ? "QUE" : "HPS", 0, hdg]; return; }
    m.stuck = 0;
    m.s = sNext;
    m.cur = [phase, kt, hdg];
  };

  for (let T = t0; T <= tEnd && (pending.length || active.length || towIns.length); T += SIM_DT) {
    for (let i = towIns.length - 1; i >= 0; i--) {
      const x = towIns[i];
      if (T >= x.at && !occupied(x.F.gid, x.F)) { stands.set(x.F.gid, x.F); x.F.standFrom = T; towIns.splice(i, 1); }
    }
    for (const m of pending.slice()) {
      let ready;
      // turning off the runway: traffic holding short on the far side doesn't block the exit
      if (m.kind === "arr") ready = T >= m.ready && !near(m.path.pts[0], 110, m, holdingShort);
      else {
        const A = m.F.arrM, onStand = stands.get(m.F.gid) === m.F;
        ready = onStand && T >= Math.max(m.F.eobt, A ? A.doneT + 20 : (m.F.standFrom ?? Infinity) + 10)
          && !approaching(m.tail, 110, m)
          && !active.some(o => o.kind === "dep" && (o.st === "push" || o.st === "start") && dist(o.tail, m.tail) < 150);   // one pushback at a time per alley
      }
      if (!ready) continue;
      pending = pending.filter(x => x !== m);
      const p0 = at(m.path, 0);
      Object.assign(m, { st: m.kind === "arr" ? "taxi" : "push", prio: T, aside: 0, asideT: 0, stopped: 0, stuck: 0, hs: 0,
        pathPos: p0.p, dir: p0.hdg, smp: { t0: T, lat: [], lon: [], hdg: [], ph: [], gs: [], s: [] } });
      if (m.kind === "dep") { m.F.offBlock = T; lastDep.set(m.F.gid, m); }
      active.push(m);
    }
    active.sort((a, b) => a.prio - b.prio);

    // 1) move everyone along their own route
    for (const m of active) {
      m.cur = null;
      if (m.kind === "arr") {
        // gate hold or stand wait on a holding spot (or, older layouts, a pad); stay while the stand is still busy
        if (m.holdAt != null && m.s >= m.holdAt - 0.5 && (T < m.holdUntil || ((m.spot || m.holdingAside) && standBlocked(m)))) {
          if (m.holdStart == null) {
            m.holdStart = T;
            if (!m.spot) { const k = padUse.indexOf(null); if (k >= 0) { padUse[k] = m; m.pad = pads[k]; m.padK = k; } }
          }
          m.holdingAside = true; m.onSpot = !!m.spot; m.waitStand = m.F.gid; m.cur = ["HLD", 0];
          continue;
        }
        if (m.holdingAside) { m.holdingAside = false; m.onSpot = false; m.holdEnd = T; if (m.padK != null) padUse[m.padK] = null; }
        if (m.sHS != null && !m.crossed && m.s >= m.sHS - 0.5) {      // hold short of the other landing runway
          if (runwayBusy(m.hsRwy, T)) { m.hs += SIM_DT; m.stopped += SIM_DT; m.cur = ["HS", 0]; continue; }
          m.crossed = true;
        }
        if (m.s >= m.path.L - 0.5) { m.done = true; m.doneT = T; m.F.inBlock = T; continue; }
        const blocked = !m.onStand && standBlocked(m);
        if (blocked && m.s >= m.sWait - 0.5) {
          // stand not free yet: hold clear of its taxi-out, pulled aside as far as the parked aircraft allow
          // (the second pass sends these to a holding spot instead)
          m.waitStand = m.F.gid; m.stopped += SIM_DT; m.standWait = (m.standWait || 0) + SIM_DT; m.standWaitEnd = T + SIM_DT;
          if (m.s < m.sWait + 1) { m.holdingAside = true; if (m.holdStart == null) m.holdStart = T; m.cur = ["HLD", 0]; }
          else m.cur = ["HPS", 0];
          continue;
        }
        m.waitStand = null;
        if (!m.onStand && m.s >= m.sEntry - 150 && m.s < m.sEntry - 2) {
          const tail = m.path.pts[m.path.pts.length - 2];
          if (active.some(o => o !== m && o.kind === "dep" && (o.st === "push" || o.st === "start") && o.pathPos && dist(o.pathPos, tail) < 120)) {
            m.stopped += SIM_DT; m.cur = ["HPS", 0]; continue;                // a neighbour is pushing back behind the stand
          }
        }
        if (m.s >= m.sEntry - 2 && !m.onStand) {
          stands.set(m.F.gid, m.F); m.onStand = true;
        }
        const entering = m.s >= m.sEntry - 2;
        let v = m.sHS != null && !m.crossed ? Math.max(0, Math.min(SPEED.taxi, (m.sHS - m.s) / SIM_DT + 1e-6)) : SPEED.taxi;
        if (blocked && m.s < m.sWait) v = Math.min(v, (m.sWait - m.s) / SIM_DT + 1e-6);   // stop on the waiting point, not past it
        advance(m, entering ? SPEED.stand : v, entering ? "STD" : "TXI", entering ? KT.STD : KT.TXI);
        continue;
      }
      if (m.st === "push") {
        if (m.s >= m.pushLen - 0.5) { m.st = "start"; m.startUntil = T + 0.6; }
        else { m.s = Math.min(m.pushLen, m.s + SPEED.push * SIM_DT); m.cur = ["PSH", KT.PSH, (at(m.path, m.s).hdg + 180) % 360]; continue; }
      }
      if (m.st === "start") {
        if (T < m.startUntil) { m.cur = ["PSH", 0, (at(m.path, Math.max(0, m.pushLen - 1)).hdg + 180) % 360]; continue; }
        m.st = "taxi";
      }
      if (stands.get(m.F.gid) === m.F && m.s > m.pushLen + 45) stands.delete(m.F.gid);
      if (m.st === "taxi" || m.st === "hs") {
        if (m.sHS != null && !m.crossed && m.s >= m.sHS - 0.5) {
          if (runwayBusy(m.hsRwy, T)) { m.st = "hs"; m.hs += SIM_DT; m.cur = ["HS", 0]; continue; }
          m.crossed = true; m.st = "taxi";
        }
        if (m.s >= m.sHP - 0.5) m.st = "que";
        else {
          const hp = at(m.path, m.sHP).p;
          if (m.s > m.sHP - 110 && active.some(o => o !== m && o.kind === "dep" && (o.st === "lup" || o.st === "que") && dist(o.pathPos, hp) < 85)) {
            m.cur = ["QUE", 0]; continue;                                     // the one ahead is still lining up
          }
          const lim = m.sHS != null && !m.crossed ? m.sHS : m.sHP;
          advance(m, Math.max(0, Math.min(SPEED.taxi, (lim - m.s) / SIM_DT + 1e-6)), "TXO", KT.TXO);
          continue;
        }
      }
      if (m.st === "que") {
        if (T >= lastTOT + depSepMin(lastWake) - 0.8) { m.st = "lup"; m.F.tot = T + 0.8; lastTOT = m.F.tot; lastWake = m.F.wake; }
        else { m.cur = ["QUE", 0]; continue; }
      }
      if (m.st === "lup") {
        if (T >= m.F.tot) { m.done = true; m.doneT = T; continue; }
        m.s = Math.min(m.path.L, m.s + (m.path.L - m.sHP) / 0.8 * SIM_DT);
        m.cur = ["LUP", KT.LUP, m.s > m.path.L - 15 ? bearing(sch.R.dep.roll[0], sch.R.dep.roll[1]) : null];
      }
    }
    for (let i = active.length - 1; i >= 0; i--) if (active[i].done) active.splice(i, 1);
    for (const m of active) { const p = at(m.path, m.s); m.pathPos = p.p; m.dir = p.hdg; }

    // 2) lanes: near traffic with priority that is not simply ahead or behind, step to a parallel lane.
    //    A stopped aircraft keeps its lane; whoever is moving goes round it, on the side away from parked aircraft.
    const parked = [...stands.values()].map(F => F.park.centre).concat(pads.map(q => q.p), spots.map(q => q.p));   // parked aircraft, pads, spots
    const shift = (p, v) => (v ? [p[0] + v[0], p[1] + v[1]] : p);
    const laneSide = (m, o, oPos) => {
      // judge the side where the two will be closest, not where they are now (routes bend)
      let km = { p: m.pathPos, hdg: m.dir }, ko = oPos, dMin = dist(m.pathPos, oPos);
      if (!o.holdingAside) for (const k of [40, 80, 120, 160]) {
        const a = at(m.path, Math.min(m.path.L, m.s + k)), b = o.cur && o.cur[1] ? shift(at(o.path, Math.min(o.path.L, o.s + k)).p, o.offV) : oPos;
        if (dist(a.p, b) < dMin) { dMin = dist(a.p, b); km = a; ko = b; }
      }
      let best = 90, score = -1;
      for (const side of [90, -90]) {
        const a = (km.hdg + side) * Math.PI / 180, q = offset(km.p, Math.cos(a) * ASIDE_M, Math.sin(a) * ASIDE_M);
        const h = (m.dir + side) * Math.PI / 180, q0 = offset(m.pathPos, Math.cos(h) * ASIDE_M, Math.sin(h) * ASIDE_M);
        const s = parked.reduce((v, c) => Math.min(v, dist(q, c), dist(q0, c)), dist(q, ko));
        if (s > score) { score = s; best = side; }
      }
      return best;
    };
    for (const m of active) {
      if (!m.cur) continue;
      const ph = m.cur[0], stopped = !m.cur[1] && ph !== "HLD" && ph !== "QUE";
      let want = m.holdingAside && !m.onSpot ? 1 : stopped ? m.asideT : 0;   // on a holding spot: stay on the taxiway centreline
      if (!want && !stopped && ph !== "PSH" && ph !== "STD" && ph !== "LUP") {
        for (const o of active) {
          if (o === m || !o.pathPos || (o.holdingAside && (o.pad || o.onSpot))) continue;   // pads and spots are clear of every route
          const oPos = o.holdingAside ? o.pos : shift(o.pathPos, o.offV);           // where it is actually drawn, lane offset included
          if (!oPos) continue;
          const d = dist(m.pathPos, oPos);
          const trigger = o.holdingAside ? d < 80                                       // passing a holding pad
            : (o.st === "lup" && m.kind === "dep") ? d < 75                               // aircraft lining up ahead
            : (higher(o, m) || (o.cur && !o.cur[1] && o.cur[0] !== "PSH")) && ((d <= 160 && angDiff(o.dir, m.dir) >= 70) || meetSoon(m, o));   // crossing or head-on
          if (!trigger) continue;
          want = 1;
          if (m.aside < 0.05) m.side = laneSide(m, o, oPos);
          break;
        }
      }
      m.asideT = want;
      const prev = m.pos, toPad = m.pad ? dist(m.pathPos, m.pad.p) : 0;
      const rate = SIM_DT / Math.max(0.09, toPad / SPEED.taxi);
      m.aside += Math.sign(m.asideT - m.aside) * Math.min(Math.abs(m.asideT - m.aside), rate);
      let pos = m.pathPos, hdgPad = null;
      if (m.pad && (m.holdingAside || m.aside > 0.001)) {              // gliding to, sitting on, or leaving a holding pad
        const f = m.aside;
        pos = [pos[0] + (m.pad.p[0] - pos[0]) * f, pos[1] + (m.pad.p[1] - pos[1]) * f];
        hdgPad = f > 0.999 ? m.pad.hdg : prev && dist(prev, pos) > 0.5 ? bearing(prev, pos) : null;
        if (!m.holdingAside && m.aside <= 0.001) m.pad = null;
      } else if (m.aside > 0.001) {
        let side = m.side || 90;
        if (ph === "HLD") {                                             // no free pad: the side away from the terminal
          const a = (m.dir + 90) * Math.PI / 180, test = offset(pos, Math.cos(a) * 75, Math.sin(a) * 75);
          side = dist(test, run.map.center) > dist(pos, run.map.center) ? 90 : -90;
        }
        const h = (m.dir + side) * Math.PI / 180, full = (ph === "HLD" ? 75 : ASIDE_M) * m.aside;
        let d = full;                                                    // never step to within 45 m of a parked aircraft or pad
        for (const f of [1, 0.75, 0.5, 0.25, 0]) {
          d = full * f;
          const q = offset(pos, Math.cos(h) * d, Math.sin(h) * d);
          if (!f || parked.every(c => dist(q, c) >= 45)) break;
        }
        pos = offset(pos, Math.cos(h) * d, Math.sin(h) * d);
      }
      m.pos = pos; m.gsPrev = m.cur[1]; m.offV = [pos[0] - m.pathPos[0], pos[1] - m.pathPos[1]];
      const k = m.smp, [phase, gs, hdg] = m.cur;
      k.lat.push(pos[0]); k.lon.push(pos[1]); k.hdg.push(hdgPad ?? hdg ?? m.dir); k.ph.push(phase); k.gs.push(gs); k.s.push(m.s);
    }
    for (const F of sch.arrs) if (!F.isDep && F.arrM.done && stands.get(F.gid) === F && T >= Math.max(F.eobt, F.inBlock + 30)) { stands.delete(F.gid); F.standTo = T; }
  }
  for (const m of movers) {
    if (m.kind === "arr" && m.F.inBlock == null) m.F.inBlock = m.smp ? m.smp.t0 + m.smp.s.length * SIM_DT : Infinity;
    if (m.kind === "arr") m.F.hsDur = m.hs || 0;
    if (m.kind === "dep") { if (m.F.offBlock == null) m.F.offBlock = Infinity; if (m.F.tot == null) m.F.tot = Infinity; m.F.hsDur = m.hs || 0; }
    m.F.waitDur = m.stopped || 0;
  }
  const byTot = sch.deps.filter(F => isFinite(F.tot)).sort((a, b) => a.tot - b.tot);
  byTot.forEach((F, i) => { if (i) { F.depLeader = byTot[i - 1].cs; F.depSep = depSepMin(byTot[i - 1].wake); } });
  // arrivals that waited 45 s or more for their stand on the apron: next pass, send them to a holding spot;
  // and when each spot holder actually arrived at and left its spot
  const waits = new Map(viaSpot), holds = new Map();
  for (const F of sch.arrs) {
    const m = F.arrM;
    if ((m.standWait || 0) >= 0.75 && !spotFor.has(F.fid)) waits.set(F.fid, m.standWaitEnd);
    if (m.spot && m.holdStart != null) holds.set(F.fid, [m.holdStart, m.holdEnd ?? Infinity]);
  }
  return { waits, holds };
}

/* ---------- where is a flight at minute T ---------- */
function sampleAt(m, T) {
  const k = m.smp;
  if (!k || !k.lat.length) return null;
  const x = (T - k.t0) / SIM_DT, i = Math.max(0, Math.min(k.lat.length - 1, Math.floor(x))), j = Math.min(k.lat.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, x - i));
  const hd = k.hdg[i] + ((((k.hdg[j] - k.hdg[i]) % 360) + 540) % 360 - 180) * f;
  return { p: [k.lat[i] + (k.lat[j] - k.lat[i]) * f, k.lon[i] + (k.lon[j] - k.lon[i]) * f], hdg: hd, phase: k.ph[i], gs: k.gs[i], s: k.s[i] };
}

function poseAt(run, F, T) {
  const R = run.map.runways;
  if (F.isArr && T < F.inBlock) {
    if (T < F.td - F.appDur) return null;
    if (T < F.td) {
      const L = polyLen(F.appr), a = along(F.appr, (T - (F.td - F.appDur)) / F.appDur * L);
      return { phase: "APP", p: a.p, hdg: a.hdg, gs: KT.APP, kind: "arr", to: F.gid, rwy: F.rw, route: [between(F.appr, (T - (F.td - F.appDur)) / F.appDur * L, L), F.roll, F.arrM.path.pts] };
    }
    if (T < F.td + ROLLOUT || !F.arrM.smp || T < F.arrM.smp.t0) {
      const f = Math.min(1, (T - F.td) / ROLLOUT), L = polyLen(F.roll), d = (1 - (1 - f) * (1 - f)) * L, a = along(F.roll, d);
      return { phase: "LDG", p: a.p, hdg: a.hdg, gs: Math.round(130 * (1 - f) + 20), kind: "arr", to: F.gid, rwy: F.rw, route: [between(F.roll, d, L), F.arrM.path.pts] };
    }
    const s = sampleAt(F.arrM, T);
    if (!s) return null;
    return { ...s, kind: s.phase === "HLD" ? "hold" : "arr", to: F.gid, hsRwy: F.arrM.hsRwy, route: s.phase === "HLD" ? null : [rest(F.arrM.path, s.s)],
      waited: s.phase === "HLD" ? Math.round(T - (F.arrM.holdStart ?? T)) : null };
  }
  const parkFrom = F.isArr ? F.inBlock : (F.standFrom ?? Infinity), parkTo = F.isDep ? F.offBlock : (F.standTo ?? Math.max(F.eobt, F.inBlock + 30));
  if (T >= parkFrom && T < parkTo) return { phase: "STD", p: F.park.centre, hdg: F.park.heading, gs: 0, kind: "stand" };
  if (!F.isDep || T < F.offBlock) return null;
  if (T < F.tot) {
    const s = sampleAt(F.depM, T);
    if (!s) return null;
    return { ...s, kind: "dep", to: R.dep.ref, hsRwy: F.depM.hsRwy, route: s.phase === "PSH" ? null : [rest(F.depM.path, s.s)] };
  }
  if (T < F.tot + 0.9) {
    const f = (T - F.tot) / 0.9, L = polyLen(R.dep.roll), a = along(R.dep.roll, f * f * L);
    return { phase: "DEP", p: a.p, hdg: a.hdg, gs: Math.round(160 * f), kind: "dep", to: R.dep.ref };
  }
  if (T < F.tot + 2.1) {
    const f = (T - F.tot - 0.9) / 1.2, L = polyLen(R.dep.climb), a = along(R.dep.climb, f * L);
    return { phase: "CLB", p: a.p, hdg: a.hdg, gs: KT.CLB, kind: "dep", to: R.dep.ref };
  }
  return null;
}

/* every aircraft visible at minute T */
function traffic(run, T) {
  const sch = schedule(run, tickAt(run, T));
  const items = [];
  for (const F of sch.all) {
    const s = poseAt(run, F, T);
    if (s) items.push({ F, ...s });
  }
  // landed with no gate at all yet: wait on a holding pad (taken from the far end of the list,
  // so they never share one with the gate holds the simulation hands out from the near end)
  const placed = new Set(sch.all.map(F => F.fid)), pads = holdSpots(run).length ? holdSpots(run) : holdPads(run);
  const hl = run.map.holding_line;
  let slot = 0;
  for (const [fid, info] of Object.entries(sch.tk.flights || {})) {
    if (placed.has(fid) || !info.intervals.length || (info.route || "").startsWith("YYZ") || info.intervals[0][0] > T) continue;
    let pad = pads[pads.length - 1 - slot++];
    if (!pad) {
      const a = along(hl, 200 + slot * 90), h = (a.hdg + 90) * Math.PI / 180;
      pad = { p: offset(a.p, Math.cos(h) * 70, Math.sin(h) * 70), hdg: a.hdg };
    }
    items.push({ F: { fid, cs: callsign(fid), info, gid: null, wake: wakeOf(info) }, phase: "HLD", kind: "hold",
      p: pad.p, hdg: pad.hdg, gs: 0, waited: Math.round(T - info.intervals[0][0]), to: null });
  }
  // runway lights: lit while a landing or take-off is on it; stop bars red while crossing is not allowed
  const R = sch.R, lit = {}, red = {};
  for (const rw of R.arrs) {
    lit[rw.ref] = sch.arrs.some(F => F.rw === rw.ref && T >= F.td - 1.0 && T < F.td + 0.9);
    red[rw.ref] = sch.arrs.some(F => F.rw === rw.ref && T > F.td - XING_BEFORE && T < F.td + ROLLOUT + 0.25);
  }
  lit[R.dep.ref] = sch.deps.some(F => T >= F.tot - 0.8 && T < F.tot + 0.9);
  return { sch, items, lit, red };
}

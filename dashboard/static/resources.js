"use strict";
/* Gates & resources (Pearson map): where each flight could go, and ground crew and baggage at each pier.

   Crew and baggage numbers are ESTIMATES for display; the planner does not use them.
   - Ramp crews per pier (PIERS, staffed to the evening's peak). A turn needs 1 crew (2 for a
     widebody) from in-block until 25 min after (40 widebody), and from 35 min before off-block
     (50 widebody) until 5 min after; a short turn keeps the same crew throughout.
   - Baggage: each pier's make-up/reclaim belts handle 1200 bags/h each. Arriving bags are unloaded
     over the 45 min after in-block, departing bags made up over the 150 min before off-block.
   Uses globals from app.js (h, $, $$, state, fmt, select, auditFor, gateOf, tickPlan) and traffic.js. */

const PIERS = {
  D: { name: "Pier D", short: "D", crews: 14, belts: 2 },
  F: { name: "Pier F", short: "F", crews: 6, belts: 1 },
  E: { name: "Pier E", short: "E", crews: 16, belts: 4 },
  C: { name: "Cargo West", short: "CGO", crews: 2, belts: 0 },
};
const BELT_PER_H = 1200;
const isWide = info => (info.wingspan || 36) >= 52;

/* crew windows and baggage flows for one plan update (cached on the schedule) */
function resources(run, sch) {
  if (sch._res) return sch._res;
  const jobs = {}, bags = {};
  for (const P of Object.keys(PIERS)) { jobs[P] = []; bags[P] = []; }
  for (const F of sch.all) {
    const P = F.g.pier;
    if (!jobs[P]) continue;
    const wide = isWide(F.info), n = wide ? 2 : 1, b = bagsFor(F.info);
    const tIn = F.isArr ? (isFinite(F.inBlock) ? F.inBlock : F.gateIn) : null;
    const tOut = F.isDep ? (isFinite(F.offBlock) ? F.offBlock : F.eobt) : null;
    const arrJob = tIn != null ? [tIn, tIn + (wide ? 40 : 25)] : null, depJob = tOut != null ? [tOut - (wide ? 50 : 35), tOut + 5] : null;
    if (arrJob && depJob && depJob[0] - arrJob[1] < 20) jobs[P].push([arrJob[0], depJob[1], n, F]);
    else for (const j of [arrJob, depJob]) if (j) jobs[P].push([j[0], j[1], n, F]);
    if (b && tIn != null) bags[P].push([tIn + 5, tIn + 50, b * 60 / 45, F]);      // bags per hour over 45 min
    if (b && tOut != null) bags[P].push([tOut - 170, tOut - 20, b * 60 / 150, F]); // over 150 min
  }
  return (sch._res = { jobs, bags });
}
function crewAt(res, P, T) {
  let used = 0;
  for (const [a, b, n] of res.jobs[P]) if (T >= a && T < b) used += n;
  return { used, total: PIERS[P].crews, free: PIERS[P].crews - used };
}
function bagsAt(res, P, T) {
  let rate = 0;
  for (const [a, b, v] of res.bags[P]) if (T >= a && T < b) rate += v;
  const cap = PIERS[P].belts * BELT_PER_H;
  return { rate: Math.round(rate), cap, pct: cap ? Math.round(100 * rate / cap) : null };
}
function tightest(res, P, T, span = 60) {
  let best = null;
  for (let t = Math.ceil(T / 5) * 5; t <= T + span; t += 5) { const c = crewAt(res, P, t); if (!best || c.free < best.free) best = { t, ...c }; }
  return best;
}
function pierOf(run, gid) { const g = run.gates.find(x => x.id === gid); return g && g.pier; }
const crewCls = free => (free <= 0 ? "bad" : free === 1 ? "warn" : "ok");
const bagCls = pct => (pct == null ? "dim" : pct >= 100 ? "bad" : pct >= 85 ? "warn" : "ok");

/* the selected flight's options: chosen gate and every other gate with its verdict */
function gateOptions(fid) {
  const found = auditFor(fid), plan = tickPlan(), gid = gateOf(plan, fid);
  const out = new Map();
  if (gid) out.set(gid, { verdict: "chosen", text: "planned gate" });
  if (found) for (const a of found.entry.alternatives) if (a.gate !== gid) out.set(a.gate, a);
  if (found && found.entry.gate && found.entry.gate !== gid && !out.has(found.entry.gate)) out.set(found.entry.gate, { verdict: "costlier", text: "the planner's choice before a manual move" });
  return { gid, found, out };
}
/* a rule-breaking reason in a few words, for grouping */
function shortReason(t) {
  const s = t.toLowerCase();
  if (s.includes("customs")) return "needs a customs gate";
  if (s.includes("pre-clear")) return "needs a US pre-clearance gate";
  if (s.includes("cargo stand")) return "freighters use cargo stands";
  if (s.includes("cannot use")) return "wrong gate type";
  if (s.includes("wingspan") && s.includes("exceeds")) return "aircraft too big for the stand";
  if (s.includes("jetbridge")) return "needs a jetbridge";
  if (s.includes("out of service")) return "gate closed";
  return t;
}
const costOf = a => (a.delta != null ? `+${a.delta.toFixed(2)}` : "");

/* ---------- the tab ---------- */
function renderResources(run, tr, T) {
  const pane = $("#pane-res");
  if (!pane || $("#rbody-res").classList.contains("hidden")) return;
  pane.innerHTML = "";
  if (!run || run.mode !== "yyz" || !tr) {
    pane.append(h("div", { class: "hint" }, "Gates & resources needs the Pearson scenario on the Map view."));
    return;
  }
  const res = resources(run, tr.sch);
  if (state.selected) renderFlightOptions(run, tr, T, res, pane);
  else renderBoard(run, tr, T, res, pane);
}

function renderBoard(run, tr, T, res, pane) {
  // piers: one line each, numbers coloured only when tight
  pane.append(h("div", { class: "rs-head" }, h("span", {}, `Piers at ${fmt(T)}`), h("span", { class: "est" }, "estimates")));
  const rows = [h("div", { class: "rs-row th" }, h("span", {}, "PIER"), h("span", {}, "CREWS FREE"), h("span", {}, "BAGS"), h("span", {}, "NEXT 60 MIN"))];
  for (const P of Object.keys(PIERS)) {
    const c = crewAt(res, P, T), b = bagsAt(res, P, T), t = tightest(res, P, T);
    rows.push(h("div", { class: "rs-row" },
      h("span", { class: "pn" }, PIERS[P].short),
      h("span", { class: crewCls(c.free) }, `${Math.max(0, c.free)}/${c.total}`),
      h("span", { class: bagCls(b.pct) }, b.pct == null ? "-" : `${b.pct}%`),
      h("span", { class: t.free <= 1 ? crewCls(t.free) : "dim" }, t.free < 0 ? `short ${-t.free} at ${fmt(t.t)}` : t.free <= 1 ? `${t.free} free at ${fmt(t.t)}` : "ok")));
  }
  pane.append(h("div", { class: "rs-table piers" }, rows));

  // gate options: arrivals in the next hour, planned gate and the two cheapest other legal gates
  pane.append(h("div", { class: "rs-head" }, h("span", {}, "Gate options, next 60 min"), h("span", { class: "est" }, "+pts if moved")));
  const soon = tr.sch.arrs.filter(F => F.gateIn >= T - 5 && F.gateIn <= T + 60).sort((a, b) => a.gateIn - b.gateIn).slice(0, 12);
  const opt = [h("div", { class: "rs-row th opts5" }, h("span", {}, "IN"), h("span", {}, "FLIGHT"), h("span", {}, "GATE"), h("span", {}, "ALT 1"), h("span", {}, "ALT 2"))];
  for (const F of soon) {
    const { gid, out } = gateOptions(F.fid);
    const alts = [...out.entries()].filter(([, a]) => a.verdict === "costlier").sort((a, b) => (a[1].delta ?? 0) - (b[1].delta ?? 0)).slice(0, 2);
    const cell = i => (alts[i] ? h("span", { class: "alt", title: alts[i][1].text }, `${alts[i][0]} `, h("small", {}, costOf(alts[i][1]))) : h("span", { class: "dim" }, "-"));
    opt.push(h("div", { class: `rs-row opts5 click ${state.selected === F.fid ? "sel" : ""}`, tabindex: 0, title: "Show every gate for this flight",
      onclick: () => select(F.fid), onkeydown: e => { if (e.key === "Enter") select(F.fid); } },
      h("span", { class: "dim" }, fmt(F.gateIn)), h("span", { class: "cs" }, F.cs), h("span", { class: "gate" }, gid || "-"), cell(0), cell(1)));
  }
  if (!soon.length) opt.push(h("div", { class: "rs-row" }, h("span", { class: "dim" }, "No arrivals in the next hour.")));
  pane.append(h("div", { class: "rs-table" }, opt));
  pane.append(h("div", { class: "rs-foot" }, "Click a flight to colour its gates on the map. Crews: 1 per turn, 2 for a widebody. Bags: 1,200/h per belt."));
}

function renderFlightOptions(run, tr, T, res, pane) {
  const fid = state.selected, info = (tr.sch.tk.flights || {})[fid];
  const back = () => { state.selected = null; renderWhy(); if (window.onRender) window.onRender("select"); };
  pane.append(h("div", { class: "rs-bar" }, h("button", { class: "hud-key", onclick: back }, "← All flights"),
    typeof M !== "undefined" && M.map ? h("button", { class: "hud-key", onclick: () => zoomToGates(run) }, "Zoom to gates") : null));
  if (!info) { pane.append(h("div", { class: "hint" }, "That flight is not active at this update.")); return; }
  const F = tr.sch.all.find(x => x.fid === fid), when = F ? (F.isArr ? F.gateIn : F.eobt) : T;
  const { gid, out } = gateOptions(fid);
  pane.append(h("div", { class: "rs-flight" }, h("b", {}, F ? F.cs : info.label), ` → `, h("span", { class: "gate" }, gid || "no gate"),
    h("span", { class: "dim" }, `  ${info.aircraft || ""} · ${(CAT[info.category] || info.category || "").replace("US transborder", "transborder")} · ${F && F.isArr ? "in" : "out"} ${fmt(when)}`)));
  pane.append(h("div", { class: "opt-key" }, [["chosen", "planned"], ["costlier", "legal"], ["busy", "taken"]].map(([v, t]) => h("span", {}, h("i", { class: `dot ${v}` }), t))));

  // legal gates: planned first, then cheapest alternatives, with the pier's crews and bags when it gets there
  const legal = [...out.entries()].filter(([, a]) => a.verdict === "chosen" || a.verdict === "costlier")
    .sort((a, b) => (a[1].verdict === "chosen" ? -1 : b[1].verdict === "chosen" ? 1 : (a[1].delta ?? 0) - (b[1].delta ?? 0)));
  const rows = [h("div", { class: "rs-row th opts4" }, h("span", {}, "GATE"), h("span", {}, "+PTS"), h("span", {}, `CREWS ${fmt(when)}`), h("span", {}, "BAGS"))];
  for (const [g, a] of legal) {
    const P = pierOf(run, g), c = P && PIERS[P] ? crewAt(res, P, when) : null, b = P && PIERS[P] ? bagsAt(res, P, when) : null;
    rows.push(h("div", { class: `rs-row opts4 ${a.verdict}`, title: a.text },
      h("span", { class: a.verdict === "chosen" ? "gate" : "alt" }, g), h("span", {}, a.verdict === "chosen" ? "planned" : costOf(a)),
      h("span", { class: c ? crewCls(c.free) : "dim" }, c ? `${PIERS[P].short} ${Math.max(0, c.free)}/${c.total}` : "-"),
      h("span", { class: b ? bagCls(b.pct) : "dim" }, b && b.pct != null ? `${b.pct}%` : "-")));
  }
  pane.append(h("div", { class: "rs-table" }, rows));

  const taken = [...out.entries()].filter(([, a]) => a.verdict === "busy");
  if (taken.length) pane.append(h("div", { class: "rs-line" }, h("b", {}, `Taken (${taken.length}) `),
    taken.map(([g, a]) => h("span", { class: "tk", title: a.text }, g))));
  const rule = [...out.entries()].filter(([, a]) => a.verdict === "rule");
  if (rule.length) {
    const why = new Map();
    for (const [g, a] of rule) { const k = shortReason(a.text); (why.get(k) || why.set(k, []).get(k)).push(g); }
    pane.append(h("div", { class: "rs-line" }, h("b", {}, `Not allowed (${rule.length}) `),
      [...why].map(([t, gs]) => h("span", { class: "nr", title: gs.join(", ") }, `${t} (${gs.length})`))));
  }
}

/* ---------- right-panel tabs ---------- */
function showRTab(name) {
  $$(".rtab").forEach(b => { const on = b.dataset.rtab === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("#rbody-why").classList.toggle("hidden", name !== "why");
  $("#rbody-res").classList.toggle("hidden", name !== "res");
  const lf = $("#leaflet");
  if (lf) lf.classList.toggle("show-res", name === "res");          // pier badges show only with this tab
  if (name === "res") {
    const run = state.run;
    if (run && run.mode === "yyz" && typeof M !== "undefined" && M.view === "map") renderMapView();
    else renderResources(run, null, null);
  }
}
$$(".rtab").forEach(b => b.addEventListener("click", () => showRTab(b.dataset.rtab)));

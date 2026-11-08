"use strict";
/* AeroGate operator dashboard. Plain JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

const CAT = { domestic: "Domestic", international: "International", cargo: "Cargo", transborder: "US transborder" };
const state = {
  scenarios: [], solvers: {}, run: null, baseline: null, tick: 0, selected: null,
  overrides: {}, ppm: null, events: [], compare: null,
};

/* ---------- time ---------- */
const pad = n => String(n).padStart(2, "0");
function fmt(m) {
  if (m == null) return "--:--";
  m = Math.round(m);
  const d = Math.floor(m / 1440), r = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(r / 60))}:${pad(r % 60)}${d ? ` +${d}d` : ""}`;
}
const fmtIvs = ivs => ivs.map(([s, e]) => `${fmt(s)}-${fmt(e)}`).join(", ");
const toMin = v => { const [a, b] = v.split(":").map(Number); return a * 60 + b; };
const toHHMM = m => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`;

/* ---------- api ---------- */
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/* ---------- boot ---------- */
async function init() {
  const data = await api("/api/scenarios");
  state.scenarios = data.scenarios;
  state.solvers = data.solvers;
  const sel = $("#scenario");
  const groups = { sample: "Challenge scenarios", yyz: "Pearson realism layer", generated: "Generated stress tests" };
  for (const [kind, label] of Object.entries(groups)) {
    const items = state.scenarios.filter(s => s.kind === kind);
    if (!items.length) continue;
    sel.append(h("optgroup", { label }, items.map(s => h("option", { value: s.id }, s.name.replaceAll("_", " ")))));
  }
  // the Pearson airfield map is the default view; challenge scenarios stay one click away
  sel.value = state.scenarios.some(x => x.id === "yyz/pearson_evening_bank") ? "yyz/pearson_evening_bank" : "flight_data/busy_day";
  const ssel = $("#solver");
  for (const [id, name] of Object.entries(state.solvers)) ssel.append(h("option", { value: id }, name));
  sel.addEventListener("change", syncSolverLock);
  $("#runForm").addEventListener("submit", e => { e.preventDefault(); runPlan(); });
  $("#zoomIn").addEventListener("click", () => zoom(1.35));
  $("#zoomOut").addEventListener("click", () => zoom(1 / 1.35));
  $$(".tab").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));
  window.addEventListener("resize", () => { fitLayout(); state.ppm = null; renderTimeline(); });
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get("scenario")) sel.value = q.get("scenario");
  if (q.get("solver")) ssel.value = q.get("solver");
  syncSolverLock();
  renderLegend();
  await runPlan();
  // deep links for demos: #scenario=...&tick=2&select=<flight id>&tab=whatif
  if (q.get("tick") != null) { state.tick = Math.min(+q.get("tick"), state.run.ticks.length - 1); renderAll(); }
  if (q.get("select")) select(q.get("select"));
  if (q.get("tab")) showTab(q.get("tab"));
  if (q.get("preset") != null) { const p = presets()[+q.get("preset")]; if (p) { state.events = p.events.slice(); await runPlan(state.events); showTab("whatif"); } }
}

function syncSolverLock() {
  const yyz = $("#scenario").value.startsWith("yyz/");
  $("#solver").disabled = yyz;
  if (yyz) $("#solver").value = "solution_aerogate";
}

function showTab(name) {
  $$(".tab").forEach(t => { const on = t.dataset.tab === name; t.classList.toggle("active", on); t.setAttribute("aria-selected", on); });
  $$(".tabpane").forEach(p => p.classList.toggle("hidden", p.id !== `pane-${name}`));
  if (name === "compare" && !state.compare) loadCompare();
  if (name === "whatif") renderWhatIf();
  if (window.onTab) window.onTab(name);
}

async function runPlan(whatif) {
  const btn = $("#runBtn");
  btn.disabled = true; btn.textContent = whatif ? "Running what-if..." : "Planning...";
  try {
    const run = await api("/api/run", { scenario: $("#scenario").value, solver: $("#solver").value, whatif: whatif || null });
    if (!whatif) { state.baseline = run; state.events = []; }
    state.run = run;
    state.tick = run.ticks.length - 1;
    state.selected = null;
    state.overrides = {};
    state.ppm = null;
    renderAll();
    if (whatif) renderWhatIf();
    else if ($("#pane-whatif") && !$("#pane-whatif").classList.contains("hidden")) renderWhatIf();
  } catch (err) {
    toast(`Could not run the plan: ${err.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = "Run plan";
  }
}

function fitLayout() {
  const bar = $(".bar");
  if (bar) document.documentElement.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
}

const hook = why => { if (window.onRender) window.onRender(why); };

function renderAll() {
  renderResult();
  fitLayout();
  renderTimeline();
  renderStepper();
  renderLog();
  renderWhy();
  hook("all");
}

/* ---------- header result ---------- */
function renderResult() {
  const r = state.run.result, box = $("#result");
  box.innerHTML = "";
  const ok = r.status === "OK";
  box.append(h("span", { class: `sign ${ok ? "loc" : "mand"}` }, ok ? "Valid plan" : "Hard failure"));
  if (ok) {
    const extra = overrideDelta();
    box.append(h("span", { class: "score", title: "Evaluator soft score, lower is better" }, r.score.toFixed(2),
      h("small", {}, extra ? `+${extra.toFixed(2)} manual` : "points")));
  }
  const chips = h("div", { class: "chips" });
  for (const [k, v] of Object.entries(r.breakdown || {}))
    chips.append(h("span", { class: "chip" }, `${k.replaceAll("_", " ")}: ${v.count} = ${v.points.toFixed(1)}`));
  if (r.unassigned && r.unassigned.length) chips.append(h("span", { class: "chip" }, `${r.unassigned.length} ungated`));
  if (state.run.elapsed != null) chips.append(h("span", { class: "chip" }, `${state.run.solver_name}, ${state.run.elapsed}s`));
  if (!ok) chips.append(h("span", { class: "chip", title: r.reason }, r.reason.slice(0, 90)));
  box.append(chips);
}

function renderLegend() {
  const l = $("#legend");
  l.innerHTML = "";
  const items = [["domestic", "var(--dom)"], ["international", "var(--intl)"], ["transborder", "var(--trans)"], ["cargo", "var(--cargo)"]];
  for (const [k, c] of items) l.append(h("span", {}, h("i", { style: `background:${c}` }), CAT[k]));
  l.append(h("span", {}, h("i", { style: "background:repeating-linear-gradient(-45deg,var(--sign-red) 0 3px,#fff 3px 6px)" }), "Gate closed"));
  l.append(h("span", {}, h("i", { style: "outline:2px solid var(--sign-yellow);background:transparent" }), "Changed this update"));
  l.append(h("span", {}, h("i", { style: "border:2px dashed var(--ink-3);background:transparent" }), "Previous gate"));
}

/* ---------- plan helpers ---------- */
function tickPlan(idx = state.tick) {
  const tk = state.run.ticks[idx];
  const plan = {};
  for (const [gid, bs] of Object.entries(tk.plan || {})) plan[gid] = bs.map(b => ({ ...b }));
  for (const [fid, gid] of state.overrides[idx] || []) {
    let booking = null;
    for (const g of Object.keys(plan)) {
      const i = plan[g].findIndex(b => b.flight_id === fid);
      if (i >= 0) { booking = plan[g][i]; plan[g].splice(i, 1); }
    }
    if (!booking) booking = { flight_id: fid, intervals: tk.flights[fid].intervals, category: catCode(tk.flights[fid].category) };
    booking.override = true;
    (plan[gid] = plan[gid] || []).push(booking);
  }
  return plan;
}
const catCode = c => ({ cargo: 0, domestic: 1, international: 2, transborder: 3 }[c]);
const catName = (b, info) => (info && info.category) || ["cargo", "domestic", "international", "transborder"][b.category] || "domestic";

function gateOf(plan, fid) {
  for (const [g, bs] of Object.entries(plan)) if (bs.some(b => b.flight_id === fid)) return g;
  return null;
}

function auditFor(fid, idx = state.tick) {
  let found = null;
  for (let i = 0; i <= idx; i++) {
    const a = state.run.ticks[i].audit;
    if (!a || !a.entries) continue;
    for (const e of a.entries) if (e.flight_id === fid) found = { entry: e, tick: state.run.ticks[i] };
  }
  return found;
}

function overrideDelta() {
  return (state.overrides.__delta || {})[state.tick] || 0;
}

/* ---------- timeline ---------- */
function zoom(f) {
  state.ppm = (state.ppm || 1) * f;
  renderTimeline();
}

function renderTimeline() {
  const run = state.run;
  if (!run) return;
  const box = $("#timeline");
  const scroll = [box.scrollLeft, box.scrollTop];
  box.innerHTML = "";
  const tk = run.ticks[state.tick];
  const prev = state.tick > 0 ? run.ticks[state.tick - 1] : null;
  const plan = tickPlan();
  const prevPlan = prev ? prev.plan : {};
  const changedSet = new Set();
  for (const [fid] of (tk.decisions && tk.decisions.reassignments) || []) changedSet.add(fid);
  for (const [fid] of (tk.decisions && tk.decisions.assignments) || []) if (state.tick > 0) changedSet.add(fid);
  for (const line of tk.log || []) { const m = line.match(/\[(UPDATE|HOLD)\] (\S+)/); if (m && state.tick > 0) changedSet.add(m[2]); }

  const t0 = Math.floor((run.time_min - 45) / 60) * 60;
  const t1 = Math.ceil((Math.min(run.time_max, run.time_min + 2 * 1440) + 45) / 60) * 60;
  const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--label-w")) || 132;
  const avail = box.clientWidth - labelW - 4;
  if (!state.ppm) state.ppm = Math.max(0.9, avail / (t1 - t0));
  const ppm = state.ppm;
  const W = (t1 - t0) * ppm;
  const x = t => (Math.max(t0, Math.min(t1, t)) - t0) * ppm;

  const inner = h("div", { class: "tl-inner", style: `width:${W + labelW}px` });
  const axis = h("div", { class: "axis", style: `width:${W}px` });
  const stepH = ppm * 60 < 38 ? 120 : 60;
  for (let t = t0; t <= t1; t += stepH) axis.append(h("span", { style: `left:${x(t)}px` }, fmt(t).slice(0, 5)));
  inner.append(axis);

  const groups = [];
  for (const g of run.gates) {
    const key = g.group || "gates";
    let grp = groups.find(x => x.key === key);
    if (!grp) groups.push(grp = { key, gates: [] });
    grp.gates.push(g);
  }
  const groupName = { cargo: "Cargo stands", domestic: "Domestic gates", international: "International gates (domestic allowed)" };

  const drawRow = (gid, labelEl, bookings, opts = {}) => {
    const row = h("div", { class: `row ${opts.cls || ""}`, "data-gate": gid || "" });
    row.append(h("div", { class: "lbl" }, labelEl));
    const track = h("div", { class: "track", style: `width:${W}px` });
    for (let t = t0; t <= t1; t += 60) track.append(h("div", { class: "hour", style: `left:${x(t)}px` }));
    for (const [s, e] of (tk.outages || {})[gid] || []) {
      const end = e >= run.outage_open_end ? t1 : e;
      track.append(h("div", { class: "outage", style: `left:${x(s)}px;width:${Math.max(3, x(end) - x(s))}px`, title: `Closed ${fmt(s)}-${e >= run.outage_open_end ? "further notice" : fmt(e)}` }));
    }
    for (const b of bookings) {
      const info = tk.flights[b.flight_id] || {};
      for (const [i, [s, e]] of b.intervals.entries()) {
        if (b.hold && i === 0) {
          track.append(h("div", { class: "blk hold", style: `left:${x(s - b.hold)}px;width:${Math.max(3, x(s) - x(s - b.hold))}px`, title: `Tarmac hold ${b.hold} min` }));
        }
        const cls = ["blk", catName(b, info)];
        if (b.ghost) cls.push("ghost");
        if (info.priority || b.diversion) cls.push("priority");
        if (!b.ghost && changedSet.has(b.flight_id)) cls.push("changed");
        if (b.override) cls.push("override");
        if (state.selected === b.flight_id && !b.ghost) cls.push("selected");
        const el = h("div", {
          class: cls.join(" "), style: `left:${x(s)}px;width:${Math.max(4, x(e) - x(s) - 1)}px`,
          "data-fid": b.flight_id, "data-gate": gid || "", tabindex: b.ghost ? null : 0,
          "aria-label": `${info.label || b.flight_id} ${fmt(s)} to ${fmt(e)}${gid ? " at " + gid : " ungated"}`,
        }, info.label || b.flight_id, ppm * (e - s) > 70 ? h("span", { style: "opacity:.8;font-weight:500" }, info.aircraft || "") : null);
        if (!b.ghost) wireBlock(el, b.flight_id, gid);
        track.append(el);
      }
    }
    if (tk.time >= t0 && tk.time <= t1) track.append(h("div", { class: "nowline", style: `left:${x(tk.time)}px` }));
    row.append(track);
    return row;
  };

  for (const grp of groups) {
    inner.append(h("div", { class: "group-head", style: `width:${labelW + W}px` }, groupName[grp.key] || grp.key));
    for (const g of grp.gates) {
      const bookings = [...(plan[g.id] || [])];
      for (const [pg, bs] of Object.entries(prevPlan || {})) {
        if (pg !== g.id) continue;
        for (const b of bs) {
          const now = gateOf(plan, b.flight_id);
          if (now && now !== g.id && changedSet.has(b.flight_id)) bookings.push({ ...b, ghost: true });
        }
      }
      const meta = h("div", { class: "meta" },
        `${g.max_wingspan} m${g.jetbridge ? ", bridge" : ""}`, h("br"),
        g.sweep ? "swing gate" : g.dist > 0 ? `${g.dist} m walk` : (g.zones || []).join("/"));
      inner.append(drawRow(g.id, [h("span", { class: "sign loc" }, g.label || g.id), meta], bookings, {}));
    }
  }
  // ungated flights
  const placed = new Set(Object.values(plan).flat().map(b => b.flight_id));
  const ungated = Object.entries(tk.flights || {}).filter(([fid]) => !placed.has(fid))
    .map(([fid, info]) => ({ flight_id: fid, intervals: info.intervals, category: catCode(info.category) }));
  if (ungated.length) {
    inner.append(h("div", { class: "group-head", style: `width:${labelW + W}px` }, "Waiting for a gate"));
    inner.append(drawRow(null, [h("span", { class: "sign mand" }, "NO GATE"), h("div", { class: "meta" }, `${ungated.length} flight${ungated.length > 1 ? "s" : ""}`)], ungated, { cls: "ungated" }));
  }
  box.append(inner);
  box.scrollLeft = scroll[0]; box.scrollTop = scroll[1];
}

/* ---------- block interaction: tooltip, select, drag ---------- */
function wireBlock(el, fid, gid) {
  el.addEventListener("mouseenter", e => showTip(e, fid, gid));
  el.addEventListener("mousemove", moveTip);
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(fid); } });
  el.addEventListener("pointerdown", e => startDrag(e, el, fid, gid));
}

function select(fid) {
  state.selected = fid;
  showTab("why");
  renderWhy();
  $$(".blk.selected").forEach(b => b.classList.remove("selected"));
  $$(`.blk[data-fid="${CSS.escape(fid)}"]:not(.ghost)`).forEach(b => b.classList.add("selected"));
  hook("select");
}

function showTip(e, fid, gid) {
  const tk = state.run.ticks[state.tick];
  const info = tk.flights[fid] || {};
  const a = auditFor(fid);
  const tip = $("#tip");
  tip.innerHTML = "";
  tip.append(h("b", {}, info.label || fid), ` ${info.aircraft || ""} ${info.route || ""}`, h("br"),
    `${gid || "No gate"}: ${fmtIvs(info.intervals || [])}`);
  if (a && a.entry.summary) tip.append(h("br"), h("span", { style: "opacity:.85" }, a.entry.summary));
  tip.classList.add("show");
  moveTip(e);
}
function moveTip(e) {
  const tip = $("#tip");
  const x = Math.min(window.innerWidth - tip.offsetWidth - 10, e.clientX + 14);
  const y = e.clientY + 18 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 12 : e.clientY + 18;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hideTip() { $("#tip").classList.remove("show"); }

function startDrag(e, el, fid, gid) {
  if (e.button !== 0) return;
  const startY = e.clientY, startX = e.clientX;
  let dragging = false, overRow = null;
  el.setPointerCapture(e.pointerId);
  const onMove = ev => {
    if (!dragging && Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < 5) return;
    if (!dragging) { dragging = true; el.classList.add("dragging"); hideTip(); }
    el.style.transform = `translateY(${ev.clientY - startY}px)`;
    el.style.pointerEvents = "none";
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    el.style.pointerEvents = "";
    const row = under && under.closest(".row");
    if (overRow && overRow !== row) overRow.classList.remove("drop-ok", "drop-bad");
    overRow = row && row.dataset.gate ? row : null;
    if (overRow) overRow.classList.add(overRow.dataset.gate === (gid || "") ? "drop-bad" : "drop-ok");
  };
  const onUp = async () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    if (overRow) overRow.classList.remove("drop-ok", "drop-bad");
    if (!dragging) { select(fid); return; }
    el.classList.remove("dragging");
    const target = overRow && overRow.dataset.gate;
    if (!target || target === gid) { el.style.transform = ""; return; }
    await tryMove(fid, target, el);
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

async function tryMove(fid, target, el) {
  const label = (state.run.ticks[state.tick].flights[fid] || {}).label || fid;
  try {
    const res = await api("/api/check", { run_id: state.run.run_id, tick: state.tick, overrides: state.overrides[state.tick] || [], move: [fid, target] });
    if (!res.ok) {
      if (el) { el.style.transform = ""; el.classList.add("reject"); setTimeout(() => el.classList.remove("reject"), 520); }
      toast(`${label} cannot go to ${target}`, true, res.violations);
      return false;
    }
    (state.overrides[state.tick] = state.overrides[state.tick] || []).push([fid, target]);
    const d = (state.overrides.__delta = state.overrides.__delta || {});
    d[state.tick] = (d[state.tick] || 0) + res.delta;
    renderResult();
    renderTimeline();
    select(fid);
    const costs = res.costs.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`);
    toast(`Override accepted: ${label} to ${target} (${res.delta >= 0 ? "+" : ""}${res.delta} pts)`, false, costs.length ? costs : ["no score change"]);
    return true;
  } catch (err) {
    if (el) el.style.transform = "";
    toast(`Check failed: ${err.message}`, true);
    return false;
  }
}

/* ---------- stepper + log ---------- */
function describeTick(tk, i) {
  if (tk.failed) return "Hard failure";
  const L = tk.log || [];
  const c = k => L.filter(l => l.includes(`[${k}]`)).length;
  const bits = [];
  const out = L.filter(l => l.includes("[OUTAGE]")).map(l => l.match(/Gate (\S+)/)?.[1]);
  if (out.length) bits.push(`gate ${out.join(", ")} closed`);
  if (c("DIVERT")) bits.push(`${c("DIVERT")} diversion`);
  if (c("CANCEL")) bits.push(`${c("CANCEL")} cancelled`);
  if (c("UPDATE")) bits.push(`${c("UPDATE")} changed`);
  if (c("HOLD")) bits.push(`${c("HOLD")} holding`);
  if (c("REASSIGN")) bits.push(`${c("REASSIGN")} moved`);
  if (c("ASSIGN")) bits.push(`${c("ASSIGN")} assigned`);
  return i === 0 && !bits.length ? "filed schedule" : bits.join(", ") || "no change";
}

function renderStepper() {
  const box = $("#stepper");
  box.innerHTML = "";
  state.run.ticks.forEach((tk, i) => {
    const b = h("button", { class: `step ${i === state.tick ? "active" : ""} ${tk.failed ? "fail" : ""}`, "aria-pressed": i === state.tick },
      h("b", {}, fmt(tk.time)), describeTick(tk, i));
    b.addEventListener("click", () => { state.tick = i; renderTimeline(); renderStepper(); renderLog(); renderResult(); renderWhy(); hook("tick"); });
    box.append(b);
  });
  const act = $(".step.active", box);
  if (act) act.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderLog() {
  const tk = state.run.ticks[state.tick];
  const box = $("#log");
  box.innerHTML = "";
  const a = tk.audit;
  if (a) {
    box.append(h("div", {}, `Planner: ${a.solver === "OPTIMAL" ? "CP-SAT, proven optimal" : a.solver === "FEASIBLE" ? "CP-SAT, best found in time limit" : a.solver} in ${a.solve_ms} ms`));
    for (const n of a.notes || []) box.append(h("div", {}, n));
    for (const e of a.errors || []) box.append(h("div", { class: "warn" }, e));
  }
  for (const line of tk.log || []) {
    const t = line.trim();
    if (!t || t.startsWith("---")) continue;
    box.append(h("div", { class: /HARD|WARN|FAIL/.test(t) ? "warn" : "" }, t.replace(/-2025-\d\d-\d\d/g, "")));
  }
}

/* ---------- why panel ---------- */
function renderWhy() {
  const pane = $("#pane-why");
  pane.innerHTML = "";
  const fid = state.selected;
  if (!state.run || !fid) {
    if (state.run) pane.append(summaryOfTick());
    else pane.append(h("div", { class: "hint" }, "Run a plan to see its decisions."));
    return;
  }
  pane.append(h("button", { class: "hud-key back", onclick: () => { state.selected = null; renderWhy(); if (window.onRender) window.onRender("select"); } }, "\u2190 Changes at this update"));
  const tk = state.run.ticks[state.tick];
  const info = tk.flights[fid];
  if (!info) { pane.append(h("div", { class: "hint" }, "That flight is not active at this update.")); return; }
  const plan = tickPlan();
  const gid = gateOf(plan, fid);
  const found = auditFor(fid);
  const e = found && found.entry;

  pane.append(h("div", { class: "fl-head" },
    h("span", { class: `sign ${gid ? "loc" : "mand"}` }, gid || "NO GATE"),
    h("h2", {}, info.label)));
  pane.append(h("div", { class: "fl-meta" },
    `${info.aircraft || ""}, ${info.route || ""}, ${CAT[info.category] || info.category}, wingspan ${info.wingspan} m${info.jetbridge ? ", needs jetbridge" : ""}`,
    h("br"), `At the gate ${fmtIvs(info.intervals)}`, info.priority ? h("b", { style: "color:var(--sign-red)" }, `  Priority ${info.reason || "diversion"}`) : null));

  const isOverride = (state.overrides[state.tick] || []).some(([f]) => f === fid);
  if (isOverride) pane.append(h("div", { class: "summary" }, `Manual override at this update: moved to ${gid}. The planner's reasoning below is for its own choice.`));

  if (!e) {
    pane.append(h("div", { class: "summary" }, state.run.solver === "solution_aerogate"
      ? "No decision recorded for this flight yet."
      : "Decision trails are recorded by the AeroGate planner. Switch the planner to AeroGate to see why each gate was chosen."));
  } else {
    if (found.tick.time !== tk.time) pane.append(h("div", { class: "fl-meta" }, `Decided at the ${fmt(found.tick.time)} update.`));
    pane.append(h("div", { class: `summary ${e.gate ? "" : "bad"}` }, e.summary));
    if (e.trigger && e.action !== "assign") pane.append(h("div", { class: "fl-meta" }, `Trigger: ${e.trigger}`));
    if (e.checks.length) {
      pane.append(h("h3", {}, "Rules checked"));
      pane.append(h("ul", { class: "checks compact" }, e.checks.map(([s, t]) => h("li", {}, h("span", { class: `tag ${s}` }, s === "PASS" ? "✓" : s), h("span", {}, t)))));
    }
    if (e.costs.length) {
      const total = e.costs.reduce((a, [, v]) => a + v, 0);
      pane.append(h("h3", {}, "What this choice costs"));
      pane.append(h("table", { class: "costs" },
        h("tbody", {}, e.costs.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, `${v.toFixed(2)} pts`))),
          h("tr", {}, h("td", {}, h("b", {}, "Total")), h("td", {}, h("b", {}, `${total.toFixed(2)} pts`))))));
    }
    if (e.alternatives.length) {
      // compact: legal alternatives one per line; taken gates and gates it may not use on one line each
      const by = v => e.alternatives.filter(a => a.verdict === v);
      const legal = by("costlier"), busy = by("busy"), rule = by("rule");
      const taken = busy.filter(a => /^taken by /.test(a.text)), blocked = busy.filter(a => !/^taken by /.test(a.text));
      pane.append(h("h3", {}, "Other gates"));
      if (legal.length) pane.append(h("ul", { class: "alts" }, legal.map(a => h("li", {}, h("span", { class: "sign loc" }, a.gate), h("span", { class: "costlier" }, a.text)))));
      if (blocked.length) pane.append(h("ul", { class: "alts" }, blocked.map(a => h("li", {}, h("span", { class: "sign loc" }, a.gate), h("span", { class: "busy" }, a.text)))));
      if (taken.length) pane.append(h("div", { class: "alt-line" }, h("b", {}, `Taken (${taken.length}) `),
        taken.map(a => h("span", { title: a.text }, a.gate))));
      if (rule.length) {
        const why = new Map();
        for (const a of rule) { const k = typeof shortReason === "function" ? shortReason(a.text) : a.text; (why.get(k) || why.set(k, []).get(k)).push(a.gate); }
        pane.append(h("div", { class: "alt-line" }, h("b", {}, `Not allowed (${rule.length}) `),
          [...why].map(([t, gs]) => h("span", { class: "nr", title: gs.join(", ") }, `${t} (${gs.length})`))));
      }
    }
  }
  // accessible override control
  const sel = h("select", { "aria-label": "Target gate" }, state.run.gates.filter(g => g.id !== gid).map(g => h("option", { value: g.id }, g.label || g.id)));
  pane.append(h("div", { class: "movebox" }, "Test a manual move to", sel,
    h("button", { class: "btn small", onclick: () => tryMove(fid, sel.value, null) }, "Check move")));
}

function summaryOfTick() {
  /* what the planner changed at the selected update, and why: each line opens that decision */
  const tk = state.run.ticks[state.tick];
  const a = tk.audit;
  const wrap = h("div", { class: "changes" });
  const events = (tk.log || []).filter(l => /\[(OUTAGE|DIVERT|CANCEL)\]/.test(l))
    .map(l => l.trim().replace(/-2025-\d\d-\d\d/g, "").replace(/^\[\w+\]\s*/, ""));
  wrap.append(h("h3", {}, `Update at ${fmt(tk.time)}`));
  if (events.length) wrap.append(h("ul", { class: "events-in" }, events.map(e => h("li", {}, e))));
  if (!a) { wrap.append(h("p", { class: "hint" }, "No planner record for this update.")); return wrap; }
  const pick = e => () => select(e.flight_id);
  const line = (tag, cls, e) => h("li", { class: "change", onclick: pick(e), tabindex: 0,
      onkeydown: ev => { if (ev.key === "Enter") select(e.flight_id); } },
    h("span", { class: `tag ${cls}` }, tag),
    h("span", { class: "who" }, e.label, e.gate ? h("b", {}, e.from_gate ? ` ${e.from_gate} \u2192 ${e.gate}` : ` \u2192 ${e.gate}`) : null),
    h("span", { class: "why" }, e.summary));
  const groups = [
    ["MOVED", "HOLD", a.entries.filter(e => e.action === "reassign")],
    ["WAITS", "FAIL", a.entries.filter(e => e.action === "unassigned")],
    ["STAYS", "PASS", a.entries.filter(e => e.action === "keep")],
  ];
  const list = h("ul", { class: "checks change-list" });
  for (const [tag, cls, es] of groups) for (const e of es) list.append(line(tag, cls, e));
  const assigned = a.entries.filter(e => e.action === "assign");
  if (assigned.length && state.tick > 0) for (const e of assigned) list.append(line("NEW", "PASS", e));
  if (!list.children.length || (state.tick === 0 && !groups.some(g => g[2].length))) {
    list.append(h("li", { class: "change static" }, h("span", { class: "tag PASS" }, "PLAN"),
      h("span", { class: "who" }, `${assigned.length} flights given a gate`),
      h("span", { class: "why" }, "Every assignment passed the hard rules and was replayed through the evaluator's own checks. Click any aircraft to see its reasoning.")));
  }
  wrap.append(list);
  wrap.append(h("p", { class: "hint" }, `${a.solver === "OPTIMAL" ? "Proven optimal" : a.solver === "FEASIBLE" ? "Best plan found" : a.solver} in ${a.solve_ms} ms. Click a line or an aircraft for the full decision.`));
  return wrap;
}

/* ---------- what-if ---------- */
function flightsForWhatIf() {
  const tk0 = state.baseline.ticks[0];
  return Object.entries(tk0.flights).map(([fid, f]) => ({ fid, ...f }))
    .sort((a, b) => (a.intervals[0]?.[0] ?? 0) - (b.intervals[0]?.[0] ?? 0));
}

function presets() {
  const fl = flightsForWhatIf();
  const out = [];
  const mid = (state.baseline.time_min + state.baseline.time_max) / 2;
  const later = fl.filter(f => f.category !== "cargo" && f.intervals[0] && f.intervals[0][0] > state.baseline.time_min + 90);
  const target = [...later.filter(f => f.wingspan >= 50), ...later.filter(f => f.wingspan < 50)].slice(0, 3);
  if (target.length) out.push({
    title: `Storm cell: ${target.length} arrival${target.length > 1 ? "s" : ""} 45 min late`,
    text: target.map(f => f.label).join(", ") + ", each announced an hour ahead",
    events: target.map(f => ({ kind: "delay", flight: f.fid, minutes: 45, at: Math.max(300, f.intervals[0][0] - 60) })),
  });
  const plan = state.baseline.ticks[state.baseline.ticks.length - 1].plan;
  const cargoGates = new Set(state.baseline.gates.filter(g => g.group === "cargo").map(g => g.id));
  const busiest = Object.entries(plan).filter(([g]) => !cargoGates.has(g)).sort((a, b) => b[1].length - a[1].length)[0];
  if (busiest) {
    const s = Math.round(Math.min(...busiest[1].map(b => b.intervals[0][0])) / 15) * 15;
    out.push({ title: `Jetbridge failure at ${busiest[0]} for 3 h`, text: `Closed ${toHHMM(s)} to ${toHHMM(s + 180)}, announced 60 min ahead`,
      events: [{ kind: "outage", gate: busiest[0], from: s, to: s + 180, at: Math.max(300, s - 60) }] });
  }
  const at = Math.round(mid / 15) * 15;
  const types = state.run.aircraft || ["321"];
  out.push({ title: "Medical diversion lands in 15 min", text: `${types.includes("789") ? "787-9" : types[0]} from Montreal, announced ${toHHMM(at)}`,
    events: [{ kind: "divert", aircraft: types.includes("789") ? "789" : types[0], origin: "YUL", arrival: at + 15, at, reason: "medical" }] });
  const narrow = fl.find(f => f.wingspan < 40 && f.category !== "cargo" && f.intervals[0] && f.intervals[0][0] > state.baseline.time_min + 60);
  if (narrow && types.includes("789")) out.push({ title: `Equipment swap: ${narrow.label} becomes a 787-9`,
    text: "Wider aircraft that needs a jetbridge", events: [{ kind: "equipment", flight: narrow.fid, aircraft: "789", at: Math.max(300, narrow.intervals[0][0] - 90) }] });
  return out;
}

function renderWhatIf() {
  const pane = $("#pane-whatif");
  pane.innerHTML = "";
  if (!state.baseline) { pane.append(h("div", { class: "hint" }, "Run a plan first.")); return; }
  if (state.run.mode === "yyz") {
    pane.append(h("div", { class: "hint" }, "The Pearson layer has its disruptions built in. Pick a challenge scenario to build what-ifs."));
    return;
  }
  const cmp = state.run.compare;
  if (cmp) {
    pane.append(h("h3", { style: "margin-top:0" }, "What-if result"));
    for (const d of state.run.whatif || []) pane.append(h("div", { class: "fl-meta", style: "margin:0" }, d));
    const fmtS = (s, st) => st === "OK" ? s.toFixed(2) : "FAIL";
    pane.append(h("div", { class: "verdict" },
      h("div", {}, h("div", { class: "lab" }, "Baseline score"), h("div", { class: "num" }, fmtS(cmp.base_score, cmp.base_status))),
      h("div", {}, h("div", { class: "lab" }, "With disruption"), h("div", { class: "num", style: cmp.status === "OK" ? "" : "color:var(--sign-red)" }, fmtS(cmp.score, cmp.status)))));
    pane.append(h("div", { class: "fl-meta" }, cmp.moved.length
      ? `Final gates that differ from baseline: ${cmp.moved.map(m => `${m.flight} ${m.from} to ${m.to}`).join(", ")}`
      : "Every flight kept its baseline gate."));
    if (cmp.newly_unassigned.length) pane.append(h("div", { class: "summary bad" }, `Left without a gate: ${cmp.newly_unassigned.join(", ")}`));
    pane.append(h("button", { class: "btn small", onclick: () => { state.run = state.baseline; state.tick = state.run.ticks.length - 1; state.overrides = {}; renderAll(); renderWhatIf(); } }, "Back to baseline"));
    pane.append(h("hr", { style: "border:0;border-top:1px solid var(--seam);margin:16px 0" }));
  }

  pane.append(h("h3", { style: "margin-top:0" }, "Quick scenarios"));
  const pbox = h("div", { class: "presets" });
  for (const p of presets()) pbox.append(h("button", { class: "preset", onclick: () => { state.events = p.events.slice(); runPlan(state.events); } }, h("b", {}, p.title), h("span", {}, p.text)));
  pane.append(pbox);

  pane.append(h("h3", {}, "Build your own"));
  const fl = flightsForWhatIf();
  const kind = h("select", {}, [["delay", "Arrival delay"], ["depdelay", "Departure delay"], ["outage", "Gate closure"], ["divert", "Diversion"], ["equipment", "Equipment swap"], ["cancel", "Cancellation"]].map(([v, t]) => h("option", { value: v }, t)));
  const flight = h("select", {}, fl.map(f => h("option", { value: f.fid }, `${f.label} ${fmt(f.intervals[0]?.[0])}`)));
  const minutes = h("input", { type: "number", value: 45, min: 5, max: 600, step: 5 });
  const gate = h("select", {}, state.run.gates.map(g => h("option", { value: g.id }, g.id)));
  const from = h("input", { type: "time", value: "12:00" });
  const to = h("input", { type: "time", value: "15:00" });
  const ac = h("select", {}, (state.run.aircraft || ["321"]).map(a => h("option", { value: a }, a)));
  const land = h("input", { type: "time", value: "12:30" });
  const at = h("input", { type: "time", value: "11:00" });
  const L = (t, el, cls) => h("label", { class: cls || "" }, t, el);
  const fields = {
    flight: L("Flight", flight, "full"), minutes: L("Minutes late", minutes), gate: L("Gate", gate), from: L("Closed from", from), to: L("Reopens", to),
    ac: L("Aircraft", ac), land: L("Lands at", land), at: L("Announced at", at),
  };
  const show = { delay: ["flight", "minutes", "at"], depdelay: ["flight", "minutes", "at"], outage: ["gate", "at", "from", "to"], divert: ["ac", "land", "at"], equipment: ["flight", "ac", "at"], cancel: ["flight", "at"] };
  const form = h("div", { class: "wi-form" }, L("Event", kind, "full"), Object.values(fields));
  const sync = () => { for (const [k, el] of Object.entries(fields)) el.classList.toggle("hidden", !show[kind.value].includes(k)); };
  kind.addEventListener("change", sync); sync();
  pane.append(form);
  const add = h("button", { class: "btn small", style: "margin-top:10px", onclick: () => {
    const k = kind.value, ev = { kind: k, at: toMin(at.value) };
    if (["delay", "depdelay", "equipment", "cancel"].includes(k)) ev.flight = flight.value;
    if (k.endsWith("delay")) ev.minutes = Number(minutes.value);
    if (k === "outage") Object.assign(ev, { gate: gate.value, from: toMin(from.value), to: toMin(to.value) });
    if (k === "divert") Object.assign(ev, { aircraft: ac.value, arrival: toMin(land.value), origin: "YUL", reason: "medical" });
    if (k === "equipment") ev.aircraft = ac.value;
    state.events.push(ev); renderWhatIf();
  } }, "Add event");
  pane.append(add);
  const evs = h("ul", { class: "events" }, state.events.map((ev, i) => h("li", {}, describeEvent(ev),
    h("button", { "aria-label": "Remove event", onclick: () => { state.events.splice(i, 1); renderWhatIf(); } }, "Remove"))));
  pane.append(evs);
  if (state.events.length) pane.append(h("button", { class: "btn primary", onclick: () => runPlan(state.events) }, `Run what-if with ${state.events.length} event${state.events.length > 1 ? "s" : ""}`));
}

function describeEvent(ev) {
  const lab = fid => (state.baseline.ticks[0].flights[fid] || {}).label || fid;
  const at = `at ${toHHMM(ev.at)}`;
  switch (ev.kind) {
    case "delay": return `${lab(ev.flight)} arrives ${ev.minutes} min late (${at})`;
    case "depdelay": return `${lab(ev.flight)} departs ${ev.minutes} min late (${at})`;
    case "outage": return `${ev.gate} closed ${toHHMM(ev.from)}-${toHHMM(ev.to)} (${at})`;
    case "divert": return `${ev.aircraft} diversion lands ${toHHMM(ev.arrival)} (${at})`;
    case "equipment": return `${lab(ev.flight)} becomes ${ev.aircraft} (${at})`;
    case "cancel": return `${lab(ev.flight)} cancelled (${at})`;
  }
  return ev.kind;
}

/* ---------- compare ---------- */
async function loadCompare() {
  const pane = $("#pane-compare");
  pane.innerHTML = "";
  pane.append(h("div", { class: "hint" }, "Running every challenge scenario with each planner..."));
  try {
    state.compare = await api("/api/compare");
  } catch (err) { pane.innerHTML = ""; pane.append(h("div", { class: "summary bad" }, err.message)); return; }
  renderCompare();
}

function renderCompare() {
  const pane = $("#pane-compare");
  pane.innerHTML = "";
  const { rows, solvers, generated } = state.compare;
  const ids = Object.keys(solvers);
  pane.append(h("h3", { style: "margin-top:0" }, "Challenge scenarios (lower is better)"));
  const totals = Object.fromEntries(ids.map(i => [i, 0]));
  const fails = Object.fromEntries(ids.map(i => [i, 0]));
  const body = rows.map(r => {
    const vals = ids.map(i => r[i]);
    const best = Math.min(...vals.filter(v => v != null));
    ids.forEach(i => { if (r[i] == null) fails[i]++; else totals[i] += r[i]; });
    return h("tr", {}, h("td", {}, r.scenario.replaceAll("_", " ")), ids.map(i =>
      h("td", { class: r[i] == null ? "fail" : Math.abs(r[i] - best) < 1e-9 ? "best" : "" }, r[i] == null ? "FAIL" : r[i].toFixed(1))));
  });
  pane.append(h("table", { class: "cmp" },
    h("thead", {}, h("tr", {}, h("th", {}, "Scenario"), ids.map(i => h("th", {}, solvers[i].replace("Provided ", "").replace(" (CP-SAT)", ""))))),
    h("tbody", {}, body),
    h("tfoot", {}, h("tr", {}, h("td", {}, "Total"), ids.map(i => h("td", {}, totals[i].toFixed(1)))))));
  if (generated) {
    pane.append(h("h3", {}, `${generated.count} generated stress days`));
    pane.append(h("div", { class: "fl-meta" }, "Random airport layouts and schedules, filtered so a valid plan always exists, with realistic delays, closures, swaps and diversions."));
    const gids = Object.keys(generated.totals);
    pane.append(h("table", { class: "cmp" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), gids.map(i => h("th", {}, (solvers[i] || i).replace("Provided ", "").replace(" (CP-SAT)", ""))))),
      h("tbody", {},
        h("tr", {}, h("td", {}, "Hard failures"), gids.map(i => h("td", { class: generated.fails[i] ? "fail" : "best" }, generated.fails[i]))),
        h("tr", {}, h("td", {}, "Score on days all finish"), gids.map(i => h("td", {}, generated.common[i].toFixed(0)))),
        h("tr", {}, h("td", {}, "Days won outright"), gids.map(i => h("td", {}, generated.wins[i] ?? ""))))));
  }
  pane.append(h("div", { class: "note" }, "A hard failure ends the evaluator run, so avoiding them matters more than any soft-score saving."));
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, bad, lines) {
  const t = $("#toast");
  t.innerHTML = "";
  t.append(h("div", { class: `sign ${bad ? "mand" : "loc"}` }, msg, (lines || []).map(l => h("small", {}, l))));
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 6000 : 4200);
}

document.addEventListener("DOMContentLoaded", () => init().catch(err => toast(`Dashboard failed to start: ${err.message}`, true)));

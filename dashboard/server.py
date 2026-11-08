"""
AeroGate operator dashboard - local web server (Python standard library only).

    python dashboard/server.py            # then open http://127.0.0.1:8770

API
  GET  /api/scenarios                 sample, generated and Pearson-layer scenarios
  POST /api/run      {scenario, solver, whatif?}      timeline + audit trail
  POST /api/check    {run_id, tick, overrides, move}  validate a drag-and-drop override
  GET  /api/compare                   every sample scenario x every solver
"""

import contextlib
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from evaluator import run_sim  # noqa: E402
from gms.loader import load_static  # noqa: E402
from gms.messages import FlightStore  # noqa: E402
from gms.profile import flight_profile  # noqa: E402
from gms.timeutil import hhmm_key_to_min  # noqa: E402
from gms.config import WEIGHTS, TURNAROUND_BUFFER  # noqa: E402
from aerogate import audit  # noqa: E402
from aerogate.adapter import flight_label, route_of  # noqa: E402
from aerogate.model import Gate, Flight, CATEGORY_BY_CODE, overlap, fmt  # noqa: E402
from aerogate.solver import hard_fails, Board, Option, pad  # noqa: E402
from aerogate.explain import _reject_text  # noqa: E402

STATIC_DIR = os.path.join(ROOT, "dashboard", "static")
SOLVERS = {
    "solution_aerogate": "AeroGate (CP-SAT)",
    "solution_scored": "Provided greedy",
    "solution_firstfit": "Provided first-fit",
}
RUNS = {}            # run_id -> payload (for override checks)
YYZ_CACHE = {}       # scenario file hash -> payload
RUN_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------
def scenarios():
    out = []
    for folder, kind in (("flight_data", "sample"), ("generated", "generated")):
        d = os.path.join(ROOT, folder)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith(".json") and not f.endswith(".static.json"):
                    out.append({"id": f"{folder}/{f[:-5]}", "name": f[:-5], "kind": kind})
    yyz = os.path.join(ROOT, "yyz", "scenarios")
    if os.path.isdir(yyz):
        for f in sorted(os.listdir(yyz)):
            if f.endswith(".json"):
                out.append({"id": f"yyz/{f[:-5]}", "name": f[:-5], "kind": "yyz"})
    return out


def paths_for(scenario_id):
    if scenario_id.startswith("yyz/"):
        return None, os.path.join(ROOT, "yyz", "scenarios", scenario_id[4:] + ".json")
    sched = os.path.join(ROOT, scenario_id + ".json")
    side = sched.replace(".json", ".static.json")
    static = side if os.path.exists(side) else os.path.join(ROOT, "static_info.json")
    if not os.path.exists(sched):
        raise FileNotFoundError(f"Unknown scenario {scenario_id}")
    return static, sched


# ---------------------------------------------------------------------------
# What-if events -> extra schedule messages
# ---------------------------------------------------------------------------
def _state_at(static_path, schedule, at_min):
    gates, ac, stations = load_static(static_path)
    store = FlightStore()
    for k in sorted(schedule, key=hhmm_key_to_min):
        if hhmm_key_to_min(k) > at_min:
            break
        for m in schedule[k]:
            if m.get("action") != "GateOutage":
                store.apply(m, hhmm_key_to_min(k))
    return store, gates, ac, stations


def _hhmm(m):
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def _shift(legs, delta, from_idx=0):
    out = []
    for i, l in enumerate(legs):
        l2 = {k: l[k] for k in ("legType", "aircraftType", "departureStation", "arrivalStation",
                                "scheduledDepartureTime", "scheduledArrivalTime")}
        if i >= from_idx:
            for k in ("scheduledDepartureTime", "scheduledArrivalTime"):
                h, mm = map(int, l[k].split(":"))
                l2[k] = _hhmm(h * 60 + mm + delta)
        out.append(l2)
    return out


def apply_whatif(static_path, schedule, events):
    """Return (new schedule, list of plain-language event descriptions)."""
    sched = copy.deepcopy(schedule)
    described = []
    for ev in events or []:
        at = int(ev.get("at", 0))
        key = f"{at // 60:02d}{at % 60:02d}"
        kind = ev.get("kind")
        store, gates, ac, stations = _state_at(static_path, sched, at)
        msgs = []
        if kind in ("delay", "depdelay", "cancel", "equipment"):
            st = store.flights.get(ev.get("flight"))
            if st is None:
                continue
            ident = {"carrier": st["carrier"], "flightNumber": st["flight_number"],
                     "flightSuffix": st["suffix"], "originatingDate": st["originating_date"]}
            if kind in ("delay", "depdelay"):
                mins = int(ev.get("minutes", 30))
                idx = 0
                if kind == "depdelay":
                    idx = next((i for i, l in enumerate(st["legs"]) if l["departureStation"] == "YYZ"), 0)
                msgs.append({"action": "UpdateTiming", "flight": ident, "legs": _shift(st["legs"], mins, idx)})
                described.append(f"{_hhmm(at)} {flight_label(ev['flight'])} "
                                 f"{'departure ' if kind == 'depdelay' else ''}delayed {mins} min")
            elif kind == "cancel":
                msgs.append({"action": "CancelFlight", "flight": ident, "cancelScope": {"type": "AllLegs"}})
                described.append(f"{_hhmm(at)} {flight_label(ev['flight'])} cancelled")
            else:
                msgs.append({"action": "UpdateEquipment", "flight": ident,
                             "equipmentUpdate": {"scope": "AllLegs", "aircraftType": ev["aircraft"]}})
                described.append(f"{_hhmm(at)} {flight_label(ev['flight'])} swapped to {ev['aircraft']}")
        elif kind == "outage":
            start, end = int(ev.get("from", at)), ev.get("to")
            m = {"action": "GateOutage", "gate": ev["gate"], "scheduledStartTime": _hhmm(start)}
            if end not in (None, ""):
                m["scheduledEndTime"] = _hhmm(int(end))
            msgs.append(m)
            described.append(f"{_hhmm(at)} gate {ev['gate']} out of service from {_hhmm(start)}"
                             + (f" to {_hhmm(int(end))}" if end not in (None, '') else " until further notice"))
        elif kind == "divert":
            arr = int(ev.get("arrival", at + 20))
            n = len([1 for e in events if e.get("kind") == "divert"])
            msgs.append({"action": "DivertFlight", "reason": ev.get("reason", "medical"),
                         "flight": {"carrier": "QK", "flightNumber": str(700 + n + at % 97),
                                    "flightSuffix": "D", "originatingDate": "2025-06-15"},
                         "legs": [{"legType": "Originating", "aircraftType": ev.get("aircraft", "321"),
                                   "departureStation": ev.get("origin", "YUL"), "arrivalStation": "YYZ",
                                   "scheduledDepartureTime": _hhmm(arr - 60),
                                   "scheduledArrivalTime": _hhmm(arr)}]})
            described.append(f"{_hhmm(at)} {ev.get('reason', 'medical')} diversion "
                             f"({ev.get('aircraft', '321')} from {ev.get('origin', 'YUL')}) lands {_hhmm(arr)}")
        sched.setdefault(key, []).extend(msgs)
    return dict(sorted(sched.items(), key=lambda kv: hhmm_key_to_min(kv[0]))), described


# ---------------------------------------------------------------------------
# Running a simulation and shaping the payload
# ---------------------------------------------------------------------------
def _profiles_per_tick(static_path, schedule):
    gates, ac, stations = load_static(static_path)
    store = FlightStore()
    per_tick = {}
    for k in sorted(schedule, key=hhmm_key_to_min):
        t = hhmm_key_to_min(k)
        for m in schedule[k]:
            if m.get("action") != "GateOutage":
                store.apply(m, t)
        snap = {}
        for fid, st in store.flights.items():
            p = flight_profile(st, ac, stations)
            if not p.has_yyz:
                continue
            legs = p.yyz_legs
            snap[fid] = {"label": flight_label(fid), "aircraft": legs[0]["aircraftType"] if legs else None,
                         "route": route_of(p.active_legs), "category": CATEGORY_BY_CODE.get(p.category),
                         "wingspan": p.wingspan, "jetbridge": bool(p.jetbridge_required),
                         "priority": p.diversion, "reason": p.reason,
                         "intervals": [list(iv) for iv in p.intervals]}
        per_tick[t] = snap
    return per_tick


def _gate_meta(static_path):
    gates, _, _ = load_static(static_path)
    zones = {0: ["cargo"], 1: ["domestic"], 2: ["international", "domestic"]}
    out = []
    for gid, g in sorted(gates.items(), key=lambda kv: (kv[1]["gate_type"], _natkey(kv[0]))):
        out.append({"id": gid, "zones": zones.get(g["gate_type"], []),
                    "premium": ["domestic"] if g["gate_type"] == 2 else [],
                    "max_wingspan": g["max_wingspan"], "jetbridge": bool(g["jetbridge"]),
                    "dist": g["dist"], "group": CATEGORY_BY_CODE.get(g["gate_type"]), "sweep": 0,
                    "pier": CATEGORY_BY_CODE.get(g["gate_type"])})
    return out


def _natkey(s):
    import re
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


SEATS = {"E75": 76, "73G": 126, "7M8": 169, "321": 190, "789": 298, "333": 297, "77W": 400}


def plan_summary(run):
    """Headline numbers of a Pearson run: score, gated flights, gate changes, tarmac holds
    (flights, minutes, and passenger-hours at an 85% load factor)."""
    res, last = run["result"], run["ticks"][-1]
    held = [(b["flight_id"], b["hold"]) for bs in last["plan"].values() for b in bs if b.get("hold")]
    pax_h = sum(h * SEATS.get((last["flights"].get(fid) or {}).get("aircraft"), 0) * 0.85 for fid, h in held) / 60
    return {"score": res["score"], "assigned": res["assigned"], "flights": len(last["flights"]),
            "unassigned": len(res["unassigned"]), "status": res["status"],
            "moves": sum(len((tk.get("decisions") or {}).get("reassignments", [])) for tk in run["ticks"]),
            "holds": len(held), "hold_min": sum(h for _, h in held), "hold_pax_h": round(pax_h),
            "breakdown": {k: v["points"] for k, v in res["breakdown"].items()}}


def run_payload(scenario_id, solver, whatif=None):
    static_path, sched_path = paths_for(scenario_id)
    if static_path is None:
        from yyz.sim import run_yyz  # realism layer has its own simulator
        # deterministic planner: cache by file contents so reloads are instant
        with open(sched_path, "rb") as fh:
            blob = fh.read()
        key = hashlib.sha1(blob).hexdigest()
        if key not in YYZ_CACHE:
            t0 = time.perf_counter()
            YYZ_CACHE[key] = run_yyz(json.loads(blob))
            YYZ_CACHE[key]["elapsed"] = round(time.perf_counter() - t0, 2)
            # the same evening re-planned by greedy rules alone (no optimisation): the side-by-side
            # numbers, and the whole run so the map can play it ("Show greedy plan on map")
            greedy = run_yyz(json.loads(blob), use_cpsat=False)
            compare = {"aerogate": plan_summary(YYZ_CACHE[key]), "greedy": plan_summary(greedy)}
            YYZ_CACHE[key]["rules_compare"] = greedy["rules_compare"] = compare
            YYZ_CACHE[key + ":greedy"] = greedy
        if solver == "greedy_rules":
            return _finish_payload(copy.deepcopy(YYZ_CACHE[key + ":greedy"]), scenario_id, "greedy_rules")
        return _finish_payload(copy.deepcopy(YYZ_CACHE[key]), scenario_id, "solution_aerogate")

    with open(sched_path) as fh:
        schedule = json.load(fh)
    described = []
    if whatif:
        schedule, described = apply_whatif(static_path, schedule, whatif)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        json.dump(schedule, tmp)
        tmp_path = tmp.name
    try:
        with audit.LOCK:
            audit.reset()
            sys.modules.pop(solver, None) if solver != "solution_aerogate" else None
            t0 = time.perf_counter()
            with contextlib.redirect_stdout(io.StringIO()):
                result = run_sim(static_path, tmp_path, solver, verbose=False, record=True)
            elapsed = time.perf_counter() - t0
            log = audit.snapshot() if solver == "solution_aerogate" else []
    finally:
        os.unlink(tmp_path)

    trace = result.pop("trace")
    per_tick = _profiles_per_tick(static_path, schedule)
    audit_by_time = {}
    for rec in log:
        audit_by_time.setdefault(rec["time"], rec)
    ticks = []
    for tk in trace["ticks"]:
        t = tk["time"]
        prof = per_tick.get(t, {})
        tk["flights"] = prof
        tk["audit"] = audit_by_time.get(t)
        ticks.append(tk)
    # a failing tick never reaches the trace: show it anyway with its error
    if result["status"] != "OK" and result.get("time") is not None and \
            (not ticks or ticks[-1]["time"] != result["time"]):
        last = copy.deepcopy(ticks[-1]) if ticks else {"plan": {}, "outages": {}, "queue": []}
        last.update({"time": result["time"], "time_label": fmt(result["time"]),
                     "log": [f"HARD FAILURE: {result['reason']}"], "failed": True,
                     "flights": per_tick.get(result["time"], {}),
                     "audit": audit_by_time.get(result["time"]),
                     "decisions": {"assignments": [], "reassignments": []}})
        ticks.append(last)

    payload = {
        "mode": "stock",
        "result": {k: result.get(k) for k in ("status", "score", "reason", "time", "assigned", "unassigned", "breakdown")},
        "gates": _gate_meta(static_path),
        "ticks": ticks,
        "time_min": trace["time_min"], "time_max": trace["time_max"],
        "outage_open_end": trace["outage_open_end"],
        "whatif": described,
        "elapsed": round(elapsed, 2),
        "weights": WEIGHTS, "buffer": TURNAROUND_BUFFER,
        "aircraft": sorted(load_static(static_path)[1]),
    }
    return _finish_payload(payload, scenario_id, solver)


def _finish_payload(payload, scenario_id, solver):
    payload["scenario"] = scenario_id
    payload["solver"] = solver
    payload["solver_name"] = SOLVERS.get(solver, solver)
    rid = hashlib.sha1(f"{scenario_id}{solver}{time.time()}".encode()).hexdigest()[:10]
    payload["run_id"] = rid
    with RUN_LOCK:
        RUNS[rid] = payload
        if len(RUNS) > 40:
            RUNS.pop(next(iter(RUNS)))
    return payload


def run_whatif(scenario_id, solver, events):
    base = run_payload(scenario_id, solver)
    alt = run_payload(scenario_id, solver, events)
    def final_gates(p):
        out = {}
        for gid, bookings in (p["ticks"][-1]["plan"] if p["ticks"] else {}).items():
            for b in bookings:
                out[b["flight_id"]] = gid
        return out
    fb, fa = final_gates(base), final_gates(alt)
    moved = sorted(f for f in fa if f in fb and fa[f] != fb[f])
    alt["compare"] = {
        "base_score": base["result"]["score"], "base_status": base["result"]["status"],
        "score": alt["result"]["score"], "status": alt["result"]["status"],
        "moved": [{"flight": flight_label(f), "from": fb[f], "to": fa[f]} for f in moved],
        "newly_unassigned": [flight_label(f) for f in alt["result"]["unassigned"] or []
                             if f not in (base["result"]["unassigned"] or [])],
        "base_breakdown": base["result"]["breakdown"],
    }
    return alt


# ---------------------------------------------------------------------------
# Drag-and-drop override check
# ---------------------------------------------------------------------------
def _model_gate(g, outages):
    return Gate(id=g["id"], zones=tuple(g["zones"]), premium=tuple(g.get("premium", [])),
                max_wingspan=float(g["max_wingspan"]), jetbridge=bool(g["jetbridge"]),
                dist=float(g["dist"]) if isinstance(g["dist"], (int, float)) else 0.0,
                outages=[tuple(w) for w in outages.get(g["id"], [])], sweep=int(g.get("sweep") or 0),
                xy=tuple(g["xy"]) if g.get("xy") else None)


def check_override(run_id, tick_idx, overrides, move):
    payload = RUNS.get(run_id)
    if payload is None:
        return {"ok": False, "violations": ["This run has expired - press Run again."]}
    tick = payload["ticks"][tick_idx]
    flights = tick["flights"]
    gates = {g["id"]: _model_gate(g, tick.get("outages", {})) for g in payload["gates"]}
    buf = payload.get("buffer", 0) or 0
    plan = {gid: [dict(b) for b in bs] for gid, bs in tick["plan"].items()}
    gate_of = {b["flight_id"]: gid for gid, bs in plan.items() for b in bs}
    for fid, gid in list(overrides) + [move]:
        src = gate_of.get(fid)
        if src:
            booking = next(b for b in plan[src] if b["flight_id"] == fid)
            plan[src] = [b for b in plan[src] if b["flight_id"] != fid]
        else:
            booking = {"flight_id": fid, "intervals": flights[fid]["intervals"]}
        plan.setdefault(gid, []).append(booking)
        gate_of[fid] = gid
    fid, gid = move
    info = flights.get(fid)
    if info is None or gid not in gates:
        return {"ok": False, "violations": ["Unknown flight or gate."]}
    f = Flight(id=fid, category=info["category"], wingspan=info["wingspan"],
               jetbridge_required=info["jetbridge"], intervals=[tuple(iv) for iv in info["intervals"]],
               aircraft=info.get("aircraft"), label=info["label"])
    g = gates[gid]
    labels = lambda x: flights.get(x, {}).get("label", x)  # noqa: E731
    violations = [_reject_text(code, None, f, g, labels) for code, _ in hard_fails(f, g)]
    for w in g.outages:
        if any(overlap(iv, w, buf) for iv in f.intervals):
            violations.append(f"gate out of service {fmt(w[0])}-{fmt(w[1])}")
    for b in plan.get(gid, []):
        if b["flight_id"] != fid and any(overlap(x, tuple(y), buf) for x in f.intervals for y in b["intervals"]):
            violations.append(f"overlaps {labels(b['flight_id'])} on {gid} "
                              f"({', '.join(fmt(s) + '-' + fmt(e) for s, e in b['intervals'])})")
    # YYZ layer: sweep + adjacency
    if payload.get("mode") == "yyz":
        model_flights = {x: Flight(id=x, category=v["category"], wingspan=v["wingspan"],
                                   jetbridge_required=v["jetbridge"],
                                   intervals=[tuple(iv) for iv in v["intervals"]]) for x, v in flights.items()}
        for b in plan.get(gid, []):
            o = model_flights.get(b["flight_id"])
            if o and b["flight_id"] != fid and g.sweep and o.category != f.category and \
                    any(overlap(x, tuple(y), g.sweep) for x in f.intervals for y in b["intervals"]):
                violations.append(f"swing gate needs a {g.sweep}-min security sweep between "
                                  f"{f.category} and {o.category} ({labels(b['flight_id'])})")
        for g1, g2, lim in payload.get("adjacency", []):
            nb = g2 if gid == g1 else g1 if gid == g2 else None
            if nb is None:
                continue
            for b in plan.get(nb, []):
                o = model_flights.get(b["flight_id"])
                if o and o.wingspan + f.wingspan > lim and \
                        any(overlap(x, tuple(y)) for x in f.intervals for y in b["intervals"]):
                    violations.append(f"wingtip clearance with {labels(b['flight_id'])} at {nb}: "
                                      f"{f.wingspan:g} + {o.wingspan:g} m > {lim:g} m")
    if violations:
        return {"ok": False, "violations": violations}
    w = payload.get("weights", WEIGHTS)
    old_gate = next((gg for gg, bs in tick["plan"].items() if any(b["flight_id"] == fid for b in bs)), None)
    costs = []
    started = min((s for s, _ in f.intervals), default=10 ** 9) <= tick["time"]
    if old_gate and old_gate != gid:
        costs.append(["reassignment" + (" after arrival" if started else ""),
                      w["reassignment_after_arrival"] if started else w["reassignment"]])
    old = next((x for x in payload["gates"] if x["id"] == old_gate), None)
    walk_new = g.dist if g.dist > 0 else 0
    walk_old = old["dist"] if old and isinstance(old["dist"], (int, float)) and old["dist"] > 0 else 0
    if walk_new != walk_old:
        costs.append([f"walking {walk_old:g} m -> {walk_new:g} m", round((walk_new - walk_old) * w["walking_distance_per_m"], 2)])
    if f.category in g.premium and not (old and f.category in old.get("premium", [])):
        costs.append(["domestic flight on international gate", w["domestic_at_intl_gate"]])
    return {"ok": True, "costs": costs, "delta": round(sum(c[1] for c in costs), 2)}


# ---------------------------------------------------------------------------
# Solver comparison
# ---------------------------------------------------------------------------
def compare_all():
    rows = []
    for sc in [s for s in scenarios() if s["kind"] == "sample"]:
        static_path, sched_path = paths_for(sc["id"])
        row = {"scenario": sc["name"]}
        for solver in SOLVERS:
            with audit.LOCK, contextlib.redirect_stdout(io.StringIO()):
                r = run_sim(static_path, sched_path, solver, verbose=False)
            row[solver] = r["score"] if r["status"] == "OK" else None
        rows.append(row)
    gen = None
    gpath = os.path.join(ROOT, "results", "generated_benchmark.json")
    if os.path.exists(gpath):
        with open(gpath) as fh:
            gen = json.load(fh)
    return {"rows": rows, "solvers": SOLVERS, "generated": gen}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".json": "application/json; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, ctype, body):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, "application/json; charset=utf-8", json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):  # noqa: N802
        path = urlsplit(self.path).path
        try:
            if path == "/api/scenarios":
                return self._json({"scenarios": scenarios(), "solvers": SOLVERS})
            if path == "/api/compare":
                return self._json(compare_all())
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            full = os.path.normpath(os.path.join(STATIC_DIR, name))
            if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
                return self._send(404, "text/plain", b"not found")
            with open(full, "rb") as fh:
                self._send(200, MIME.get(os.path.splitext(full)[1], "application/octet-stream"), fh.read())
        except Exception as exc:  # noqa: BLE001
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):  # noqa: N802
        path = urlsplit(self.path).path
        try:
            body = self._body()
            if path == "/api/run":
                if body.get("whatif"):
                    return self._json(run_whatif(body["scenario"], body.get("solver", "solution_aerogate"), body["whatif"]))
                return self._json(run_payload(body["scenario"], body.get("solver", "solution_aerogate")))
            if path == "/api/check":
                return self._json(check_override(body["run_id"], int(body["tick"]),
                                                 [tuple(x) for x in body.get("overrides", [])], tuple(body["move"])))
            self._send(404, "text/plain", b"not found")
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def log_message(self, fmt_, *args):
        pass


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"AeroGate dashboard at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

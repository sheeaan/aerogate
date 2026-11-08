"""
Pearson realism layer: a stand-alone simulator for rules the stock evaluator
does not model, solved by the same AeroGate optimiser core.

Extra rules on top of the challenge's:
  * US transborder flights need pre-cleared (F) gates; swing gates can serve
    two zones but need a 30-min security sweep between different zones (CBSA)
  * adjacent gates have a combined wingspan limit (wingtip clearance)
  * an arrival with no free gate holds on the tarmac; the penalty climbs
    steeply toward the APPR 3-hour limit, so the planner moves other flights
    before it lets a hold run long
  * connecting passengers' walk between arrival and departure gates is costed

Scenario files (yyz/scenarios/*.json) hold {"static", "connections", "schedule"}
where schedule uses the challenge's JSON flight-message format.
"""

import copy
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gms.messages import FlightStore, parse_gate_outage, OUTAGE_OPEN_END  # noqa: E402
from gms.occupancy import build_presences  # noqa: E402
from gms.timeutil import hhmm_str_to_min, hhmm_key_to_min, absolutize, fmt  # noqa: E402
from aerogate.model import Gate, Flight, Problem, DEFAULT_WEIGHTS, SCALE, merge, overlap  # noqa: E402
from aerogate.solver import solve, appr_hold_cost, APPR_LIMIT  # noqa: E402
from aerogate.explain import explain_tick  # noqa: E402
from aerogate.adapter import flight_label, route_of  # noqa: E402

HOLDS = (0, 10, 20, 30, 60, 90, 120, 180)
CAT_CODE = {"cargo": 0, "domestic": 1, "international": 2, "transborder": 3}
WEIGHTS = dict(DEFAULT_WEIGHTS, connection_per_pax_100m=2, hold_per_min=20)
POINTS = {k: v / SCALE for k, v in WEIGHTS.items()}
GMS_STYLE_WEIGHTS = {"reassignment": 10, "reassignment_after_arrival": 50, "domestic_at_intl_gate": 5,
                     "walking_distance_per_m": 0.01, "unassigned_flight": 100, "unassigned_emergency": 300}


def load_static(path):
    with open(path) as fh:
        s = json.load(fh)
    zone_of = {}
    for zone, codes in s["stations"].items():
        for c in codes:
            zone_of[c] = zone
    return s, zone_of


def profile(state, ac_info, zone_of):
    """Like gms.profile but with a transborder category."""
    if state.get("cancelled"):
        return None
    cancelled = state.get("cancelled_legs", set())
    active = [dict(l) for l in state["legs"] if (l["departureStation"], l["arrivalStation"]) not in cancelled]
    if not active:
        return None
    ev = []
    for l in active:
        ev += [hhmm_str_to_min(l["scheduledDepartureTime"]), hhmm_str_to_min(l["scheduledArrivalTime"])]
    ab = absolutize(ev)
    for i, l in enumerate(active):
        l["dep_abs"], l["arr_abs"] = ab[2 * i], ab[2 * i + 1]
    yyz = [l for l in active if "YYZ" in (l["departureStation"], l["arrivalStation"])]
    if not yyz:
        return None
    types = [ac_info[l["aircraftType"]] for l in yyz]
    if any(t.get("cargo") for t in types):
        cat = "cargo"
    else:
        others = [l["arrivalStation"] if l["departureStation"] == "YYZ" else l["departureStation"] for l in yyz]
        zones = {zone_of.get(o, "international") for o in others}
        cat = "international" if "international" in zones else "transborder" if "transborder" in zones else "domestic"
    return {
        "intervals": build_presences(active),
        "category": cat,
        "wingspan": max(float(t["wingspan"]) for t in types),
        "jetbridge": any(bool(t.get("jetbridge_required")) for t in types),
        "aircraft": yyz[0]["aircraftType"],
        "route": route_of(active),
        "arrival_first": yyz[0]["arrivalStation"] == "YYZ",
        "priority": bool(state.get("diversion")),
        "reason": state.get("reason"),
    }


def _sig(p):
    return (tuple(map(tuple, p["intervals"])), p["category"], p["wingspan"], p["jetbridge"])


def _info(fid, p, intervals=None):
    return {"label": flight_label(fid), "aircraft": p["aircraft"], "route": p["route"], "category": p["category"],
            "wingspan": p["wingspan"], "jetbridge": p["jetbridge"], "priority": p["priority"], "reason": p["reason"],
            "intervals": [list(iv) for iv in (intervals or p["intervals"])]}


def run_yyz(raw, whatif=None, time_limit=2.5, use_cpsat=True):
    """use_cpsat=False runs the same rules with the greedy planner only (the dashboard's
    "greedy rules" comparison: keep gates, re-fit what breaks, first good free gate)."""
    static_path = os.path.join(ROOT, raw.get("static", "yyz/pearson_t1.json"))
    s, zone_of = load_static(static_path)
    ac_info = s["aircraft_info"]
    gate_rows = s["gates"]
    adjacency = [tuple(a) for a in s.get("adjacency", [])]
    schedule = {hhmm_key_to_min(k): v for k, v in raw["schedule"].items()}
    connections = [(c["arr"], c["dep"], int(c["pax"])) for c in raw.get("connections", [])]

    store = FlightStore()
    outages = defaultdict(list)
    assigned = {}        # fid -> {gate, intervals, hold, sig}
    waiting_since = {}   # fid -> scheduled gate-in time it has been waiting from
    score = defaultdict(lambda: {"count": 0, "points": 0.0})
    ticks, appr_breach = [], set()

    def add(cat, pts, n=1):
        score[cat]["count"] += n
        score[cat]["points"] += pts

    for t in sorted(schedule):
        log, touched, outaged = [], set(), set()
        for msg in schedule[t]:
            if msg.get("action") == "GateOutage":
                gid, w = parse_gate_outage(msg)
                outages[gid].append(w)
                outaged.add(gid)
                end = "further notice" if w[1] >= OUTAGE_OPEN_END else fmt(w[1])
                log.append(f"  [OUTAGE] Gate {gid} unavailable [{fmt(w[0])}, {end}]")
                continue
            fid, warn = store.apply(msg, t)
            if fid:
                touched.add(fid)
                if msg.get("action") == "DivertFlight":
                    log.append(f"  [DIVERT] unscheduled {msg.get('reason', 'diversion')} arrival: {fid}")
        profs = {fid: p for fid, st in store.flights.items() if (p := profile(st, ac_info, zone_of))}

        for fid in list(assigned):
            if fid not in profs:
                log.append(f"  [CANCEL] {fid} released gate {assigned[fid]['gate']}")
                del assigned[fid]

        gates = {}
        for g in gate_rows:
            gates[g["id"]] = Gate(id=g["id"], zones=tuple(g["zones"]), max_wingspan=g["max_wingspan"],
                                  jetbridge=bool(g["jetbridge"]), dist=g["dist"], outages=list(outages[g["id"]]),
                                  xy=tuple(g["xy"]) if g.get("xy") else None, sweep=g.get("sweep", 0),
                                  group=g["group"], label=g["id"])

        flights, fixed, released = {}, {}, {}
        for fid, a in list(assigned.items()):
            p = profs[fid]
            changed = fid in touched and _sig(p) != a["sig"]
            hit = a["gate"] in outaged and any(overlap(iv, w) for iv in a["intervals"] for w in outages[a["gate"]])
            if not changed and not hit and all(e <= t for _, e in a["intervals"]):
                fixed[fid] = (a["gate"], a["intervals"])
                continue
            cur = [tuple(iv) for iv in (p["intervals"] if changed else a["intervals"])]
            trigger = None
            if changed:
                was = a["intervals"]
                if (a["sig"][2], a["sig"][3]) != (p["wingspan"], p["jetbridge"]):
                    trigger = (f"an aircraft swap to a {p['aircraft']} ({p['wingspan']:g} m wingspan"
                               + (", needs a jetbridge)" if p["jetbridge"] else ")"))
                elif tuple(map(tuple, was)) != tuple(cur):
                    trigger = (f"a delay: now on stand {fmt(cur[0][0])}-{fmt(cur[-1][1])} "
                               f"instead of {fmt(was[0][0])}-{fmt(was[-1][1])}")
                else:
                    trigger = f"an aircraft swap to a {p['aircraft']}"
            elif hit:
                trigger = f"gate outage on {a['gate']}"
            start = min(x for x, _ in cur)
            if (changed or hit) and start > t:
                # not landed yet: simply re-plan it (gate, or a planned hold) like a new flight
                released[fid] = (a["gate"], trigger)
                del assigned[fid]
                continue
            flights[fid] = Flight(id=fid, category=p["category"], wingspan=p["wingspan"], jetbridge_required=p["jetbridge"],
                                  intervals=cur, priority=p["priority"], reason=p["reason"], current_gate=a["gate"],
                                  flagged=changed or hit, trigger=trigger,
                                  stay_intervals=merge(a["intervals"] + cur) if (changed or hit) else a["intervals"],
                                  booked=a["intervals"], arrived=start <= t, label=flight_label(fid),
                                  aircraft=p["aircraft"], route=p["route"])
        for fid, p in profs.items():
            if fid in assigned:
                continue
            ivs = [tuple(iv) for iv in p["intervals"]]
            wait, holds = 0, (0,)
            if p["arrival_first"]:
                s0, e0 = ivs[0]
                if s0 < t:   # already landed with no gate: holding on the taxiway
                    wait = t - s0
                    ivs[0] = (t, max(e0, t + 30))
                    waiting_since.setdefault(fid, s0)
                holds = tuple(h for h in HOLDS if wait + h <= APPR_LIMIT) or (0,)
            flights[fid] = Flight(id=fid, category=p["category"], wingspan=p["wingspan"], jetbridge_required=p["jetbridge"],
                                  intervals=ivs, priority=p["priority"], reason=p["reason"], hold_options=holds,
                                  tarmac_wait=wait, label=flight_label(fid), aircraft=p["aircraft"], route=p["route"],
                                  trigger=released[fid][1] if fid in released else "diversion" if p["priority"] else None)

        prob = Problem(now=t, gates=gates, flights=flights, fixed=fixed, weights=WEIGHTS, buffer=0,
                       adjacency=adjacency, connections=[c for c in connections if c[0] in profs and c[1] in profs],
                       time_limit=time_limit)
        plan = solve(prob, use_cpsat=use_cpsat)

        assigns, moves = [], []
        for fid, o in plan.choice.items():
            f = flights[fid]
            if f.current_gate:
                if o is None or o.doomed:
                    log.append(f"  [REMOTE] {fid} towed to a remote stand: no legal gate after the change")
                    del assigned[fid]
                    add("remote_stand", 25)
                    continue
                if o.gid != f.current_gate:
                    moves.append((fid, o.gid))
                    if f.arrived:
                        add("reassignment_after_arrival", 50)
                    elif not f.flagged:
                        add("reassignment", 10)
                    log.append(f"  [REASSIGN] {fid}: {f.current_gate} -> {o.gid}  {', '.join(fmt(x) + '-' + fmt(y) for x, y in o.intervals)}")
                elif f.flagged:
                    log.append(f"  [UPDATE] {fid} @ {o.gid} now {', '.join(fmt(x) + '-' + fmt(y) for x, y in o.intervals)} (still valid)")
                assigned[fid].update(gate=o.gid, intervals=list(o.intervals), sig=_sig(profs[fid]))
            elif o is not None:
                total_hold = f.tarmac_wait + o.hold
                assigns.append((fid, o.gid))
                assigned[fid] = {"gate": o.gid, "intervals": list(o.intervals), "hold": total_hold, "sig": _sig(profs[fid])}
                waiting_since.pop(fid, None)
                ivtxt = ', '.join(fmt(x) + '-' + fmt(y) for x, y in o.intervals)
                if fid in released and released[fid][0] == o.gid:
                    log.append(f"  [UPDATE] {fid} @ {o.gid} now {ivtxt} (still valid)")
                elif fid in released:
                    log.append(f"  [REASSIGN] {fid}: {released[fid][0]} -> {o.gid}  {ivtxt} (before arrival, no charge)")
                else:
                    log.append(f"  [ASSIGN] {fid} -> {o.gid}  {ivtxt}")
                if total_hold:
                    pushed = o.intervals[0][1] - profs[fid]["intervals"][0][1]
                    log.append(f"  [HOLD] {fid} holds {total_hold} min on the taxiway for {o.gid} "
                               f"(IATA 87, APPR clock {total_hold}/{APPR_LIMIT} min)"
                               + (f"; departure pushed {pushed} min (IATA 93)" if pushed > 0 else ""))
                    add("tarmac_hold", appr_hold_cost(total_hold, WEIGHTS) / SCALE)
            elif fid in released:
                log.append(f"  [WAIT] {fid} lost gate {released[fid][0]} ({released[fid][1]}); no gate free yet, re-planned next update")
            elif f.tarmac_wait:
                log.append(f"  [HOLD] {fid} still waiting for a gate: {f.tarmac_wait} min of {APPR_LIMIT} (APPR)")
                if f.tarmac_wait >= APPR_LIMIT:
                    appr_breach.add(fid)

        rec = explain_tick(prob, plan, assigns, moves, [], [])
        # flights re-planned before landing: report them as moves (or stays) with the reason
        for e in rec["entries"]:
            fid = e["flight_id"]
            if fid not in released or e.get("gate") is None:
                continue
            old_gate, why = released[fid]
            if e["gate"] == old_gate:
                e["action"] = "keep"
                e["summary"] = f"Still valid at {old_gate} after {why}; no move needed."
            else:
                e["action"] = "reassign"
                e["from_gate"] = old_gate
                e["summary"] = (f"Moved {old_gate} -> {e['gate']} because of {why}. Re-planned before landing, "
                                f"so no charge and no passengers at the old gate. " + e["summary"])
                moves.append((fid, e["gate"]))
        tick_plan = defaultdict(list)
        for fid, a in assigned.items():
            p = profs[fid]
            tick_plan[a["gate"]].append({"flight_id": fid, "intervals": [list(iv) for iv in a["intervals"]],
                                         "category": CAT_CODE[p["category"]], "diversion": p["priority"],
                                         "hold": a.get("hold", 0)})
        flights_info = {}
        for fid, p in profs.items():
            ivs = assigned[fid]["intervals"] if fid in assigned else flights[fid].intervals if fid in flights else p["intervals"]
            flights_info[fid] = _info(fid, p, ivs)
        ticks.append({"time": t, "time_label": fmt(t), "log": log, "plan": dict(tick_plan),
                      "outages": {g: [list(w) for w in ws] for g, ws in outages.items() if ws},
                      "decisions": {"assignments": [list(a) for a in assigns], "reassignments": [list(m) for m in moves]},
                      "flights": flights_info, "audit": rec})

    # standing costs on the final plan
    gate_by_id = {g["id"]: g for g in gate_rows}
    final = {fid: a["gate"] for fid, a in assigned.items()}
    for fid, gid in final.items():
        d = gate_by_id[gid]["dist"]
        if d and d > 0:
            add("walking_distance_per_m", d * 0.01)
    for arr, dep, pax in connections:
        if arr in final and dep in final:
            a, b = gate_by_id[final[arr]].get("xy"), gate_by_id[final[dep]].get("xy")
            if a and b:
                add("connecting_walk", pax * (abs(a[0] - b[0]) + abs(a[1] - b[1])) * POINTS["connection_per_pax_100m"] / 100)
    unassigned = [fid for fid, st in store.flights.items()
                  if profile(st, ac_info, zone_of) and fid not in assigned]
    for fid in unassigned:
        add("unassigned_emergency" if store.flights[fid].get("diversion") else "unassigned_flight",
            300 if store.flights[fid].get("diversion") else 100)
    for fid in appr_breach:
        add("appr_tarmac_breach", 1000)

    all_iv = [x for tk in ticks for bs in tk["plan"].values() for b in bs for iv in b["intervals"] for x in iv]
    all_iv += [x for tk in ticks for ws in tk["outages"].values() for w in ws for x in w if x < OUTAGE_OPEN_END]
    gates_meta = [{"id": g["id"], "label": g["id"], "zones": g["zones"], "premium": [], "group": g["group"],
                   "max_wingspan": g["max_wingspan"], "jetbridge": bool(g["jetbridge"]), "dist": g["dist"],
                   "sweep": g.get("sweep", 0), "xy": g.get("xy"),
                   "pier": g.get("pier"), "gate_ll": g.get("gate_ll"), "stand": g.get("stand"),
                   "size_note": g.get("size_note"), "routes": g.get("routes")} for g in gate_rows]
    total = sum(v["points"] for v in score.values())
    return {
        "mode": "yyz",
        "result": {"status": "OK", "score": round(total, 2), "reason": None, "time": None,
                   "assigned": len(assigned), "unassigned": unassigned,
                   "breakdown": {k: {"count": v["count"], "points": round(v["points"], 2)} for k, v in score.items()}},
        "gates": gates_meta,
        "ticks": ticks,
        "time_min": min(all_iv) if all_iv else 0, "time_max": max(all_iv) if all_iv else 1440,
        "outage_open_end": OUTAGE_OPEN_END,
        "adjacency": [list(a) for a in adjacency],
        "map": s.get("map"),
        "connections": [list(c) for c in connections],
        "aircraft": sorted(ac_info),
        "weights": GMS_STYLE_WEIGHTS, "buffer": 0,
        "whatif": [], "elapsed": None,
    }


if __name__ == "__main__":
    import time
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "yyz", "scenarios", "pearson_evening_bank.json")
    with open(path) as fh:
        raw = json.load(fh)
    t0 = time.perf_counter()
    out = run_yyz(raw)
    for tk in out["ticks"]:
        print(f"--- {tk['time_label']} ({tk['audit']['solver']}, {tk['audit']['solve_ms']} ms)")
        for line in tk["log"]:
            print(line)
    print(json.dumps(out["result"], indent=1))
    print(f"{time.perf_counter() - t0:.1f}s")

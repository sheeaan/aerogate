"""
Decision audit trail: a plain-language "why this gate" record for every
decision, built from the same options and rules the solver used.

Each entry has
  checks        hard rules verified for the chosen gate          [PASS] ...
  costs         what the choice costs in evaluator points
  alternatives  every other gate and why it lost (rule, occupied, or costlier)
  summary       one line an operator can read in two seconds
"""

from .model import SCALE, fmt, fmt_ivs, overlap, sets_overlap
from .solver import APPR_LIMIT

CAT_TEXT = {"cargo": "cargo", "domestic": "domestic", "international": "international",
            "transborder": "US transborder"}

COST_TEXT = {
    "walk": "passenger walking distance",
    "premium": "domestic flight on an international (customs) gate",
    "move": "reassignment of an already-published gate",
    "move_after_arrival": "moving an aircraft that is already on the ground",
    "forced_move": "move forced by an airport-side change (no charge)",
    "hold": "tarmac hold",
    "invalid_stay": "no legal gate left",
}


def _zones(g):
    return "/".join(CAT_TEXT.get(z, z) for z in g.zones if z not in g.premium) or "unusable"


def _gate_line(g):
    jb = "jetbridge" if g.jetbridge else "no jetbridge"
    walk = f", {g.dist:g} m walk" if g.dist and g.dist > 0 else ""
    return f"{_zones(g)} gate, max {g.max_wingspan:g} m, {jb}{walk}"


def _reject_text(code, detail, f, g, labels):
    if code == "type":
        if f.category == "international":
            return f"{_zones(g)} gate - international flights need a customs (CBSA) gate"
        if f.category == "cargo":
            return f"{_zones(g)} gate - freighters must use a cargo stand"
        if f.category == "transborder":
            return f"{_zones(g)} gate - US transborder flights need a pre-cleared gate"
        return f"{_zones(g)} gate - {CAT_TEXT.get(f.category, f.category)} flights cannot use it"
    if code == "wingspan":
        return f"wingspan {f.wingspan:g} m exceeds gate limit {g.max_wingspan:g} m"
    if code == "jetbridge":
        return f"no jetbridge ({f.aircraft or 'aircraft'} requires one)"
    if code == "outage":
        return f"out of service {fmt_ivs([detail])}"
    if code == "occupied":
        return f"occupied by {labels(detail)}"
    return code


def _conflict_on(p, plan, o, labels):
    """Why a legal option lost: who holds that gate in the final plan."""
    f = p.flights[o.fid]
    g = p.gates[o.gid]
    for ofid, oo in plan.choice.items():
        if oo is None or oo.doomed or ofid == o.fid:
            continue
        if oo.gid == o.gid and any(overlap(x, y) for x in o.occupancy for y in oo.occupancy):
            return f"taken by {labels(ofid)} {fmt_ivs(oo.intervals)}"
        if oo.gid == o.gid and g.sweep and p.flights[ofid].category != f.category \
                and sets_overlap(o.intervals, oo.intervals, g.sweep):
            return (f"swing gate needs a {g.sweep}-min security sweep between "
                    f"{CAT_TEXT[f.category]} and {CAT_TEXT[p.flights[ofid].category]} ({labels(ofid)})")
    for g1, g2, lim in p.adjacency:
        nb = g2 if o.gid == g1 else g1 if o.gid == g2 else None
        if nb is None:
            continue
        for ofid, oo in plan.choice.items():
            if oo is None or oo.gid != nb or ofid == o.fid:
                continue
            ws = f.wingspan + p.flights[ofid].wingspan
            if ws > lim and sets_overlap(o.intervals, oo.intervals):
                return (f"wingtip clearance: {labels(ofid)} at adjacent {nb} - combined "
                        f"wingspan {ws:g} m > {lim:g} m limit")
    return None


def _delta_text(o, best, p):
    bits = []
    go, gb = p.gates[o.gid], p.gates[best.gid]
    if o.parts.get("walk", 0) > best.parts.get("walk", 0):
        bits.append(f"longer walk ({go.dist:g} m vs {gb.dist:g} m)")
    if o.parts.get("premium") and not best.parts.get("premium"):
        bits.append("wastes a customs gate")
    if o.parts.get("move") or o.parts.get("move_after_arrival"):
        bits.append("would mean a reassignment")
    if o.hold > best.hold:
        bits.append(f"{o.hold - best.hold} min longer tarmac hold")
    return ", ".join(bits) or "equal cost, lower in tie-break"


def explain_flight(p, plan, fid, action, from_gate=None, labels=None, moved_for=None):
    labels = labels or (lambda x: p.flights[x].label if x in p.flights else x)
    f = p.flights[fid]
    o = plan.choice.get(fid)
    entry = {
        "flight_id": fid, "label": f.label, "action": action, "time": p.now,
        "category": f.category, "aircraft": f.aircraft, "route": f.route,
        "wingspan": f.wingspan, "priority": f.priority, "reason": f.reason,
        "intervals": [list(iv) for iv in (o.intervals if o else f.intervals)],
        "gate": o.gid if o else None, "from_gate": from_gate,
        "trigger": f.trigger, "checks": [], "costs": [], "alternatives": [],
    }

    # --- alternatives (every gate) -------------------------------------
    by_gate = {}
    for opt in plan.options.get(fid, []):
        if not opt.doomed and (opt.gid not in by_gate or opt.cost < by_gate[opt.gid].cost):
            by_gate[opt.gid] = opt
    alts = []
    for gid, g in p.gates.items():
        if o is not None and gid == o.gid:
            continue
        if gid in plan.rejected.get(fid, {}):
            code, detail = plan.rejected[fid][gid][0]
            alts.append({"gate": gid, "verdict": "rule", "text": _reject_text(code, detail, f, g, labels)})
            continue
        opt = by_gate.get(gid)
        if opt is None:
            continue
        why = _conflict_on(p, plan, opt, labels)
        if why:
            alts.append({"gate": gid, "verdict": "busy", "text": why})
        elif o is not None:
            d = (opt.cost - o.cost) / SCALE
            alts.append({"gate": gid, "verdict": "costlier",
                         "text": f"+{d:.2f} pts: {_delta_text(opt, o, p)}" if d > 0 else _delta_text(opt, o, p),
                         "delta": round(d, 2)})
        else:
            alts.append({"gate": gid, "verdict": "busy", "text": "no conflict-free slot"})
    order = {"costlier": 0, "busy": 1, "rule": 2}
    alts.sort(key=lambda a: (order[a["verdict"]], a.get("delta", 0), a["gate"]))
    entry["alternatives"] = alts

    legal = [a for a in alts if a["verdict"] != "rule"]
    if o is None or o.doomed:
        if not by_gate:
            hard = sorted({c for v in plan.rejected.get(fid, {}).values() for c, _ in v})
            entry["summary"] = ("No gate in the airport can take this flight ("
                                + ", ".join(hard) + "). Left unassigned for the duty manager.")
        else:
            entry["summary"] = (f"All {len(by_gate)} legal gates are busy in this window. "
                                "Left unassigned - other flights would have cost more to move.")
        if o is not None and o.doomed:
            entry["summary"] = "No legal gate remains after the change - needs manual handling."
        return entry

    g = p.gates[o.gid]
    # --- checks ---------------------------------------------------------
    ck = entry["checks"]
    if f.category in g.premium:
        ck.append(["PASS", f"{CAT_TEXT[f.category].capitalize()} flight may use this international gate (soft penalty)"])
    elif f.category == "international":
        ck.append(["PASS", "International flight at a customs-controlled gate (CBSA processing)"])
    elif f.category == "transborder":
        ck.append(["PASS", "US transborder flight at a pre-clearance gate"])
    else:
        ck.append(["PASS", f"{CAT_TEXT.get(f.category, f.category).capitalize()} flight at a {_zones(g)} gate"])
    ck.append(["PASS", f"Wingspan {f.wingspan:g} m within gate limit {g.max_wingspan:g} m"])
    if f.jetbridge_required:
        ck.append(["PASS", f"{f.aircraft or 'Aircraft'} needs a jetbridge - gate has one"])
    buf = f" (+{p.buffer} min buffer)" if p.buffer else ""
    ck.append(["PASS", f"Gate free {fmt_ivs(o.intervals)}{buf}"])
    if g.outages:
        ck.append(["PASS", "Clear of announced outage " + fmt_ivs(g.outages)])
    if g.sweep and len(g.zones) > 1:
        ck.append(["PASS", f"Swing gate: {g.sweep}-min security sweep kept before/after any zone change"])
    for g1, g2, lim in p.adjacency:
        if o.gid in (g1, g2):
            nb = g2 if o.gid == g1 else g1
            ck.append(["PASS", f"Wingtip clearance with adjacent {nb} (combined limit {lim:g} m)"])
    if o.hold or f.tarmac_wait:
        total = f.tarmac_wait + o.hold
        ck.append(["HOLD", f"Tarmac hold {total} min of the {APPR_LIMIT}-min APPR limit"])

    # --- costs ----------------------------------------------------------
    for k, v in o.parts.items():
        if k == "forced_move":
            entry["costs"].append([COST_TEXT[k], 0.0])
        elif v:
            entry["costs"].append([COST_TEXT.get(k, k), round(v / SCALE, 2)])

    # --- summary ----------------------------------------------------------
    costlier = [a for a in alts if a["verdict"] == "costlier"]
    if action == "reassign":
        if f.flagged:
            why = f.trigger or "an airport-side change"
            entry["summary"] = f"Moved {from_gate} -> {o.gid} because of {why}."
        elif moved_for:
            entry["summary"] = (f"Moved {from_gate} -> {o.gid} to free {from_gate} for "
                                f"{', '.join(labels(x) for x in moved_for)}"
                                f" ({'+50' if f.arrived else '+10'} pts, cheaper than leaving it ungated).")
        else:
            why = _stay_conflict(p, plan, f, from_gate, labels)
            cost = "+50" if f.arrived else "+10"
            entry["summary"] = (f"Moved {from_gate} -> {o.gid}: staying would break {why} ({cost} pts, the cheapest fix)."
                                if why else f"Moved {from_gate} -> {o.gid}.")
    elif action == "keep":
        entry["summary"] = f"Still valid at {o.gid} after {f.trigger or 'the update'} - no move needed."
    elif not legal:
        entry["summary"] = f"{o.gid} is the only gate that meets every rule for this flight."
    elif not costlier:
        entry["summary"] = (f"{o.gid} is the only legal gate free during {fmt_ivs(o.intervals)} "
                            f"({len(legal)} other legal gates are taken).")
    else:
        nxt = costlier[0]
        entry["summary"] = (f"Best of {len(costlier) + 1} free legal gates: {_gate_line(g)}. "
                            f"Next best {nxt['gate']} ({nxt['text']}).")
    if f.priority:
        entry["summary"] = f"PRIORITY {f.reason or 'diversion'}: " + entry["summary"]
    return entry


def _stay_conflict(p, plan, f, gid, labels):
    """Why flight f could not keep gate gid in the new plan (wingtip, sweep or overlap)."""
    g = p.gates.get(gid)
    if g is None:
        return None
    ivs = f.stay_intervals or f.intervals
    for g1, g2, lim in p.adjacency:
        nb = g2 if gid == g1 else g1 if gid == g2 else None
        if nb is None:
            continue
        for x, o in plan.choice.items():
            if o is None or o.doomed or x == f.id or o.gid != nb:
                continue
            ws = f.wingspan + p.flights[x].wingspan
            if ws > lim and sets_overlap(ivs, o.intervals):
                ac = p.flights[x].aircraft or ""
                return f"wingtip clearance with {labels(x)} ({ac}) at {nb}: {f.wingspan:g} + {p.flights[x].wingspan:g} m > {lim:g} m"
    for x, o in plan.choice.items():
        if o is None or o.doomed or x == f.id or o.gid != gid:
            continue
        if sets_overlap(ivs, o.intervals):
            return f"the gate time of {labels(x)}"
        if g.sweep and p.flights[x].category != f.category and sets_overlap(ivs, o.intervals, g.sweep):
            return f"the {g.sweep}-min security sweep before {labels(x)} ({CAT_TEXT.get(p.flights[x].category, '')})"
    return None


def explain_tick(p, plan, assigns, moves, errors, notes=()):
    labels = lambda x: p.flights[x].label if x in p.flights else x.split("-")[0] + x.split("-")[1] if "-" in x else x  # noqa: E731
    moved_from = {fid: p.flights[fid].current_gate for fid, _ in moves}
    entries = []
    for fid, gid in moves:
        f = p.flights[fid]
        beneficiaries = []
        if not f.flagged:
            src = moved_from[fid]
            beneficiaries = [x for x, o in plan.choice.items()
                             if o is not None and x != fid and o.gid == src
                             and sets_overlap(f.stay_intervals or f.intervals, o.intervals)]
        entries.append(explain_flight(p, plan, fid, "reassign", moved_from[fid], labels, beneficiaries))
    for fid, gid in assigns:
        entries.append(explain_flight(p, plan, fid, "assign", None, labels))
    moved = {fid for fid, _ in moves}
    for fid, f in p.flights.items():
        if f.flagged and fid not in moved and plan.choice.get(fid) is not None:
            entries.append(explain_flight(p, plan, fid, "keep", None, labels))
        if not f.current_gate and fid not in {a for a, _ in assigns}:
            entries.append(explain_flight(p, plan, fid, "unassigned", None, labels))
    return {
        "time": p.now,
        "solver": plan.status,
        "solve_ms": round(plan.solve_ms, 1),
        "objective": round(plan.objective, 2),
        "errors": list(errors),
        "notes": list(notes),
        "entries": entries,
    }

"""
Bridge between the evaluator's observation and the AeroGate model.

  observation -> Problem      (problem_from_observation)
  Plan -> actions             (to_actions: orders moves so each one is legal
                               at the moment the evaluator applies it)
  actions -> safe actions     (replay: re-runs the evaluator's own checks and
                               drops anything that would be a hard failure)
"""

from .model import (Gate, Flight, Problem, CATEGORY_BY_CODE, merge, earliest,
                    overlap, weights_from_gms, fmt_ivs)

try:  # follow the evaluator's live configuration when it is importable
    from gms.config import WEIGHTS as GMS_WEIGHTS, TURNAROUND_BUFFER
except Exception:  # noqa: BLE001
    GMS_WEIGHTS, TURNAROUND_BUFFER = None, 0

try:
    from gms.compat import hard_compatible as _gms_hard_compatible
except Exception:  # noqa: BLE001
    _gms_hard_compatible = None


def _gate(gid, g, outages):
    t = g.get("gate_type")
    if t == 0:
        zones, premium = ("cargo",), ()
    elif t == 1:
        zones, premium = ("domestic",), ()
    elif t == 2:
        zones, premium = ("international", "domestic"), ("domestic",)
    else:
        zones, premium = (), ()
    dist = g.get("dist", 0)
    return Gate(id=gid, zones=zones, premium=premium,
                max_wingspan=float(g.get("max_wingspan", 0) or 0),
                jetbridge=bool(g.get("jetbridge")),
                dist=float(dist) if isinstance(dist, (int, float)) else 0.0,
                outages=[tuple(w) for w in outages])


def flight_label(fid: str) -> str:
    parts = fid.split("-")
    return f"{parts[0]}{parts[1]}" if len(parts) >= 2 else fid


def route_of(legs) -> str:
    if not legs:
        return ""
    stops = [legs[0].get("departureStation")] + [l.get("arrivalStation") for l in legs]
    return "-".join(s for s in stops if s)


def _trigger(info, gid) -> str:
    if info.get("reason") == "outage":
        return f"gate outage on {gid}"
    old, new = info.get("old", {}), info.get("new", {})
    bits = []
    if old.get("intervals") != new.get("intervals"):
        bits.append(f"schedule change {fmt_ivs(old.get('intervals', []))} -> {fmt_ivs(new.get('intervals', []))}")
    if old.get("wingspan") != new.get("wingspan") or old.get("jetbridge_required") != new.get("jetbridge_required"):
        bits.append(f"equipment change (wingspan {old.get('wingspan'):g} m -> {new.get('wingspan'):g} m"
                    + (", now needs a jetbridge" if new.get("jetbridge_required") and not old.get("jetbridge_required") else "")
                    + ")")
    if old.get("category") != new.get("category"):
        bits.append(f"route change ({CATEGORY_BY_CODE.get(old.get('category'))} -> "
                    f"{CATEGORY_BY_CODE.get(new.get('category'))})")
    return "; ".join(bits) or "flight update"


def _flight(fid, v, **kw) -> Flight:
    legs = v.get("legs") or []
    return Flight(
        id=fid,
        category=CATEGORY_BY_CODE.get(v.get("category"), f"type{v.get('category')}"),
        wingspan=float(v.get("wingspan") or 0),
        jetbridge_required=bool(v.get("jetbridge_required")),
        intervals=[tuple(iv) for iv in v.get("intervals", [])],
        priority=bool(v.get("priority")),
        reason=v.get("reason"),
        label=flight_label(fid),
        aircraft=legs[0].get("aircraftType") if legs else None,
        route=route_of(legs),
        **kw,
    )


def problem_from_observation(obs, robust_window=45, time_limit=2.0) -> Problem:
    now = obs["time"]
    outages = obs.get("gate_outages", {}) or {}
    gates = {gid: _gate(gid, g, outages.get(gid, [])) for gid, g in obs["gates"].items()}
    booked = {b["flight_id"]: (gid, [tuple(iv) for iv in b["intervals"]])
              for gid, bookings in obs.get("gate_assignments", {}).items() for b in bookings}
    changed = obs.get("changed_flights", {}) or {}

    flights, fixed = {}, {}
    for fid, v in obs.get("assigned_flights", {}).items():
        gid = v["gate_id"]
        cur = [tuple(iv) for iv in v.get("intervals", [])]
        old = booked.get(fid, (gid, cur))[1]
        flagged = fid in changed
        if not flagged and old and all(e <= now for _, e in old):
            fixed[fid] = (gid, old)          # already come and gone: leave it alone
            continue
        start = earliest(cur)
        flights[fid] = _flight(
            fid, v, current_gate=gid, flagged=flagged,
            trigger=_trigger(changed[fid], gid) if flagged else None,
            stay_intervals=merge(old + cur) if flagged else old,
            booked=old,
            arrived=start is not None and start <= now)
    for fid, v in obs.get("waiting_flights", {}).items():
        flights[fid] = _flight(fid, v, trigger="diversion" if v.get("priority") else None)

    return Problem(now=now, gates=gates, flights=flights, fixed=fixed,
                   weights=weights_from_gms(GMS_WEIGHTS), buffer=int(TURNAROUND_BUFFER or 0),
                   robust_window=robust_window, time_limit=time_limit)


# ---------------------------------------------------------------------------
# Plan -> ordered actions
# ---------------------------------------------------------------------------
def _blocked(gid, fid, ivs, bookings, outages, buf):
    for ofid, oivs in bookings.get(gid, []):
        if ofid != fid and any(overlap(x, y, buf) for x in ivs for y in oivs):
            return f"flight {ofid}"
    for w in outages.get(gid, []):
        if any(overlap(x, tuple(w), buf) for x in ivs):
            return "outage"
    return None


def _state(obs):
    bookings = {gid: [(b["flight_id"], [tuple(iv) for iv in b["intervals"]]) for b in lst]
                for gid, lst in obs.get("gate_assignments", {}).items()}
    for gid in obs["gates"]:
        bookings.setdefault(gid, [])
    gate_of = {fid: v["gate_id"] for fid, v in obs.get("assigned_flights", {}).items()}
    return bookings, gate_of


def to_actions(obs, p, plan):
    """Return (assignments, ordered reassignments, stuck moves)."""
    assigns, moves = [], []
    for fid, o in plan.choice.items():
        f = p.flights[fid]
        if o is None or o.doomed:
            continue
        if f.current_gate:
            if o.gid != f.current_gate:
                moves.append((fid, o.gid))
        else:
            assigns.append((fid, o.gid))
    assigns.sort(key=lambda a: (not p.flights[a[0]].priority, a[0]))

    bookings, gate_of = _state(obs)
    cur = {fid: [tuple(iv) for iv in v.get("intervals", [])] for fid, v in obs.get("assigned_flights", {}).items()}
    outages = obs.get("gate_outages", {}) or {}
    order, pending = [], sorted(moves)
    while pending:
        progressed = False
        for mv in list(pending):
            fid, gid = mv
            if _blocked(gid, fid, cur[fid], bookings, outages, p.buffer):
                continue
            src = gate_of[fid]
            bookings[src] = [b for b in bookings[src] if b[0] != fid]
            bookings[gid].append((fid, cur[fid]))
            gate_of[fid] = gid
            order.append(mv)
            pending.remove(mv)
            progressed = True
        if not progressed:
            break
    return assigns, order, pending


# ---------------------------------------------------------------------------
# Exact replay of the evaluator's checks
# ---------------------------------------------------------------------------
def _compatible(view, gate):
    if _gms_hard_compatible is not None:
        return _gms_hard_compatible(view["category"], view["wingspan"], view["jetbridge_required"], gate)
    if view["wingspan"] > gate["max_wingspan"]:
        return False, "wingspan"
    if view["jetbridge_required"] and not gate["jetbridge"]:
        return False, "jetbridge"
    c, t = view["category"], gate["gate_type"]
    ok = (t == 0) if c == 0 else (t == 2) if c == 2 else t in (1, 2)
    return ok, None if ok else "type"


def replay(obs, assigns, moves, buf=0):
    """Apply actions exactly as the evaluator would. Returns
    (kept assignments, kept reassignments, errors)."""
    gates = obs["gates"]
    outages = obs.get("gate_outages", {}) or {}
    bookings, gate_of = _state(obs)
    views = dict(obs.get("waiting_flights", {}))
    views.update(obs.get("assigned_flights", {}))
    changed = obs.get("changed_flights", {}) or {}
    errors, kept_moves, kept_assigns = [], [], []

    for fid, gid in moves:
        v = views.get(fid)
        if fid not in gate_of or gid not in gates or v is None:
            errors.append(f"bad reassignment {fid}->{gid}")
            continue
        if gid == gate_of[fid]:
            continue
        ok, why = _compatible(v, gates[gid])
        ivs = [tuple(iv) for iv in v["intervals"]]
        if not ok or _blocked(gid, fid, ivs, bookings, outages, buf):
            errors.append(f"reassignment {fid}->{gid} rejected ({why or 'blocked'})")
            continue
        src = gate_of[fid]
        bookings[src] = [b for b in bookings[src] if b[0] != fid]
        bookings[gid].append((fid, ivs))
        gate_of[fid] = gid
        kept_moves.append((fid, gid))

    for fid, gid in assigns:
        v = obs.get("waiting_flights", {}).get(fid)
        if v is None or fid in gate_of or gid not in gates:
            errors.append(f"bad assignment {fid}->{gid}")
            continue
        ok, why = _compatible(v, gates[gid])
        ivs = [tuple(iv) for iv in v["intervals"]]
        if not ok or _blocked(gid, fid, ivs, bookings, outages, buf):
            errors.append(f"assignment {fid}->{gid} dropped ({why or 'blocked'})")
            continue
        bookings[gid].append((fid, ivs))
        gate_of[fid] = gid
        kept_assigns.append((fid, gid))

    for fid, info in changed.items():
        gid = gate_of.get(fid)
        if gid is None:
            continue
        new = info["new"]
        ok, why = _compatible(new, gates[gid])
        ivs = [tuple(iv) for iv in new["intervals"]]
        if not ok or _blocked(gid, fid, ivs, bookings, outages, buf):
            errors.append(f"{fid} left on invalid gate {gid}")
            continue
        bookings[gid] = [(b[0], ivs if b[0] == fid else b[1]) for b in bookings[gid]]

    return kept_assigns, kept_moves, errors

"""
Random stress scenarios that look like the hidden test cases: a different
airport layout every time plus a day of disruptions (delays, equipment swaps,
cancellations, reinstatements, outages, diversions).

    python tools/gen_scenarios.py --n 60 --out generated

Writes <name>.json (schedule) and <name>.static.json (layout) pairs.
"""

import argparse
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

AIRCRAFT = {
    "E75": {"name": "Embraer E175", "wingspan": 26, "jetbridge_required": 0, "cargo": False},
    "73G": {"name": "Boeing 737-700", "wingspan": 36, "jetbridge_required": 0, "cargo": False},
    "321": {"name": "Airbus A321", "wingspan": 36, "jetbridge_required": 0, "cargo": False},
    "7M8": {"name": "Boeing 737 MAX 8", "wingspan": 36, "jetbridge_required": 0, "cargo": False},
    "333": {"name": "Airbus A330-300", "wingspan": 60, "jetbridge_required": 1, "cargo": False},
    "789": {"name": "Boeing 787-9", "wingspan": 60, "jetbridge_required": 1, "cargo": False},
    "77W": {"name": "Boeing 777-300ER", "wingspan": 65, "jetbridge_required": 1, "cargo": False},
    "76F": {"name": "Boeing 767-300F (freighter)", "wingspan": 48, "jetbridge_required": 0, "cargo": True},
    "77F": {"name": "Boeing 777F (freighter)", "wingspan": 65, "jetbridge_required": 0, "cargo": True},
}
NARROW = ["E75", "73G", "321", "7M8"]
WIDE = ["333", "789", "77W"]
FREIGHT = ["76F", "77F"]
DOM = ["YVR", "YUL", "YOW", "YYC", "YHZ", "YYJ", "YEG", "YWG", "YQB"]
INTL = ["LHR", "CDG", "FRA", "NRT", "DXB", "JFK", "LAX", "SFO", "AMS", "ORD"]
CARRIERS = ["AC", "WS", "PD", "BA", "AF", "LH", "UA", "DL", "AA", "EK", "FX", "KL"]


def hhmm(m):
    m %= 24 * 60
    return f"{m // 60:02d}:{m % 60:02d}"


def key(m):
    return f"{m // 60:02d}{m % 60:02d}"


def layout(rng, n_flights, n_cargo_flights):
    gates = {}
    n_cargo = max(1, (n_cargo_flights + 3) // 4)
    n_dom = max(3, int(n_flights * rng.uniform(0.12, 0.24)))
    n_intl = max(3, int(n_flights * rng.uniform(0.10, 0.20)))
    for i in range(n_cargo):
        gates[f"C{i + 1}"] = {"gate_type": 0, "max_wingspan": rng.choice([52, 65, 80]), "dist": -1, "jetbridge": 0}
    gates["C1"]["max_wingspan"] = 80
    for prefix, n, t in (("D", n_dom, 1), ("I", n_intl, 2)):
        for i in range(n):
            wide = rng.random() < (0.25 if t == 1 else 0.55)
            gates[f"{prefix}{i + 1}"] = {
                "gate_type": t,
                "max_wingspan": rng.choice([65, 80]) if wide else rng.choice([36, 45, 52]),
                "dist": rng.randrange(60, 520, 10),
                "jetbridge": 1 if wide or rng.random() < 0.6 else 0,
            }
    # guarantee at least one wide-body jetbridge gate of each passenger type
    gates["D1"].update(max_wingspan=80, jetbridge=1)
    gates["I1"].update(max_wingspan=80, jetbridge=1)
    stations = {s: "domestic" for s in DOM}
    stations.update({s: "international" for s in INTL})
    return {"gate_info": gates, "aircraft_info": AIRCRAFT, "stations": stations}


def make_flight(rng, carrier, number, kind):
    intl = rng.random() < 0.4
    if kind == "cargo":
        ac = rng.choice(FREIGHT)
    else:
        ac = rng.choice(WIDE) if (intl and rng.random() < 0.6) or rng.random() < 0.08 else rng.choice(NARROW)
    other = rng.choice(INTL if intl else DOM)
    t = rng.randrange(6 * 60, 22 * 60, 5)
    shape = rng.choices(["turn", "orig", "term", "double", "overnight"], [55, 15, 15, 8, 7])[0]
    legs = []

    def leg(lt, dep, arr, d, a):
        legs.append({"legType": lt, "aircraftType": ac, "departureStation": dep, "arrivalStation": arr,
                     "scheduledDepartureTime": hhmm(d), "scheduledArrivalTime": hhmm(a)})

    if shape == "turn":
        ground = rng.choice([45, 60, 75, 90, 120, 150, 180])
        leg("Originating", other, "YYZ", t - 90, t)
        leg("Through", "YYZ", other, t + ground, t + ground + 90)
    elif shape == "orig":
        leg("Originating", "YYZ", other, t, t + 100)
    elif shape == "term":
        leg("Originating", other, "YYZ", t - 100, t)
    elif shape == "double":
        other2 = rng.choice(DOM)
        leg("Originating", other, "YYZ", t - 80, t)
        leg("Through", "YYZ", other2, t + 60, t + 140)
        leg("Through", other2, "YYZ", t + 200, t + 280)
        leg("Through", "YYZ", other, t + 340, t + 420)
    else:  # overnight
        t = rng.randrange(21 * 60, 23 * 60 + 30, 5)
        leg("Originating", other, "YYZ", t - 120, t)
        leg("Through", "YYZ", other, 6 * 60 + rng.randrange(0, 120, 5), 8 * 60 + 30)
    return {"action": "CreateFlight",
            "flight": {"carrier": carrier, "flightNumber": str(number), "flightSuffix": None,
                       "originatingDate": "2025-06-15"},
            "legs": legs, "_t": t}


def shift_legs(legs, delta):
    out = []
    for l in legs:
        l2 = dict(l)
        for k in ("scheduledDepartureTime", "scheduledArrivalTime"):
            h, m = map(int, l[k].split(":"))
            l2[k] = hhmm(h * 60 + m + delta)
        out.append(l2)
    return out


def first_presence(f):
    """Minute the flight first needs a gate (arrival, or departure - 60)."""
    for l in f["legs"]:
        if l["arrivalStation"] == "YYZ":
            h, m = map(int, l["scheduledArrivalTime"].split(":"))
            return h * 60 + m
        if l["departureStation"] == "YYZ":
            h, m = map(int, l["scheduledDepartureTime"].split(":"))
            return h * 60 + m - 60
    return None


def scenario(rng, n_flights, n_events):
    flights = []
    used = set()
    for _ in range(n_flights):
        carrier = rng.choice(CARRIERS)
        num = rng.randrange(100, 9999)
        while (carrier, num) in used:
            num = rng.randrange(100, 9999)
        used.add((carrier, num))
        kind = "cargo" if carrier == "FX" or rng.random() < 0.05 else "pax"
        flights.append(make_flight(rng, carrier, num, kind))
    n_cargo = sum(1 for f in flights if f["legs"][0]["aircraftType"] in FREIGHT)
    static = layout(rng, n_flights, n_cargo)
    ticks = {"0500": [{k: v for k, v in f.items() if k != "_t"} for f in flights]}
    cancelled = []
    gate_ids = list(static["gate_info"])
    touched = set()

    for _ in range(n_events):
        kind = rng.choices(["delay", "dep_delay", "equip", "cancel", "reinstate", "outage", "divert", "early"],
                           [30, 15, 10, 10, 5, 12, 12, 6])[0]
        f = rng.choice(flights)
        ident = f["flight"]
        start = first_presence(f)
        # flight news is announced 30-180 min before the aircraft needs its gate,
        # like the official scenarios; resource / diversion news at any time
        at = (start - rng.choice([30, 45, 60, 90, 120, 180])) if start is not None else 0
        if kind in ("outage", "divert", "reinstate"):
            at = rng.randrange(6 * 60, 21 * 60, 15)
        at = (at // 15) * 15
        if at <= 5 * 60 or at >= 23 * 60 + 45:
            continue
        if kind not in ("outage", "divert", "reinstate"):
            if ident["flightNumber"] in touched:
                continue
            touched.add(ident["flightNumber"])
        msg = None
        if kind in ("delay", "early"):
            delta = rng.choice([15, 30, 45, 60, 90, 120]) if kind == "delay" else -rng.choice([10, 15, 20])
            f["legs"] = shift_legs(f["legs"], delta)
            msg = {"action": "UpdateTiming", "flight": ident, "legs": f["legs"]}
        elif kind == "dep_delay":
            # departure-only delay (cascade_2 style): legs after the first YYZ departure move
            idx = next((i for i, l in enumerate(f["legs"]) if l["departureStation"] == "YYZ"), None)
            if idx is None or idx == 0:
                continue
            delta = rng.choice([20, 30, 45, 60, 90])
            f["legs"] = f["legs"][:idx] + shift_legs(f["legs"][idx:], delta)
            msg = {"action": "UpdateTiming", "flight": ident, "legs": f["legs"]}
        elif kind == "equip":
            new = rng.choice(WIDE if f["legs"][0]["aircraftType"] in NARROW else NARROW)
            if f["legs"][0]["aircraftType"] in FREIGHT:
                new = rng.choice(FREIGHT)
            for l in f["legs"]:
                l["aircraftType"] = new
            msg = {"action": "UpdateEquipment", "flight": ident,
                   "equipmentUpdate": {"scope": "AllLegs", "aircraftType": new}}
        elif kind == "cancel":
            if len(f["legs"]) > 1 and rng.random() < 0.3:
                l = f["legs"][-1]
                msg = {"action": "CancelFlight", "flight": ident,
                       "cancelScope": {"type": "SpecificLeg", "departureStation": l["departureStation"],
                                       "arrivalStation": l["arrivalStation"]}}
            else:
                msg = {"action": "CancelFlight", "flight": ident, "cancelScope": {"type": "AllLegs"}}
                cancelled.append(ident)
        elif kind == "reinstate" and cancelled:
            msg = {"action": "ReinstateFlight", "flight": cancelled.pop()}
        elif kind == "outage":
            g = rng.choice(gate_ids)
            start = at + rng.choice([0, 30, 60, 120])
            msg = {"action": "GateOutage", "gate": g, "scheduledStartTime": hhmm(start)}
            if rng.random() < 0.8:
                msg["scheduledEndTime"] = hhmm(start + rng.choice([60, 120, 240, 360]))
        elif kind == "divert":
            ac = rng.choice(NARROW + WIDE)
            arr = at + rng.choice([10, 15, 20, 30, 45])
            src = rng.choice(DOM + INTL)
            msg = {"action": "DivertFlight", "reason": rng.choice(["medical", "turnback", "diversion", "weather"]),
                   "flight": {"carrier": rng.choice(CARRIERS[:-1]), "flightNumber": str(rng.randrange(10, 99)),
                              "flightSuffix": rng.choice([None, "R", "D"]), "originatingDate": "2025-06-15"},
                   "legs": [{"legType": "Originating", "aircraftType": ac, "departureStation": src,
                             "arrivalStation": "YYZ", "scheduledDepartureTime": hhmm(arr - 70),
                             "scheduledArrivalTime": hhmm(arr)}]}
        if msg:
            ticks.setdefault(key(at), []).append(msg)
    return dict(sorted(ticks.items())), static


def feasible_every_tick(static, sched):
    """The official guarantee: after every update, all active flights can be
    placed at once with zero hard failures. Checked with CP-SAT."""
    from ortools.sat.python import cp_model
    from gms.messages import FlightStore, parse_gate_outage
    from gms.profile import flight_profile
    from gms.compat import hard_compatible
    from gms.timeutil import hhmm_key_to_min

    gates, ac, stations = static["gate_info"], static["aircraft_info"], static["stations"]
    store, outages = FlightStore(), {g: [] for g in gates}
    for k in sorted(sched, key=hhmm_key_to_min):
        t = hhmm_key_to_min(k)
        for msg in sched[k]:
            if msg.get("action") == "GateOutage":
                gid, w = parse_gate_outage(msg)
                outages[gid].append(w)
            else:
                store.apply(msg, t)
        profs = [flight_profile(st, ac, stations) for st in store.flights.values()]
        profs = [p for p in profs if p.has_yyz]
        m = cp_model.CpModel()
        per_gate = {g: [] for g in gates}
        for p in profs:
            lits = []
            for gid, g in gates.items():
                ok, _ = hard_compatible(p.category, p.wingspan, p.jetbridge_required, g)
                if not ok or any(s < we and ws < e for s, e in p.intervals for ws, we in outages[gid]):
                    continue
                x = m.NewBoolVar("")
                lits.append(x)
                for s, e in p.intervals:
                    per_gate[gid].append(m.NewOptionalFixedSizeIntervalVar(s, max(1, e - s), x, ""))
            if not lits:
                return False
            m.AddExactlyOne(lits)
        for ivs in per_gate.values():
            m.AddNoOverlap(ivs)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 10
        solver.parameters.num_workers = 8
        if solver.Solve(m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return False
    return True


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--out", default="generated")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--min-flights", type=int, default=12)
    ap.add_argument("--max-flights", type=int, default=90)
    ap.add_argument("--allow-infeasible", action="store_true")
    args = ap.parse_args(argv)
    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)
    made = tried = 0
    while made < args.n:
        tried += 1
        nf = rng.randint(args.min_flights, args.max_flights)
        sched, static = scenario(rng, nf, rng.randint(nf // 6 + 2, nf // 2 + 4))
        if not args.allow_infeasible and not feasible_every_tick(static, sched):
            continue
        i = made
        made += 1
        name = os.path.join(args.out, f"gen_{i:03d}_{nf}f")
        with open(name + ".json", "w") as fh:
            json.dump(sched, fh, indent=1)
        with open(name + ".static.json", "w") as fh:
            json.dump(static, fh, indent=1)
    print(f"wrote {args.n} scenarios to {args.out}/ ({tried - made} infeasible drafts rejected)")


if __name__ == "__main__":
    main()

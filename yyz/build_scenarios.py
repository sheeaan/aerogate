"""
Build the Pearson realism-layer scenarios (deterministic).

    python yyz/build_scenarios.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATE = "2025-06-15"


def hhmm(m):
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def t(s):
    h, m = map(int, s.split(":"))
    return h * 60 + m


def fid(carrier, num):
    return f"{carrier}-{num}-{DATE}"


def ident(carrier, num):
    return {"carrier": carrier, "flightNumber": str(num), "flightSuffix": None, "originatingDate": DATE}


def turn(carrier, num, ac, other, arr, ground, block=90):
    a = t(arr)
    return {"action": "CreateFlight", "flight": ident(carrier, num), "legs": [
        {"legType": "Originating", "aircraftType": ac, "departureStation": other, "arrivalStation": "YYZ",
         "scheduledDepartureTime": hhmm(a - block), "scheduledArrivalTime": hhmm(a)},
        {"legType": "Through", "aircraftType": ac, "departureStation": "YYZ", "arrivalStation": other,
         "scheduledDepartureTime": hhmm(a + ground), "scheduledArrivalTime": hhmm(a + ground + block)}]}


def delay(msg, minutes, dep_only=False):
    legs = []
    for i, l in enumerate(msg["legs"]):
        l2 = dict(l)
        if not dep_only or i > 0:
            for k in ("scheduledDepartureTime", "scheduledArrivalTime"):
                l2[k] = hhmm(t(l[k]) + minutes)
        legs.append(l2)
    return {"action": "UpdateTiming", "flight": msg["flight"], "legs": legs}


DOMESTIC = [
    ("AC", 401, "321", "YUL", "15:40", 55), ("AC", 403, "7M8", "YOW", "16:05", 50),
    ("WS", 657, "73G", "YYC", "16:20", 60), ("PD", 233, "E75", "YOW", "16:35", 45),
    ("AC", 117, "789", "YVR", "16:50", 90), ("AC", 405, "321", "YUL", "17:15", 50),
    ("WS", 661, "7M8", "YWG", "17:30", 55), ("AC", 1153, "321", "YHZ", "17:50", 60),
    ("PD", 241, "E75", "YQB", "18:05", 40), ("AC", 409, "321", "YUL", "18:20", 50),
    ("WS", 669, "73G", "YEG", "18:40", 60), ("AC", 125, "333", "YVR", "19:00", 80),
    ("AC", 411, "7M8", "YOW", "19:30", 45), ("WS", 673, "73G", "YYC", "20:00", 60),
]
TRANSBORDER = [
    ("AC", 760, "7M8", "LGA", "15:50", 60), ("UA", 3478, "E75", "EWR", "16:10", 50),
    ("AA", 4021, "E75", "ORD", "16:25", 55), ("DL", 5011, "321", "ATL", "16:45", 60),
    ("AC", 790, "321", "LAX", "17:05", 70), ("AC", 762, "7M8", "BOS", "17:25", 55),
    ("UA", 3522, "E75", "ORD", "17:40", 50), ("AC", 1650, "7M8", "MIA", "18:00", 60),
    ("AA", 4055, "E75", "JFK", "18:15", 55), ("AC", 768, "321", "SFO", "18:45", 70),
    ("AA", 2311, "321", "DFW", "19:10", 60),
]
INTERNATIONAL = [
    ("AC", 857, "789", "LHR", "15:30", 120), ("BA", 99, "77W", "LHR", "16:00", 130),
    ("LH", 470, "333", "FRA", "16:40", 120), ("AC", 873, "789", "FRA", "17:10", 120),
    ("EK", 241, "77W", "DXB", "17:30", 140), ("KL", 691, "333", "AMS", "18:00", 120),
    ("AF", 356, "789", "CDG", "19:00", 120),
]
CARGO = [("FX", 1201, "76F", "YUL", "17:00", 120), ("FX", 1207, "76F", "YVR", "19:30", 90)]

CONNECTIONS = [
    ("AC", 857, "AC", 405, 38), ("AC", 873, "AC", 409, 45), ("AC", 873, "AC", 125, 30),
    ("AC", 760, "AC", 1153, 22), ("AC", 790, "AC", 405, 18), ("AC", 117, "AC", 873, 52),
    ("AC", 1650, "AC", 411, 25), ("AC", 768, "AC", 125, 34),
]


def one_way(carrier, num, ac, other, when, inbound, block=90):
    """Originating departure (YYZ -> other) or terminating arrival (other -> YYZ)."""
    w = t(when)
    leg = ({"departureStation": other, "arrivalStation": "YYZ", "scheduledDepartureTime": hhmm(w - block), "scheduledArrivalTime": hhmm(w)}
           if inbound else
           {"departureStation": "YYZ", "arrivalStation": other, "scheduledDepartureTime": hhmm(w), "scheduledArrivalTime": hhmm(w + block)})
    leg.update({"legType": "Originating", "aircraftType": ac})
    return {"action": "CreateFlight", "flight": ident(carrier, num), "legs": [leg]}


def extra_traffic(taken):
    """A denser, repeatable evening: more turns, originating departures and late arrivals."""
    import random
    rng = random.Random(2026)
    dom = ["YUL", "YOW", "YVR", "YYC", "YHZ", "YWG", "YEG", "YQB", "YXE", "YYJ"]
    usa = ["LGA", "EWR", "ORD", "LAX", "SFO", "BOS", "MIA", "ATL", "DFW", "DEN", "IAD", "JFK"]
    intl = ["LHR", "CDG", "FRA", "AMS", "DXB", "NRT", "HKG", "MEX", "FCO", "DEL", "ZRH", "MUC"]
    out = []

    def num(carrier, lo, hi):
        while True:
            n = rng.randrange(lo, hi)
            if (carrier, n) not in taken:
                taken.add((carrier, n))
                return n

    def clock(lo, hi):
        return hhmm(rng.randrange(t(lo) // 5, t(hi) // 5) * 5)

    for _ in range(16):     # domestic turns
        c = rng.choice(["AC", "AC", "WS", "PD", "F8"])
        out.append(turn(c, num(c, 300, 1999), rng.choice(["E75", "73G", "7M8", "321"]), rng.choice(dom),
                        clock("15:20", "21:00"), rng.choice([45, 50, 55, 60, 70])))
    for _ in range(8):      # US transborder turns
        c = rng.choice(["AC", "UA", "AA", "DL"])
        out.append(turn(c, num(c, 2000, 4999), rng.choice(["E75", "7M8", "321"]), rng.choice(usa),
                        clock("15:20", "21:00"), rng.choice([50, 55, 60, 70])))
    for _ in range(1):      # international turns
        c = rng.choice(["AC", "LH", "BA", "TK", "AF"])
        out.append(turn(c, num(c, 30, 999), rng.choice(["789", "333", "77W"]), rng.choice(intl),
                        clock("15:40", "19:30"), rng.choice([110, 120, 130]), block=420))
    for _ in range(18):     # originating departures: the aircraft was on the stand already
        kind = rng.random()
        if kind < 0.6:
            c, ac, dst = rng.choice(["AC", "WS", "PD", "F8"]), rng.choice(["E75", "73G", "7M8", "321"]), rng.choice(dom)
        elif kind < 0.92:
            c, ac, dst = rng.choice(["AC", "UA", "AA", "DL"]), rng.choice(["E75", "7M8", "321"]), rng.choice(usa)
        else:
            c, ac, dst = rng.choice(["AC", "AC", "EK", "LH"]), rng.choice(["789", "77W"]), rng.choice(intl)
        out.append(one_way(c, num(c, 5000, 8999), ac, dst, clock("15:10", "22:00"), inbound=False))
    for _ in range(6):      # late terminating arrivals that stay overnight
        c = rng.choice(["AC", "WS", "PD"])
        out.append(one_way(c, num(c, 9000, 9899), rng.choice(["73G", "7M8", "321"]), rng.choice(dom), clock("20:30", "22:30"), inbound=True))
    return out


def evening_bank():
    flights = {}
    for row in DOMESTIC + TRANSBORDER + INTERNATIONAL + CARGO:
        c, n, ac, other, arr, ground = row
        flights[(c, n)] = turn(c, n, ac, other, arr, ground, block=420 if row in INTERNATIONAL else 90)
    sched = {"1500": list(flights.values()) + extra_traffic(set(flights))}
    sched["1600"] = [{"action": "GateOutage", "gate": "E69/F69", "scheduledStartTime": "17:00", "scheduledEndTime": "20:00"}]
    storm = [(("AC", 873), 50), (("EK", 241), 35), (("LH", 470), 60), (("AC", 762), 45),
             (("UA", 3522), 40), (("WS", 661), 50), (("AC", 405), 55)]
    sched["1615"] = [delay(flights[k], m) for k, m in storm]
    sched["1745"] = [{"action": "DivertFlight", "reason": "medical",
                      "flight": {"carrier": "LX", "flightNumber": "40", "flightSuffix": "D", "originatingDate": DATE},
                      "legs": [{"legType": "Originating", "aircraftType": "77W", "departureStation": "ZRH",
                                "arrivalStation": "YYZ", "scheduledDepartureTime": "10:30",
                                "scheduledArrivalTime": "18:05"}]}]
    sched["1800"] = [{"action": "UpdateEquipment", "flight": ident("AC", 768),
                      "equipmentUpdate": {"scope": "AllLegs", "aircraftType": "789"}}]
    sched["1830"] = [{"action": "CancelFlight", "flight": ident("WS", 669), "cancelScope": {"type": "AllLegs"}},
                     delay(flights[("AF", 356)], 45, dep_only=True)]
    conns = [{"arr": fid(a, b), "dep": fid(c, d), "pax": p} for a, b, c, d, p in CONNECTIONS]
    return {"static": "yyz/pearson_t1.json", "connections": conns, "schedule": sched,
            "_description": "Evening bank at Toronto Pearson Terminal 1 (real gates from OpenStreetMap): jetbridge failure on swing gate E69/F69, "
                            "thunderstorm bunching seven arrivals, a 777 medical diversion, a 787 swap on a "
                            "US flight, a cancellation and a late departure."}


def main():
    out = os.path.join(HERE, "scenarios")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "pearson_evening_bank.json"), "w") as fh:
        json.dump(evening_bank(), fh, indent=1)
    print("wrote yyz/scenarios/pearson_evening_bank.json")


if __name__ == "__main__":
    main()

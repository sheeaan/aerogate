"""
Build the Pearson layout from OpenStreetMap data.

    python yyz/build_osm_layout.py            # reads yyz/osm/yyz_osm.json

Inputs: an Overpass extract of CYYZ (aeroway gates, parking positions,
terminals, aprons, taxiways). Map data (c) OpenStreetMap contributors, ODbL.

Outputs:
  yyz/pearson_t1.json            gates the simulator uses (real gate refs, stand
                                 geometry, estimated sizes, wingtip limits)
  dashboard/static/yyz_osm.json  vector overlay for the dashboard map

What comes from OSM: gate names (incl. dual-named swing gates like E67/F67),
stand centrelines (position + nose-in heading), terminal/apron/taxiway shapes.
What is estimated: stand size (widebody if the stand is long or has MARS A/B
sub-stands), walking distances (straight line x 1.3 from the terminal centre),
wingtip limits (from the real spacing between neighbouring stand centrelines).
"""

import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "osm", "yyz_osm.json")

# Terminal 1 gates modelled in the scenario, by role
DOMESTIC = ["D20", "D22", "D24", "D26", "D31", "D33", "D35", "D37", "D39"]
SWING_DF = ["D32/F32", "D34/F34", "D36/F36", "D51/F51", "D53/F53"]
TRANSBORDER = ["F60", "F61", "F62", "F63", "F65"]
SWING_EF = ["E67/F67", "E68/F68", "E69/F69", "E71/F71"]
INTERNATIONAL = ["E70", "E72", "E73", "E74", "E75", "E76", "E77"]
HOLD_TAXIWAY = 641695705       # main taxiway south of the hammerhead
LAT0 = 43.68
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def metres(a, b):
    return math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * KX)


def length(pts):
    return sum(metres(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def point_along(pts, dist):
    for i in range(len(pts) - 1):
        seg = metres(pts[i], pts[i + 1])
        if dist <= seg or i == len(pts) - 2:
            f = min(1.0, dist / seg) if seg else 0
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f)
        dist -= seg
    return pts[-1]


# ---------------------------------------------------------------------------
# Taxi routing on the OSM taxiway graph
# ---------------------------------------------------------------------------
# west flow, the usual Pearson setup: land on 24R and 24L, depart from 23
ARR_RUNWAYS = [("06L/24R", "24R"), ("06R/24L", "24L")]
DEP_RUNWAY = ("05/23", "23")


def build_graph(osm):
    import heapq  # noqa: F401  (used by dijkstra)
    coord, adj = {}, {}
    for e in osm:
        t = e.get("tags", {})
        kind = t.get("aeroway")
        if e["type"] != "way" or kind not in ("taxiway", "taxilane", "runway"):
            continue
        pen = 12.0 if kind == "runway" else 1.0       # stay off runways except to cross them
        for nid, p in zip(e["nodes"], e["geometry"]):
            coord[nid] = (p["lat"], p["lon"])
        for a, b in zip(e["nodes"], e["nodes"][1:]):
            w = metres(coord[a], coord[b]) * pen
            adj.setdefault(a, []).append((b, w))
            adj.setdefault(b, []).append((a, w))
    return coord, adj


def dijkstra(adj, src, dst):
    import heapq
    dist_, prev, seen = {src: 0.0}, {}, set()
    q = [(0.0, src)]
    while q:
        d, u = heapq.heappop(q)
        if u in seen:
            continue
        seen.add(u)
        if u == dst:
            break
        for v, w in adj.get(u, []):
            nd = d + w
            if nd < dist_.get(v, 1e18):
                dist_[v], prev[v] = nd, u
                heapq.heappush(q, (nd, v))
    if dst not in seen:
        return None
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    return path[::-1]


def nearest_node(coord, adj, p, exclude_runway_only=None):
    best, bd = None, 1e18
    for nid, c in coord.items():
        if nid not in adj or (exclude_runway_only and nid in exclude_runway_only):
            continue
        d = metres(c, p)
        if d < bd:
            best, bd = nid, d
    return best


def thin(pts, step=8):
    out = [pts[0]]
    for p in pts[1:-1]:
        if metres(out[-1], p) >= step:
            out.append(p)
    out.append(pts[-1])
    return [[round(a, 6), round(b, 6)] for a, b in out]


def seg_dist(p, line):
    """Shortest distance in metres from point p to a polyline."""
    best = 1e18
    for a, b in zip(line, line[1:]):
        ax, ay = (a[1] - p[1]) * KX, (a[0] - p[0]) * KY
        bx, by = (b[1] - p[1]) * KX, (b[0] - p[0]) * KY
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        u = max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
        best = min(best, math.hypot(ax + u * dx, ay + u * dy))
    return best


def project(p, bearing_deg, d):
    r = math.radians(bearing_deg)
    return (p[0] + d * math.cos(r) / KY, p[1] + d * math.sin(r) / KX)


def runway_way(osm, ref):
    ways = [e for e in osm if e["type"] == "way" and e.get("tags", {}).get("aeroway") == "runway" and e["tags"].get("ref") == ref]
    return max(ways, key=lambda e: len(e["geometry"]))


def westbound(way):
    """Node ids and points of a runway, ordered from the east (24/23) threshold."""
    ids, pts = way["nodes"], [(p["lat"], p["lon"]) for p in way["geometry"]]
    if pts[0][1] < pts[-1][1]:
        ids, pts = ids[::-1], pts[::-1]
    return ids, pts


def heading(pts):
    a, b = pts[0], pts[-1]
    return math.degrees(math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY)) % 360


def runway_ops(osm, coord, adj):
    """Per landing runway: approach, exits and centreline. Departure runway: roll and climb."""
    taxi_nodes = set()
    for e in osm:
        if e["type"] == "way" and e.get("tags", {}).get("aeroway") in ("taxiway", "taxilane"):
            taxi_nodes.update(e["nodes"])
    t1 = next(e for e in osm if e["type"] == "way" and e.get("tags", {}).get("name") == "Terminal 1")
    t1c = (sum(p["lat"] for p in t1["geometry"]) / len(t1["geometry"]), sum(p["lon"] for p in t1["geometry"]) / len(t1["geometry"]))
    arrs = []
    for osm_ref, ref in ARR_RUNWAYS:
        ids, pts = westbound(runway_way(osm, osm_ref))
        # exits: taxiway junctions 1.1-2.7 km down the runway; the default is the one nearest the terminal
        run, cands = 0.0, []
        for i in range(1, len(pts)):
            run += metres(pts[i - 1], pts[i])
            if 1100 <= run <= 2700 and ids[i] in taxi_nodes:
                cands.append(i)
        exit_i = min(cands, key=lambda i: metres(pts[i], t1c)) if cands else len(pts) // 2
        exits = [{"node": ids[i], "roll": thin(pts[: i + 1])} for i in cands] or [{"node": ids[exit_i], "roll": thin(pts[: exit_i + 1])}]
        arrs.append({"ref": ref, "osm_ref": osm_ref, "exits_node": exits,
                     "approach": thin([project(pts[0], (heading(pts) + 180) % 360, 6000), pts[0]], 500),
                     "roll": thin(pts[: exit_i + 1]), "line": thin(pts)})
    dids, dpts = westbound(runway_way(osm, DEP_RUNWAY[0]))
    # take-off roll ~2.2 km then climb out along the runway heading
    roll, acc = [dpts[0]], 0.0
    for i in range(1, len(dpts)):
        acc += metres(dpts[i - 1], dpts[i])
        roll.append(dpts[i])
        if acc >= 2200:
            break
    dep = {"ref": DEP_RUNWAY[1], "threshold_node": dids[0], "line": thin(dpts),
           "roll": thin(roll), "climb": thin([roll[-1], project(roll[-1], heading(dpts), 6000)], 500)}
    return {"arrs": arrs, "dep": dep}


def hold_spots(osm, coord, adj, index, out_gates, near, centre, k=10):
    """Holding spots: nodes on real taxiways (not apron taxilanes) that no taxi route comes within
    80 m of, no stand within 80 m and no runway within 150 m, nearest the arrival flow first and at
    least 150 m apart. Aircraft waiting for a gate taxi there instead of stopping on the apron."""
    def grid(lines):
        G = {}
        for line in lines:
            pts = [tuple(p) for p in line]
            for a, b in zip(pts, pts[1:]):
                n = max(1, int(metres(a, b) // 10))
                for j in range(n + 1):
                    p = (a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n)
                    G.setdefault((int(p[0] * KY // 100), int(p[1] * KX // 100)), []).append(p)
        return G

    def clear(G, p, r):
        cx, cy = int(p[0] * KY // 100), int(p[1] * KX // 100)
        return all(metres(p, q) >= r for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2) for q in G.get((cx + dx, cy + dy), ()))

    used = []
    for g in out_gates:
        r = g["routes"]
        for a in r["arr"].values():
            used += [a["in"], *a["in_hold"]]
        used.append(r["out"])
    ways = lambda kind: [[(p["lat"], p["lon"]) for p in e["geometry"]] for e in osm  # noqa: E731
                         if e["type"] == "way" and e.get("tags", {}).get("aeroway") == kind]
    G_used, G_stand, G_rwy = grid(used), grid(ways("parking_position")), grid(ways("runway"))
    rwy_lines = ways("runway")

    def xy_(p):
        return ((p[1] - centre[1]) * KX, (p[0] - centre[0]) * KY)

    def crosses(a, b, c, d):                       # do segments ab and cd intersect (local metres)
        o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])  # noqa: E731
        return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0

    def terminal_side(p):                          # no runway between the spot and the terminal
        a, b = xy_(p), (0.0, 0.0)
        return not any(crosses(a, b, xy_(q), xy_(r)) for line in rwy_lines for q, r in zip(line, line[1:]))
    cands = []
    for e in osm:
        if e["type"] != "way" or e.get("tags", {}).get("aeroway") != "taxiway":
            continue
        ids = e["nodes"]
        for i, nid in enumerate(ids):
            if nid not in index:
                continue
            p = coord[nid]
            if metres(p, centre) > 3000 or not (clear(G_used, p, 80) and clear(G_stand, p, 80) and clear(G_rwy, p, 150)
                                                and terminal_side(p)):
                continue
            a, b = coord.get(ids[max(0, i - 1)], p), coord.get(ids[min(len(ids) - 1, i + 1)], p)
            hdg = math.degrees(math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY)) % 360
            cands.append((metres(p, near), nid, hdg))
    spots = []
    for _, nid, hdg in sorted(cands):
        if all(metres(coord[nid], coord[s[0]]) >= 150 for s in spots):
            spots.append((nid, hdg))
        if len(spots) == k:
            break
    return [{"p": [round(coord[n][0], 6), round(coord[n][1], 6)], "hdg": round(h), "node": index[n]} for n, h in spots]


def route(coord, adj, a, b):
    path = dijkstra(adj, a, b)
    return [coord[n] for n in path] if path else None


def main():
    with open(SRC) as fh:
        osm = json.load(fh)["elements"]
    gates = {}
    for e in osm:
        t = e.get("tags", {})
        if e["type"] == "node" and t.get("aeroway") == "gate" and t.get("ref"):
            gates.setdefault(t["ref"], (e["lat"], e["lon"]))
    stands = {}
    for e in osm:
        t = e.get("tags", {})
        if e["type"] == "way" and t.get("aeroway") == "parking_position" and t.get("ref"):
            stands[str(t["ref"])] = [(p["lat"], p["lon"]) for p in e["geometry"]]
    t1 = next(e for e in osm if e["type"] == "way" and e.get("tags", {}).get("name") == "Terminal 1")
    t1pts = [(p["lat"], p["lon"]) for p in t1["geometry"]]
    centre = (sum(p[0] for p in t1pts) / len(t1pts), sum(p[1] for p in t1pts) / len(t1pts))

    def xy(p):
        return [round((p[1] - centre[1]) * KX), round((p[0] - centre[0]) * KY)]

    out_gates = []
    roles = ([(g, ["domestic"], "D") for g in DOMESTIC] + [(g, ["domestic", "transborder"], "D") for g in SWING_DF]
             + [(g, ["transborder"], "F") for g in TRANSBORDER] + [(g, ["international", "transborder"], "E") for g in SWING_EF]
             + [(g, ["international"], "E") for g in INTERNATIONAL])
    for ref, zones, pier in roles:
        gpos = gates[ref]
        num = re.match(r"^[DEF](\d+)", ref).group(1)
        stand_ref = "1" + num.zfill(2)
        line = stands.get(stand_ref)
        if line is None:   # MARS-only stands (e.g. 168A/168B): use the first sub-stand
            sub = sorted(k for k in stands if re.match(rf"^{stand_ref}[A-Z]$", k))
            line = stands[sub[0]] if sub else None
        if line is None:
            raise SystemExit(f"no stand line for {ref} ({stand_ref})")
        if metres(line[-1], gpos) < metres(line[0], gpos):
            line = line[::-1]                       # nose end (nearest the gate) first
        L = length(line)
        mars = any(re.match(rf"^{stand_ref}[A-Z]$", k) for k in stands)
        wide = mars or L >= 100
        group = {"D": "Pier D", "F": "Pier F (US pre-clearance)", "E": "Pier E (international)"}[pier]
        if len(zones) > 1:
            group = "Swing gates D/F" if pier == "D" else "Swing gates E/F"
        out_gates.append({
            "id": ref, "group": group, "zones": zones, "pier": pier,
            "max_wingspan": 65 if wide else 36, "jetbridge": 1,
            "dist": int(round(metres(gpos, centre) * 1.3 / 10) * 10),
            "xy": xy(gpos), "sweep": 30 if len(zones) > 1 else 0,
            "gate_ll": [round(gpos[0], 6), round(gpos[1], 6)],
            "stand": {"ref": stand_ref, "line": [[round(a, 6), round(b, 6)] for a, b in line], "mars": mars},
            "size_note": "estimated from stand length" + (" and MARS sub-stands" if mars else ""),
        })

    # cargo: the two stand lines nearest the Cargo West apron centre
    cw = next(e for e in osm if e.get("tags", {}).get("name") == "Cargo West")
    cwc = (sum(p["lat"] for p in cw["geometry"]) / len(cw["geometry"]), sum(p["lon"] for p in cw["geometry"]) / len(cw["geometry"]))
    near = sorted(stands.items(), key=lambda kv: metres(kv[1][len(kv[1]) // 2], cwc))[:2]
    for i, (sref, line) in enumerate(near):
        out_gates.append({"id": f"CW{sref}", "group": "Cargo West apron", "zones": ["cargo"], "pier": "C",
                          "max_wingspan": 65, "jetbridge": 0, "dist": -1, "sweep": 0,
                          "gate_ll": [round(line[0][0], 6), round(line[0][1], 6)],
                          "stand": {"ref": sref, "line": [[round(a, 6), round(b, 6)] for a, b in line], "mars": False},
                          "size_note": "cargo stand, size estimated"})

    # wingtip limits from real spacing: side-by-side stands need
    # (span1 + span2) / 2 + 7.5 m clearance <= centreline spacing
    adjacency = []
    probe = {g["id"]: point_along([tuple(p) for p in g["stand"]["line"]], 40) for g in out_gates}
    ids = [g["id"] for g in out_gates]
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            d = metres(probe[a], probe[b])
            if d < 75:
                # contact stands always fit two narrowbodies abreast (OSM lines can converge at corners)
                limit = max(76, round(2 * (d - 7.5)))
                if limit < 130:
                    adjacency.append([a, b, limit])

    hold = next(e for e in osm if e["id"] == HOLD_TAXIWAY)
    hold_line = [[round(p["lat"], 6), round(p["lon"], 6)] for p in hold["geometry"]]

    coord, adj = build_graph(osm)
    ops = runway_ops(osm, coord, adj)
    # the taxiway network for the browser, which routes aircraft to holding spots (runway edges carry the x12 penalty)
    node_ids = list(adj.keys())
    index = {n: i for i, n in enumerate(node_ids)}
    taxi_graph = {"nodes": [[round(coord[n][0], 6), round(coord[n][1], 6)] for n in node_ids],
                  "edges": [[index[a], index[b], round(w, 1)] for a in node_ids for b, w in adj[a] if index[a] < index[b]]}
    hold_node = min((n for n in hold["nodes"] if n in adj), key=lambda n: metres(coord[n], centre))
    runway_nodes = set()
    for e in osm:
        if e["type"] == "way" and e.get("tags", {}).get("aeroway") == "runway":
            runway_nodes.update(e["nodes"])
    for g in out_gates:
        tail = tuple(g["stand"]["line"][-1])
        tn = nearest_node(coord, adj, tail, exclude_runway_only=runway_nodes)
        g["routes"] = {"arr": {}, "tail_node": index[tn]}
        for rw in ops["arrs"]:
            # pick the exit off this runway that gives this gate the shortest taxi
            best = None
            for ex in rw["exits_node"]:
                r_ = route(coord, adj, ex["node"], tn)
                if r_ and (best is None or length(r_) < length(best[1])):
                    best = (ex, r_)
            if best is None:
                raise SystemExit(f"no taxi route from {rw['ref']} to {g['id']}")
            ex, a_in = best
            a_h1 = route(coord, adj, ex["node"], hold_node)
            a_h2 = route(coord, adj, hold_node, tn)
            if not (a_h1 and a_h2):
                raise SystemExit(f"no holding route from {rw['ref']} to {g['id']}")
            g["routes"]["arr"][rw["ref"]] = {"roll": ex["roll"], "in": thin(a_in + [tail]), "exit_node": index[ex["node"]],
                                             "in_hold": [thin(a_h1), thin(a_h2 + [tail])]}
        a_out = route(coord, adj, tn, ops["dep"]["threshold_node"])
        if not a_out:
            raise SystemExit(f"no taxi-out route for {g['id']}")
        g["routes"]["out"] = thin([tail] + a_out)
    runways = {"arrs": [{k: v for k, v in rw.items() if not k.endswith("_node") and k != "osm_ref"} for rw in ops["arrs"]],
               "dep": {k: v for k, v in ops["dep"].items() if not k.endswith("_node")},
               "hold_point": [round(coord[hold_node][0], 6), round(coord[hold_node][1], 6)]}
    spots = hold_spots(osm, coord, adj, index, out_gates, coord[hold_node], centre)

    out_path = os.environ.get("YYZ_LAYOUT_OUT") or os.path.join(HERE, "pearson_t1.json")
    with open(os.path.join(HERE, "pearson_t1.json")) as fh:
        old = json.load(fh)
    layout = {
        "_note": "Gates, stands and terminal geometry from OpenStreetMap (c) OpenStreetMap contributors, ODbL. "
                 "Stand sizes, walking distances and baggage capacities are estimates for the demo.",
        "gates": out_gates,
        "adjacency": adjacency,
        "aircraft_info": old["aircraft_info"],
        "stations": old["stations"],
        "map": {
            "center": [round(centre[0], 6), round(centre[1], 6)],
            "holding_line": hold_line,
            "runways": runways,
            "hold_spots": spots,
            "taxi_graph": taxi_graph,
            "zones": {
                "D": {"label": "Pier D (domestic, D/F swing)", "capacity": 1600},
                "F": {"label": "Pier F (US pre-clearance)", "capacity": 800},
                "E": {"label": "Pier E and E/F swing (international)", "capacity": 1800},
                "C": {"label": "Cargo West apron", "capacity": 0},
            },
        },
    }
    with open(out_path, "w") as fh:
        json.dump(layout, fh, indent=1)
    if os.environ.get("YYZ_LAYOUT_OUT"):
        return

    # vector overlay for the dashboard (terminals, aprons, taxiways, stands)
    feats = []
    for e in osm:
        t = e.get("tags", {})
        if e["type"] != "way":
            continue
        kind = t.get("aeroway") or ("terminal" if t.get("building") == "terminal" else None)
        if kind not in ("terminal", "apron", "taxiway", "taxilane", "runway", "parking_position"):
            continue
        coords = [[round(p["lon"], 6), round(p["lat"], 6)] for p in e["geometry"]]
        closed = coords[0] == coords[-1] and kind in ("terminal", "apron")
        feats.append({"type": "Feature", "properties": {"kind": kind, "ref": t.get("ref"), "name": t.get("name")},
                      "geometry": {"type": "Polygon", "coordinates": [coords]} if closed else
                      {"type": "LineString", "coordinates": coords}})
    with open(os.path.join(ROOT, "dashboard", "static", "yyz_osm.json"), "w") as fh:
        json.dump({"type": "FeatureCollection", "attribution": "(c) OpenStreetMap contributors, ODbL", "features": feats}, fh)
    print(f"{len(out_gates)} gates, {len(adjacency)} wingtip pairs, overlay {len(feats)} features")
    for g in out_gates[:3] + out_gates[-3:]:
        r = g["routes"]
        ins = ", ".join(f"from {k} {round(length([tuple(p) for p in v['in']]))} m" for k, v in r["arr"].items())
        print(f"  route {g['id']:8} taxi-in {ins}; taxi-out to {DEP_RUNWAY[1]} {round(length([tuple(p) for p in r['out']]))} m")
    for g in out_gates:
        print(f"  {g['id']:10} {g['group']:28} {g['max_wingspan']} m  walk {g['dist']} m")
    for a in adjacency:
        print("  wingtip", a)


if __name__ == "__main__":
    main()

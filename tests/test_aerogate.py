"""AeroGate solver, safety net, Pearson layer and dashboard API."""

import contextlib
import io
import json
import os

import pytest

from conftest import ROOT, SCENARIOS, scenario_path


def _run(static, scenario, solution):
    from evaluator import run_sim
    with contextlib.redirect_stdout(io.StringIO()):
        return run_sim(static, scenario, solution, verbose=False)


# --- evaluator: correctness and score ------------------------------------
@pytest.mark.parametrize("name", SCENARIOS)
def test_no_hard_failures_on_samples(static_path, name):
    r = _run(static_path, scenario_path(name), "solution_aerogate")
    assert r["status"] == "OK", r["reason"]
    assert r["unassigned"] == []


def test_beats_provided_greedy_overall(static_path):
    ours = sum(_run(static_path, scenario_path(n), "solution_aerogate")["score"] for n in SCENARIOS)
    theirs = sum(_run(static_path, scenario_path(n), "solution_scored")["score"] for n in SCENARIOS)
    assert ours < theirs


def test_deterministic(static_path):
    a = _run(static_path, scenario_path("busy_day"), "solution_aerogate")
    b = _run(static_path, scenario_path("busy_day"), "solution_aerogate")
    assert a["score"] == b["score"]


# --- safety net -------------------------------------------------------------
def test_decide_survives_malformed_observation():
    from solution_aerogate import decide
    out = decide({"time": 600, "gates": {}, "waiting_flights": {"X": {"bad": 1}}})
    assert out == {"assignments": [], "reassignments": []} or isinstance(out, dict)


def test_replay_drops_illegal_assignment():
    from aerogate.adapter import replay
    obs = {
        "gates": {"D1": {"gate_type": 1, "max_wingspan": 40, "dist": 100, "jetbridge": 0}},
        "gate_outages": {}, "gate_assignments": {"D1": []}, "assigned_flights": {}, "changed_flights": {},
        "waiting_flights": {"W": {"intervals": [(600, 660)], "category": 1, "wingspan": 60, "jetbridge_required": True}},
    }
    kept, moves, errors = replay(obs, [("W", "D1")], [])
    assert kept == [] and errors


def test_swap_is_never_proposed():
    """Two flagged flights that would each like the other's gate: the moves
    must be orderable (the evaluator applies them one at a time)."""
    from aerogate.adapter import problem_from_observation, to_actions
    from aerogate.solver import solve
    gates = {g: {"gate_type": 2, "max_wingspan": 65, "dist": d, "jetbridge": 1} for g, d in (("I1", 300), ("I2", 100))}
    view = lambda iv: {"intervals": iv, "category": 2, "wingspan": 60, "jetbridge_required": True, "legs": []}  # noqa: E731
    obs = {
        "time": 300, "gates": gates, "gate_outages": {},
        "gate_assignments": {"I1": [{"flight_id": "A", "intervals": [(600, 700)]}],
                             "I2": [{"flight_id": "B", "intervals": [(600, 700)]}]},
        "assigned_flights": {"A": dict(view([(600, 700)]), gate_id="I1"), "B": dict(view([(600, 700)]), gate_id="I2")},
        "changed_flights": {}, "waiting_flights": {},
    }
    p = problem_from_observation(obs)
    plan = solve(p)
    assigns, moves, stuck = to_actions(obs, p, plan)
    assert not stuck


# --- Pearson realism layer ---------------------------------------------------
def test_pearson_layer_runs_and_respects_rules():
    from yyz.sim import run_yyz
    with open(os.path.join(ROOT, "yyz", "scenarios", "pearson_evening_bank.json")) as fh:
        out = run_yyz(json.load(fh), time_limit=1.0)
    assert out["result"]["status"] == "OK"
    gates = {g["id"]: g for g in out["gates"]}
    final = out["ticks"][-1]
    for gid, bookings in final["plan"].items():
        for b in bookings:
            info = final["flights"][b["flight_id"]]
            assert info["category"] in gates[gid]["zones"], (b["flight_id"], gid)
            assert info["wingspan"] <= gates[gid]["max_wingspan"]
            assert b.get("hold", 0) <= 180          # APPR limit
    # wingtip clearance between neighbours
    for g1, g2, lim in out["adjacency"]:
        for a in final["plan"].get(g1, []):
            for b in final["plan"].get(g2, []):
                overlap = any(x[0] < y[1] and y[0] < x[1] for x in a["intervals"] for y in b["intervals"])
                if overlap:
                    ws = final["flights"][a["flight_id"]]["wingspan"] + final["flights"][b["flight_id"]]["wingspan"]
                    assert ws <= lim


# --- dashboard API -------------------------------------------------------------
@pytest.fixture(scope="module")
def server():
    cwd = os.getcwd()
    import dashboard.server as srv
    yield srv
    os.chdir(cwd)


def test_dashboard_run_and_override_check(server):
    payload = server.run_payload("flight_data/equipment_upgrade", "solution_aerogate")
    assert payload["result"]["status"] == "OK"
    assert payload["ticks"][0]["audit"]["entries"]
    tick = len(payload["ticks"]) - 1
    fid = next(iter(payload["ticks"][tick]["flights"]))
    # a 787 (60 m, needs jetbridge) cannot go to D3 (45 m, no jetbridge)
    bad = server.check_override(payload["run_id"], tick, [], (fid, "D3"))
    assert not bad["ok"] and any("wingspan" in v or "jetbridge" in v for v in bad["violations"])


def test_dashboard_whatif(server):
    out = server.run_whatif("flight_data/busy_day", "solution_aerogate",
                            [{"kind": "outage", "gate": "D1", "from": 600, "to": 780, "at": 540}])
    assert out["compare"]["status"] == "OK"
    assert out["whatif"]


def test_pearson_payload_has_map(server):
    payload = server.run_payload("yyz/pearson_evening_bank", "solution_aerogate")
    assert payload["map"]["zones"] and payload["map"]["holding_line"]
    for g in payload["gates"]:
        # real OpenStreetMap stand: nose end first, at least two points, near Pearson
        assert g["pier"] in payload["map"]["zones"]
        assert len(g["stand"]["line"]) >= 2
        lat, lon = g["gate_ll"]
        assert 43.66 < lat < 43.70 and -79.66 < lon < -79.59


def test_every_pearson_gate_has_taxi_routes(server):
    import math
    payload = server.run_payload("yyz/pearson_evening_bank", "solution_aerogate")
    ky, kx = 110540, 111320 * math.cos(math.radians(43.68))
    d = lambda a, b: math.hypot((a[0] - b[0]) * ky, (a[1] - b[1]) * kx)  # noqa: E731
    R = payload["map"]["runways"]
    # Pearson west flow: land on 24R and 24L, depart from 23
    assert [rw["ref"] for rw in R["arrs"]] == ["24R", "24L"] and R["dep"]["ref"] == "23"
    for g in payload["gates"]:
        r = g["routes"]
        tail = g["stand"]["line"][-1]
        for rw in R["arrs"]:
            a = r["arr"][rw["ref"]]
            # landing roll starts at the threshold; taxi-in starts at its exit and ends at the stand
            assert d(a["roll"][0], rw["line"][0]) < 5
            assert d(a["in"][0], a["roll"][-1]) < 5 and d(a["in"][-1], tail) < 5
            assert d(a["in_hold"][0][0], a["roll"][-1]) < 5 and d(a["in_hold"][1][-1], tail) < 5
            assert 300 < sum(d(a["in"][i], a["in"][i + 1]) for i in range(len(a["in"]) - 1)) < 5000
        # taxi-out starts at the stand and ends at the departure runway threshold
        assert d(r["out"][0], tail) < 5 and d(r["out"][-1], R["dep"]["roll"][0]) < 5

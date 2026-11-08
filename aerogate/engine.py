"""
Per-tick decision pipeline used by solution_aerogate.decide().

  1. observation -> Problem
  2. CP-SAT plan (greedy warm start / fallback)
  3. order the moves; if some moves form a cycle (A<->B swap, which the
     evaluator cannot apply in one tick) forbid that combination and re-solve
  4. replay every action through the evaluator's own checks
  5. record a plain-language audit trail
"""

import traceback

from . import audit
from .adapter import problem_from_observation, to_actions, replay
from .explain import explain_tick
from .solver import solve, build_options, greedy

SETTINGS = {
    "robust_window": 0,    # minutes; >0 penalises tight turns (benchmarks: hurts, so off)
    "time_limit": 2.0,     # CP-SAT seconds per tick
    "use_cpsat": True,
    "deterministic": True, # reproducible plans (interleaved search, deterministic time)
    "explain": True,
}


def _plan_actions(obs, p, use_cpsat, deterministic=True):
    notes, cuts = [], []
    for _ in range(8):
        plan = solve(p, cuts=cuts, use_cpsat=use_cpsat, deterministic=deterministic)
        assigns, moves, stuck = to_actions(obs, p, plan)
        if not stuck:
            return plan, assigns, moves, notes
        notes.append("Swap cycle " + ", ".join(f"{a}->{b}" for a, b in stuck)
                     + " cannot be applied in one update; re-planned without it.")
        cuts.append(tuple(stuck))
    options, rejected = build_options(p)
    plan = greedy(p, options, rejected)
    assigns, moves, stuck = to_actions(obs, p, plan)
    notes.append("Fell back to the greedy planner after repeated swap cycles.")
    return plan, assigns, moves, notes


def decide(observation, settings=None):
    cfg = dict(SETTINGS, **(settings or {}))
    try:
        p = problem_from_observation(observation, cfg["robust_window"], cfg["time_limit"])
        plan, assigns, moves, notes = _plan_actions(observation, p, cfg["use_cpsat"], cfg["deterministic"])
        kept_a, kept_m, errors = replay(observation, assigns, moves, p.buffer)
        if errors and plan.status != "GREEDY":
            options, rejected = build_options(p)
            alt = greedy(p, options, rejected)
            a2, m2, _ = to_actions(observation, p, alt)
            ka2, km2, err2 = replay(observation, a2, m2, p.buffer)
            if len(err2) < len(errors):
                plan, kept_a, kept_m, errors = alt, ka2, km2, err2
                notes.append("Optimizer plan failed the safety replay; used the greedy plan.")
        if cfg["explain"]:
            try:
                audit.record(explain_tick(p, plan, kept_a, kept_m, errors, notes))
            except Exception:  # noqa: BLE001 - explanations must never cost a decision
                audit.record({"time": observation.get("time"), "solver": plan.status,
                              "errors": ["explain failed: " + traceback.format_exc(limit=2)],
                              "entries": [], "notes": notes})
        return {"assignments": kept_a, "reassignments": kept_m}
    except Exception:  # noqa: BLE001 - last line of defence: never crash the evaluator
        audit.record({"time": observation.get("time"), "solver": "ERROR",
                      "errors": [traceback.format_exc(limit=3)], "entries": [], "notes": []})
        return _safe_greedy(observation)


def _safe_greedy(observation):
    try:
        from solution_scored import decide as reference_decide  # noqa: WPS433
        out = reference_decide(observation)
        a, m, _ = replay(observation, out.get("assignments", []), out.get("reassignments", []))
        return {"assignments": a, "reassignments": m}
    except Exception:  # noqa: BLE001
        return {"assignments": [], "reassignments": []}

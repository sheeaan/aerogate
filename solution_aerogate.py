"""
AeroGate IROPS Optimizer - solution module for the evaluator.

    python evaluator.py --scenario flight_data/busy_day.json --solution solution_aerogate

Each tick it re-plans the whole remaining day with OR-Tools CP-SAT, using the
evaluator's own penalty weights (read from gms.config), so it only moves an
already-published gate when that saves more than the move costs. Moves are
ordered so each is legal when applied, every action is replayed through the
evaluator's checks before it is returned, and a greedy planner takes over if
OR-Tools is unavailable. See aerogate/ for the details.
"""

from aerogate.engine import decide as _decide


def decide(observation):
    return _decide(observation)

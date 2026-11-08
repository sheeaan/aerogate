"""
Default solution module (the evaluator's --solution default is "solution").

Runs the AeroGate IROPS Optimizer; see solution_aerogate.py and aerogate/.
"""

from aerogate.engine import decide as _decide


def decide(observation):
    return _decide(observation)

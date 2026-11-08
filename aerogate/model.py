"""
Plain data model shared by the solver, the evaluator adapter and the YYZ layer.

Times are integer minutes since the start of the operating day (same as gms).
Intervals are half-open (start, end) tuples.
"""

from dataclasses import dataclass, field

CARGO, DOMESTIC, INTERNATIONAL, TRANSBORDER = "cargo", "domestic", "international", "transborder"
CATEGORY_BY_CODE = {0: CARGO, 1: DOMESTIC, 2: INTERNATIONAL}

# Solver costs are integers: evaluator points x SCALE (0.01 point resolution).
SCALE = 100


def fmt(minute) -> str:
    if minute is None:
        return "--:--"
    minute = int(round(minute))
    day, mod = divmod(minute, 24 * 60)
    base = f"{mod // 60:02d}:{mod % 60:02d}"
    return f"{base}+{day}d" if day else base


def fmt_ivs(intervals) -> str:
    return ", ".join(f"{fmt(s)}-{fmt(e)}" for s, e in intervals) or "no presence"


def overlap(a, b, buf: int = 0) -> bool:
    """Same rule as gms.occupancy.intervals_overlap (half-open, optional buffer)."""
    return a[0] < b[1] + buf and b[0] < a[1] + buf


def sets_overlap(xs, ys, buf: int = 0) -> bool:
    return any(overlap(x, y, buf) for x in xs for y in ys)


def merge(intervals):
    """Union of intervals as a sorted list of disjoint intervals."""
    out = []
    for s, e in sorted(tuple(iv) for iv in intervals):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def earliest(intervals):
    return min((s for s, _ in intervals), default=None)


@dataclass
class Gate:
    id: str
    zones: tuple                 # flight categories this gate may serve
    premium: tuple = ()          # categories allowed but soft-penalised (domestic at intl)
    max_wingspan: float = 0.0
    jetbridge: bool = False
    dist: float = 0.0            # walking distance used by the score (<= 0 means none)
    outages: list = field(default_factory=list)
    xy: tuple = None             # terminal coordinates in metres (connection walking)
    sweep: int = 0               # minutes to re-secure the gate between different zones
    label: str = None            # display name, e.g. "F87 (swing D/T)"
    group: str = None            # pier / concourse for display


@dataclass
class Flight:
    id: str
    category: str
    wingspan: float
    jetbridge_required: bool
    intervals: list              # current presence intervals
    priority: bool = False       # unscheduled diversion / emergency
    reason: str = None
    current_gate: str = None
    flagged: bool = False        # airport-side change this tick (delay, swap, outage)
    trigger: str = None          # human text for why it was flagged
    stay_intervals: list = None  # what it blocks if it stays put (old U new for flagged)
    booked: list = None          # intervals currently booked on its gate (old, for flagged)
    arrived: bool = False        # presence has begun (evaluator's "after arrival")
    hold_options: tuple = (0,)   # tarmac holds (min) the planner may use (YYZ layer)
    tarmac_wait: int = 0         # minutes already waited on the tarmac (YYZ layer)
    min_turn: int = 30
    label: str = None
    aircraft: str = None
    route: str = None


@dataclass
class Problem:
    now: int
    gates: dict                  # gid -> Gate
    flights: dict                # fid -> Flight (decision variables)
    fixed: dict                  # fid -> (gid, intervals) immovable occupancy
    weights: dict                # scaled integer costs, see DEFAULT_WEIGHTS
    buffer: int = 0              # separation between aircraft at one gate
    adjacency: list = field(default_factory=list)    # (g1, g2, max combined wingspan m)
    connections: list = field(default_factory=list)  # (arr_fid, dep_fid, pax)
    robust_window: int = 0       # minutes; tight turns inside it get a small penalty
    time_limit: float = 2.0


DEFAULT_WEIGHTS = {
    # mirrors gms.config.WEIGHTS (x SCALE)
    "walk_per_m": 1,
    "premium": 500,
    "move": 1000,
    "move_after_arrival": 5000,
    "unassigned": 10000,
    "unassigned_priority": 30000,
    # AeroGate tie-breaks / YYZ layer
    "tight_turn": 60,            # max penalty for a 0-minute gap between aircraft
    "connection_per_pax_100m": 10,
    "hold_per_min": 20,
}


def weights_from_gms(gms_weights: dict = None) -> dict:
    """Build solver weights from the evaluator's WEIGHTS so a re-tuned
    evaluator is followed automatically."""
    w = dict(DEFAULT_WEIGHTS)
    if not gms_weights:
        return w
    g = gms_weights
    pairs = {
        "walk_per_m": "walking_distance_per_m",
        "premium": "domestic_at_intl_gate",
        "move": "reassignment",
        "move_after_arrival": "reassignment_after_arrival",
        "unassigned": "unassigned_flight",
        "unassigned_priority": "unassigned_emergency",
    }
    for ours, theirs in pairs.items():
        if theirs in g:
            w[ours] = int(round(float(g[theirs]) * SCALE))
    return w

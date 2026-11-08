"""
AeroGate optimisation core.

One model serves both the stock evaluator and the YYZ realism layer:

  * every (flight, gate, tarmac-hold) combination that passes the hard rules
    becomes an *option* with a fixed cost (walk, premium gate, move, hold);
  * CP-SAT picks at most one option per flight (exactly one for flights that
    already hold a gate, since the evaluator has no "unassign" action);
  * per-gate NoOverlap keeps aircraft apart; extra clauses enforce swing-gate
    security sweeps and adjacent-gate wingspan limits;
  * the objective is the evaluator's own score plus small tie-breaks
    (tight-turn robustness, connecting-passenger walking, tarmac holds).

If OR-Tools is missing, errors, or times out without a solution, ``greedy``
produces a plan from the same options so the caller always gets an answer.
"""

import bisect
import time
from collections import defaultdict
from dataclasses import dataclass, field

from .model import SCALE, merge, overlap, sets_overlap

try:  # OR-Tools is optional: the greedy fallback keeps everything working.
    from ortools.sat.python import cp_model
    HAVE_ORTOOLS = True
except Exception:  # noqa: BLE001
    cp_model = None
    HAVE_ORTOOLS = False

DOOMED_COST = 10_000_000   # keeping a flight on a gate that is no longer valid
APPR_LIMIT = 180           # APPR: offer disembarkation after 3 h on the tarmac


@dataclass
class Option:
    fid: str
    gid: str
    hold: int
    intervals: list          # presence if placed here (used for outages / others' checks)
    occupancy: list          # what it blocks on this gate (padded + merged)
    cost: int
    parts: dict              # cost breakdown (scaled)
    doomed: bool = False
    lit: object = None

    @property
    def raw_occupancy(self):
        return self.intervals


@dataclass
class Plan:
    choice: dict                         # fid -> Option | None
    status: str
    objective: float                     # in evaluator points
    solve_ms: float
    options: dict = field(default_factory=dict)
    rejected: dict = field(default_factory=dict)
    extras: dict = field(default_factory=dict)   # tie-break / connection costs


# ---------------------------------------------------------------------------
# Option generation (hard rules live here)
# ---------------------------------------------------------------------------
def hard_fails(f, g):
    """Hard-rule failures of flight f at gate g, as (code, detail) tuples."""
    fails = []
    if f.category not in g.zones:
        fails.append(("type", None))
    if f.wingspan > g.max_wingspan:
        fails.append(("wingspan", None))
    if f.jetbridge_required and not g.jetbridge:
        fails.append(("jetbridge", None))
    return fails


def appr_hold_cost(total_wait: int, w: dict) -> int:
    """Convex tarmac-hold penalty: cheap at first, then climbing steeply
    toward the 3-hour APPR limit (beyond it the option is not offered)."""
    frac = total_wait / APPR_LIMIT
    return int(w["hold_per_min"] * total_wait + w["unassigned"] * 0.9 * frac ** 4)


def shifted(f, hold: int):
    if not hold or not f.intervals:
        return [tuple(iv) for iv in f.intervals]
    (s, e), rest = f.intervals[0], f.intervals[1:]
    s2 = s + hold
    e2 = max(e, s2 + f.min_turn)      # a late gate-in may push the departure
    return [(s2, e2)] + [tuple(iv) for iv in rest]


def pad(intervals, buf):
    return merge([(s, max(e + buf, s + 1)) for s, e in intervals])


def unassigned_cost(f, w) -> int:
    base = w["unassigned_priority"] if f.priority else w["unassigned"]
    if f.tarmac_wait:
        base += appr_hold_cost(f.tarmac_wait, w)
    return base


def build_options(p):
    w, buf = p.weights, p.buffer
    fixed_by_gate = defaultdict(list)
    for fid, (gid, ivs) in p.fixed.items():
        fixed_by_gate[gid].append((fid, ivs))

    options, rejected = {}, {}
    for f in p.flights.values():
        opts, rej = [], {}
        for g in p.gates.values():
            fails = hard_fails(f, g)
            if fails:
                rej[g.id] = fails
                continue
            stay = g.id == f.current_gate
            holds = (0,) if f.current_gate else (f.hold_options or (0,))
            reasons = []
            for h in holds:
                if f.tarmac_wait + h > APPR_LIMIT and h:
                    continue
                ivs = shifted(f, h)
                occ_raw = merge(list(f.stay_intervals or []) + ivs) if stay else ivs
                hit = next((wdw for wdw in g.outages if any(overlap(iv, wdw, buf) for iv in ivs)), None)
                if hit:
                    reasons.append(("outage", tuple(hit)))
                    continue
                blk = next((ofid for ofid, oivs in fixed_by_gate[g.id] if sets_overlap(occ_raw, oivs, buf)), None)
                if blk:
                    reasons.append(("occupied", blk))
                    continue
                parts = {}
                if g.dist and g.dist > 0:
                    parts["walk"] = int(round(w["walk_per_m"] * g.dist))
                if f.category in g.premium:
                    parts["premium"] = w["premium"]
                if f.current_gate and not stay:
                    if f.arrived:
                        parts["move_after_arrival"] = w["move_after_arrival"]
                    elif not f.flagged:
                        parts["move"] = w["move"]
                    else:
                        parts["forced_move"] = 0
                if h or f.tarmac_wait:
                    # a medical / emergency arrival waiting is three times worse
                    parts["hold"] = appr_hold_cost(f.tarmac_wait + h, w) * (3 if f.priority else 1)
                opts.append(Option(f.id, g.id, h, ivs, pad(occ_raw, buf), sum(parts.values()), parts))
            if not any(o.gid == g.id for o in opts) and reasons:
                rej[g.id] = reasons[:1]
        if f.current_gate:
            # Explicit last resort so the model is always feasible, even when
            # pair rules (sweep / wingtip) leave no combination. Priced so high
            # it is only chosen when nothing legal exists.
            opts.append(Option(f.id, f.current_gate, 0, list(f.intervals), [], DOOMED_COST,
                               {"invalid_stay": DOOMED_COST}, doomed=True))
        options[f.id] = opts
        rejected[f.id] = rej
    return options, rejected


# ---------------------------------------------------------------------------
# Pair relations between options (sweep, adjacency, tight turns)
# ---------------------------------------------------------------------------
def _index(opts):
    """Sorted (start, end, option) list over every padded occupancy interval."""
    rows = sorted(((s, e, o) for o in opts if not o.doomed for s, e in o.intervals),
                  key=lambda r: r[0])
    return rows, [r[0] for r in rows]


def follow_pairs(opts, window, now=None):
    """(a, b, gap) where b starts within [a.end, a.end + window) on the same gate."""
    rows, starts = _index(opts)
    seen = {}
    for s, e, a in rows:
        if now is not None and e < now:
            continue
        i = bisect.bisect_left(starts, e)
        j = bisect.bisect_left(starts, e + window)
        for s2, e2, b in rows[i:j]:
            if b.fid == a.fid:
                continue
            key = (id(a), id(b))
            gap = s2 - e
            if key not in seen or gap < seen[key][2]:
                seen[key] = (a, b, gap)
    return list(seen.values())


def overlap_pairs(opts_a, opts_b):
    """(a, b) from two gates whose raw presences overlap in time."""
    rows_b, starts_b = _index(opts_b)
    out = {}
    for s, e, a in ((s, e, o) for o in opts_a if not o.doomed for s, e in o.intervals):
        # b overlaps a iff b.start in [?, e) and b.end > s; scan b starting before e
        j = bisect.bisect_left(starts_b, e)
        for s2, e2, b in rows_b[:j]:
            if e2 > s and b.fid != a.fid:
                out[(id(a), id(b))] = (a, b)
    return list(out.values())


def sweep_conflicts(p, by_gate):
    """Swing gates: two flights of different zones need `sweep` minutes between them."""
    out = []
    for gid, opts in by_gate.items():
        g = p.gates[gid]
        if not g.sweep or len(g.zones) < 2:
            continue
        for a, b, gap in follow_pairs(opts, g.sweep):
            if p.flights[a.fid].category != p.flights[b.fid].category:
                out.append((a, b, gap))
    return out


def adjacency_conflicts(p, by_gate):
    out = []
    for g1, g2, limit in p.adjacency:
        for a, b in overlap_pairs(by_gate.get(g1, []), by_gate.get(g2, [])):
            ws = p.flights[a.fid].wingspan + p.flights[b.fid].wingspan
            if ws > limit:
                out.append((a, b, ws, limit))
    return out


def tight_turns(p, by_gate):
    if not p.robust_window or not p.weights.get("tight_turn"):
        return []
    out = []
    for gid, opts in by_gate.items():
        for a, b, gap in follow_pairs(opts, p.robust_window, now=p.now):
            pen = int(p.weights["tight_turn"] * (p.robust_window - gap) / p.robust_window)
            if pen > 0:
                out.append((a, b, gap, pen))
    return out


def options_by_gate(options):
    by_gate = defaultdict(list)
    for opts in options.values():
        for o in opts:
            if not o.doomed:
                by_gate[o.gid].append(o)
    return by_gate


# ---------------------------------------------------------------------------
# CP-SAT
# ---------------------------------------------------------------------------
def solve_cpsat(p, options, rejected, cuts=(), hint=None, workers=8, deterministic=True):
    if not HAVE_ORTOOLS:
        return None
    t0 = time.perf_counter()
    m = cp_model.CpModel()
    obj = []
    by_gate = options_by_gate(options)

    for fid, opts in options.items():
        f = p.flights[fid]
        lits = []
        for k, o in enumerate(opts):
            o.lit = m.NewBoolVar(f"x{len(obj)}_{k}")
            lits.append(o.lit)
            if o.cost:
                obj.append(o.cost * o.lit)
        if f.current_gate:
            m.AddExactlyOne(lits)
        else:
            un = m.NewBoolVar(f"u_{fid}")
            m.AddExactlyOne(lits + [un])
            obj.append(unassigned_cost(f, p.weights) * un)

    for gid, opts in by_gate.items():
        ivs = []
        for o in opts:
            for s, e in o.occupancy:
                ivs.append(m.NewOptionalFixedSizeIntervalVar(s, e - s, o.lit, ""))
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)

    _move_order(m, p, options)

    for a, b, _gap in sweep_conflicts(p, by_gate):
        m.AddBoolOr([a.lit.Not(), b.lit.Not()])
    for a, b, _ws, _lim in adjacency_conflicts(p, by_gate):
        m.AddBoolOr([a.lit.Not(), b.lit.Not()])

    tt = tight_turns(p, by_gate)
    for a, b, _gap, pen in tt:
        y = m.NewBoolVar("")
        m.AddBoolOr([a.lit.Not(), b.lit.Not(), y])
        obj.append(pen * y)

    conn_terms = _connection_terms(m, p, options)
    obj.extend(conn_terms)

    for cut in cuts:
        lits = [o.lit.Not() for fid, gid in cut for o in options.get(fid, []) if o.gid == gid]
        if lits:
            m.AddBoolOr(lits)

    if hint:
        for fid, opts in options.items():
            for o in opts:
                m.AddHint(o.lit, 1 if hint.get(fid) == (o.gid, o.hold) else 0)

    m.Minimize(sum(obj))
    solver = cp_model.CpSolver()
    solver.parameters.random_seed = 7
    if deterministic:
        # One search thread + a deterministic work budget: same input, same plan.
        # (CP-SAT's experimental interleaved multi-worker mode aborted the
        # process on some models, so it is deliberately not used.)
        solver.parameters.num_workers = 1
        solver.parameters.max_deterministic_time = p.time_limit
        # wall clock is only a safety net; the deterministic budget decides
        solver.parameters.max_time_in_seconds = p.time_limit * 15
    else:
        solver.parameters.num_workers = workers
        solver.parameters.max_time_in_seconds = p.time_limit
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    choice = {}
    for fid, opts in options.items():
        choice[fid] = next((o for o in opts if solver.BooleanValue(o.lit)), None)
    extras = {"tight_turns": sum(pen for a, b, _g, pen in tt
                                 if choice.get(a.fid) is a and choice.get(b.fid) is b)}
    return Plan(choice, solver.StatusName(status), solver.ObjectiveValue() / SCALE,
                (time.perf_counter() - t0) * 1000, options, rejected, extras)


def _move_order(m, p, options):
    """The evaluator applies reassignments one at a time, each checked against
    the gates as they are at that moment. So if flight f moves onto a gate that
    flight b still holds (overlapping), b must move first. Integer positions
    with these precedences rule out swap cycles (A->B's gate, B->A's gate)."""
    movers = [fid for fid, f in p.flights.items() if f.current_gate]
    if not movers:
        return
    holders = defaultdict(list)
    for fid in movers:
        f = p.flights[fid]
        holders[f.current_gate].append((fid, f.booked or f.stay_intervals or f.intervals))
    pos = {}
    for fid in movers:
        f = p.flights[fid]
        for o in options.get(fid, []):
            if o.doomed or o.gid == f.current_gate:
                continue
            for b, bivs in holders.get(o.gid, []):
                if b == fid or not sets_overlap(o.intervals, bivs, p.buffer):
                    continue
                for k in (b, fid):
                    if k not in pos:
                        pos[k] = m.NewIntVar(0, len(movers), f"pos_{k}")
                m.Add(pos[b] + 1 <= pos[fid]).OnlyEnforceIf(o.lit)


def _connection_terms(m, p, options):
    """Connecting passengers: pax x Manhattan walk between the two gates."""
    if not p.connections:
        return []
    w = p.weights.get("connection_per_pax_100m", 0)
    if not w:
        return []
    xs = [g.xy[0] for g in p.gates.values() if g.xy]
    ys = [g.xy[1] for g in p.gates.values() if g.xy]
    if not xs:
        return []
    lo, hi = int(min(xs + ys)), int(max(xs + ys))
    pos = {}

    def position(fid):
        if fid not in pos:
            x, y = m.NewIntVar(lo, hi, ""), m.NewIntVar(lo, hi, "")
            for o in options.get(fid, []):
                g = p.gates[o.gid]
                if g.xy and o.lit is not None:
                    m.Add(x == int(g.xy[0])).OnlyEnforceIf(o.lit)
                    m.Add(y == int(g.xy[1])).OnlyEnforceIf(o.lit)
            pos[fid] = (x, y)
        return pos[fid]

    terms = []
    for arr, dep, pax in p.connections:
        if arr not in options or dep not in options:
            continue
        (x1, y1), (x2, y2) = position(arr), position(dep)
        dx, dy = m.NewIntVar(0, hi - lo, ""), m.NewIntVar(0, hi - lo, "")
        m.AddAbsEquality(dx, x1 - x2)
        m.AddAbsEquality(dy, y1 - y2)
        # cost per pax per 100 m -> integer coefficient per metre, rounded up
        coef = max(1, int(round(w * pax / 100)))
        terms.append(coef * (dx + dy))
    return terms


# ---------------------------------------------------------------------------
# Greedy fallback (also used as a CP-SAT warm start)
# ---------------------------------------------------------------------------
class Board:
    """Incremental occupancy for the greedy: checks overlap, sweep, adjacency."""

    def __init__(self, p):
        self.p = p
        self.by_gate = defaultdict(list)    # gid -> [Option]
        self.adj = defaultdict(list)
        for g1, g2, lim in p.adjacency:
            self.adj[g1].append((g2, lim))
            self.adj[g2].append((g1, lim))

    def fits(self, o):
        p = self.p
        g = p.gates[o.gid]
        f = p.flights.get(o.fid)
        for other in self.by_gate[o.gid]:
            if other.fid == o.fid:
                continue
            if any(overlap(x, y) for x in o.occupancy for y in other.occupancy):
                return False
            if g.sweep and f and p.flights.get(other.fid) and p.flights[other.fid].category != f.category:
                if sets_overlap(o.intervals, other.intervals, g.sweep):
                    return False
        if f:
            for g2, lim in self.adj[o.gid]:
                for other in self.by_gate[g2]:
                    of = p.flights.get(other.fid)
                    if of and other.fid != o.fid and f.wingspan + of.wingspan > lim \
                            and sets_overlap(o.intervals, other.intervals):
                        return False
        return True

    def place(self, o):
        self.by_gate[o.gid].append(o)

    def remove(self, fid):
        for gid in self.by_gate:
            self.by_gate[gid] = [o for o in self.by_gate[gid] if o.fid != fid]


def greedy(p, options, rejected):
    t0 = time.perf_counter()
    board = Board(p)
    choice = {}

    def stay_opt(fid):
        return next((o for o in options[fid] if o.gid == p.flights[fid].current_gate and not o.doomed), None)

    # 1. everything already placed stays put (flagged flights keep a ghost of old U new)
    for fid, f in p.flights.items():
        if f.current_gate:
            o = stay_opt(fid)
            if o is not None:
                board.place(o)
                choice[fid] = o

    # 2. flagged flights whose stay is invalid (or now collides) move to their best fit
    flagged = sorted((f for f in p.flights.values() if f.current_gate and f.flagged),
                     key=lambda f: (f.intervals[0][0] if f.intervals else 0))
    for f in flagged:
        cur = choice.get(f.id)
        board.remove(f.id)
        if cur is not None and board.fits(cur):
            board.place(cur)
            continue
        best = min((o for o in options[f.id] if not o.doomed and board.fits(o)),
                   key=lambda o: o.cost, default=None)
        if best is None:
            best = cur or next(o for o in options[f.id] if o.doomed)
        if not best.doomed:
            board.place(best)
        choice[f.id] = best
    for fid, f in p.flights.items():
        if f.current_gate and fid not in choice:
            choice[fid] = next(o for o in options[fid] if o.doomed)

    # 3. waiting flights: emergencies first, then most constrained, then earliest
    waiting = [f for f in p.flights.values() if not f.current_gate]
    waiting.sort(key=lambda f: (not f.priority, -f.tarmac_wait, len(options[f.id]),
                                f.intervals[0][0] if f.intervals else 0))
    for f in waiting:
        best = min((o for o in options[f.id] if board.fits(o)), key=lambda o: o.cost, default=None)
        choice[f.id] = best
        if best is not None:
            board.place(best)

    obj = sum(o.cost for o in choice.values() if o) + sum(
        unassigned_cost(p.flights[fid], p.weights) for fid, o in choice.items() if o is None)
    return Plan(choice, "GREEDY", obj / SCALE, (time.perf_counter() - t0) * 1000, options, rejected)


def solve(p, cuts=(), use_cpsat=True, deterministic=True):
    """Build options and return the best plan we can get (never None)."""
    options, rejected = build_options(p)
    warm = greedy(p, options, rejected)
    if use_cpsat and HAVE_ORTOOLS:
        try:
            hint = {fid: (o.gid, o.hold) for fid, o in warm.choice.items() if o}
            plan = solve_cpsat(p, options, rejected, cuts=cuts, hint=hint, deterministic=deterministic)
            if plan is not None:
                return plan
        except Exception:  # noqa: BLE001 - fall back rather than crash the tick
            pass
    return warm

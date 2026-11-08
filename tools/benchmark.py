"""
Score solvers across scenarios.

    python tools/benchmark.py                        # sample scenarios
    python tools/benchmark.py --dir generated        # generated stress scenarios
    python tools/benchmark.py --set robust_window=0  # tweak AeroGate settings

Prints one row per scenario and a totals row; hard failures count as FAIL.
"""

import argparse
import contextlib
import glob
import io
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from evaluator import run_sim  # noqa: E402
from aerogate import engine  # noqa: E402

SOLVERS = ["solution_firstfit", "solution_scored", "solution_aerogate"]


def run(static, scenario, solution):
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(io.StringIO()):
        r = run_sim(static, scenario, solution, verbose=False)
    return r, time.perf_counter() - t0


def static_for(scenario, default):
    """Generated scenarios ship their own airport layout next to them."""
    side = scenario.replace(".json", ".static.json")
    return side if os.path.exists(side) else default


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(ROOT, "flight_data"))
    ap.add_argument("--static", default=os.path.join(ROOT, "static_info.json"))
    ap.add_argument("--solvers", default=",".join(SOLVERS))
    ap.add_argument("--set", action="append", default=[], help="AeroGate setting key=value")
    ap.add_argument("--json", help="write results to this file")
    args = ap.parse_args(argv)

    for kv in args.set:
        k, v = kv.split("=", 1)
        engine.SETTINGS[k] = type(engine.SETTINGS[k])(json.loads(v.lower()) if v.lower() in ("true", "false") else v)

    solvers = args.solvers.split(",")
    files = sorted(f for f in glob.glob(os.path.join(args.dir, "*.json")) if not f.endswith(".static.json"))
    totals = {s: 0.0 for s in solvers}
    fails = {s: 0 for s in solvers}
    secs = {s: 0.0 for s in solvers}
    rows = []
    print(f"{'scenario':28}" + "".join(f"{s.replace('solution_', ''):>12}" for s in solvers))
    for f in files:
        static = static_for(f, args.static)
        cells, row = [], {"scenario": os.path.basename(f)}
        for s in solvers:
            r, dt = run(static, f, s)
            secs[s] += dt
            if r["status"] == "OK":
                totals[s] += r["score"]
                cells.append(f"{r['score']:12.2f}")
                row[s] = r["score"]
            else:
                fails[s] += 1
                cells.append(f"{'FAIL':>12}")
                row[s] = None
                row[s + "_reason"] = r["reason"]
        rows.append(row)
        print(f"{os.path.basename(f)[:28]:28}" + "".join(cells))
    print("-" * (28 + 12 * len(solvers)))
    print(f"{'TOTAL (ok runs)':28}" + "".join(f"{totals[s]:12.2f}" for s in solvers))
    print(f"{'hard failures':28}" + "".join(f"{fails[s]:12d}" for s in solvers))
    print(f"{'seconds':28}" + "".join(f"{secs[s]:12.1f}" for s in solvers))
    for row in rows:
        for s in solvers:
            if row.get(s + "_reason"):
                print(f"  FAIL {s} on {row['scenario']}: {row[s + '_reason']}")
    if args.json:
        common_rows = [r for r in rows if all(r.get(s) is not None for s in solvers)]
        summary = {
            "count": len(rows),
            "fails": fails,
            "totals": totals,
            "common": {s: sum(r[s] for r in common_rows) for s in solvers},
            "common_count": len(common_rows),
            "wins": {s: sum(1 for r in common_rows
                            if all(r[s] < r[o] - 1e-9 for o in solvers if o != s)) for s in solvers},
            "seconds": secs,
        }
        with open(args.json, "w") as fh:
            json.dump({"rows": rows, **summary}, fh, indent=1)


if __name__ == "__main__":
    main()

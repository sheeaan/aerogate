# AeroGate: technical notes

Gate assignment for the Brock Solutions Airport Innovation Challenge (subproblem 03, Toronto Pearson).
AeroGate re-plans every gate at every update with an exact optimiser, explains each decision in
plain language, and lets an operator test overrides and what-if disruptions before they happen.

The original challenge instructions are in [CHALLENGE_README.md](../CHALLENGE_README.md).
A research-style write-up of the models and algorithms is in
[docs/paper/aerogate_paper.tex](paper/aerogate_paper.tex) (PDF: [paper/aerogate_paper.pdf](paper/aerogate_paper.pdf); rebuild with `docs/paper/build_pdf.bat`).

## Run it

```bash
py -3.14 -m venv .venv              # any Python 3.10+ works
.venv\Scripts\python -m pip install -r requirements.txt

# score a scenario with the official evaluator
.venv\Scripts\python evaluator.py --scenario flight_data/busy_day.json --solution solution_aerogate
# (solution.py is the evaluator's default module and also runs AeroGate)

# operator dashboard -> http://127.0.0.1:8770
.venv\Scripts\python dashboard\server.py

# benchmarks and tests
.venv\Scripts\python tools\benchmark.py                      # 12 challenge scenarios
.venv\Scripts\python tools\gen_scenarios.py --n 40 --out generated
.venv\Scripts\python tools\benchmark.py --dir generated      # random airports and days
.venv\Scripts\python -m pytest tests\test_aerogate.py
```

Without OR-Tools installed, AeroGate falls back to its greedy planner and keeps working.

## Results

Lower is better. A hard failure ends an evaluator run, so it outweighs any soft-score saving.

| | AeroGate | Provided greedy | Provided first-fit |
|---|---|---|---|
| 12 challenge scenarios, total score | **96.2** | 104.3 | 96.8 |
| Hard failures on the challenge scenarios | **0** | 0 | 0 |
| 40 generated days, hard failures | **1** | 3 | 6 |
| Generated days all three finish, total score (33 days) | **3,188** | 3,565 | 5,783 |
| Generated days won outright (of 33) | **26** | 5 | 0 |

The generated days use random airport layouts (6-40 gates) and 12-90 flights, with delays,
departure delays, equipment swaps, cancellations, reinstatements, gate outages and diversions
announced 30-180 min ahead, like the official files. Every generated day passes the same
guarantee the official scenarios make: after each update, all active flights can be placed at
once. The one AeroGate failure (`gen_022`) cannot be avoided by any planner: an outage hits a
wide-body that is already parked while all seven compatible gates hold parked aircraft, and the
evaluator cannot swap two parked aircraft.

## How it works

```
observation ─► Problem ─► CP-SAT model ─► ordered moves ─► safety replay ─► actions + audit trail
                 │             ▲                                 │
                 └─ greedy ────┘ (warm start, and fallback)      └─ drops anything the evaluator would reject
```

* **Options.** Every flight x gate (x tarmac hold, in the Pearson layer) that passes the hard
  rules (gate type, wingspan, jetbridge, outages) becomes a yes/no option.
* **Model** (`aerogate/solver.py`). At most one option per waiting flight, exactly one per flight
  that already has a gate. Per-gate no-overlap, with the evaluator's turnaround buffer.
* **Objective = the evaluator's own score**, read live from `gms.config.WEIGHTS`: walking distance,
  domestic-on-international, reassignment (10, or 50 after arrival, free when the airport caused
  it), unassigned (100, or 300 for diversions). So it only moves a published gate when the move
  saves more than it costs.
* **Move ordering.** The evaluator applies reassignments one at a time, each checked against the
  gates as they stand. The model gives every moving flight a position and requires the current
  holder of a target gate to move first, so it never proposes a swap that can't be applied.
* **Safety replay** (`aerogate/adapter.py`). Every action is re-checked with the evaluator's own
  compatibility code before it is returned. Any exception falls back to the greedy plan, then to
  the provided reference solver, then to doing nothing. `decide()` never raises.
* **Repeatable.** One search thread plus a deterministic work budget: the same input gives the
  same plan on every run.
* **Audit trail** (`aerogate/explain.py`). For every decision: the rules it passed with the
  numbers, what it costs, and why each other gate lost (rule, occupied by whom, or how much worse).

Things we tested and switched off because the data said so: a "keep slack between turns"
robustness bonus made total score worse on the generated days (3,582 vs 3,078), because delays are
announced before arrival and the evaluator lets you move a delayed flight for free then.

## Operator dashboard

`dashboard/server.py` (standard library only) + `dashboard/static/`. The story is operator trust:
every gate decision can be checked.

* **Map** (Pearson scenario, the default): the real OpenStreetMap map of Toronto Pearson (satellite
  optional; if the venue has no internet it falls back to the bundled airport vectors). Press Play
  and every flight in the plan moves (`dashboard/static/traffic.js`) in Pearson's usual west-flow
  setup: arrivals land on 24R or 24L (whichever gets them to their gate sooner, spaced by wake
  category) and taxi on the real taxiways to the stand AeroGate assigned; 24L arrivals hold short of
  24R while a landing is close or still on the runway (red stop bars). Departures push back, queue
  at the 23 holding point and take off 1.5 min apart (2 min behind a heavy). Ground movement is
  simulated every 3 s: aircraft keep 105 m behind the one ahead, pushbacks start only when the
  taxilane behind the stand is clear, oncoming traffic passes in a parallel lane on the side away
  from parked aircraft, and an aircraft that has to wait for its gate (a planned tarmac hold, or a
  stand that is still taken) taxis over the real taxiway network to a holding spot on an unused
  taxiway (no taxi route or stand within 80 m, no runway within 150 m) instead of stopping on the
  apron. The simulation runs twice: the first pass finds who would wait, the second routes them to
  a free spot whose route passes no occupied spot (closest approach over the evening: 39 m, never
  over a parked aircraft, never on a runway during a landing). Labels declutter themselves: a crowded tag shrinks to its
  callsign or hides, but the selected aircraft and anything landing always keep a full tag. At each
  plan update, amber arrows show every gate change; clicking any aircraft, moving or parked, opens
  its decision. Aircraft are drawn at true size when zoomed in; zoomed out they are drawn larger
  to stay visible, but only as far as their neighbours allow, so two icons never overlap.
* **Gates & resources tab** (right, `dashboard/static/resources.js`): the next hour's arrivals with
  their planned gate and the best other legal gates (extra points if moved there); pick a flight and
  its gates are coloured on the map, above every tag (green planned, blue legal but costs more, grey
  taken), with each option's pier crew and baggage situation at its arrival time. Ground crew and
  baggage per pier are shown as purple badges at each pier's baggage area. They are planning
  estimates the planner does not use: ramp crews D 14, F 6, E 16, cargo 2 (two per widebody turn),
  baggage belts of 1,200 bags/h (D 2, F 1, E 4). Deep links for the demo: `#rtab=res`,
  `#sel=ACA1557`, `#zoom=gates`, `#t=18:20`.
* **Gate decision panel** (right): with nothing selected it lists what changed at the selected
  update and why ("AC405 moved D51/F51 to D39 because of a delay ... re-planned before landing, no
  charge", "LH470 stays at E75 ..."). Click a line or an aircraft for the full decision: the rules
  it passed, what it costs, why every other gate lost, and a manual-move check that refuses unsafe
  overrides with the reasons (customs gate, overlap, wingtip clearance).
* **Plan health** (left): flights gated, rule violations, gate changes, tarmac holds, updates proven
  optimal, decisions with an audit trail. Plus the clock (Play steps through the evening) and the
  next arrivals and departures.
* **Plan updates** (bottom): one key per message batch; click to jump to it.
* **Gate timeline**: the same plan as a Gantt chart; used for the 12 challenge scenarios. Drag a
  flight to another gate to test an override.
* **How it works**: the algorithm explained for judges.

Deep links: `http://127.0.0.1:8770/#t=16:20` (the storm update),
`http://127.0.0.1:8770/#t=16:20&select=AC-873-2025-06-15` (one decision opened).

## Pearson realism layer (`yyz/`)

The stock evaluator only knows cargo, domestic and international. `yyz/sim.py` runs the same
optimiser on 30 real Terminal 1 gates plus two Cargo West stands, built from OpenStreetMap by
`yyz/build_osm_layout.py`: gate names (including dual-named swing gates such as E67/F67 and
D32/F32), stand positions and nose-in headings come from OSM; wingtip limits come from the real
spacing between neighbouring stands. Stand sizes (widebody if the stand is long or has MARS A/B
sub-stands), walking distances and baggage capacities are estimates. Rules the challenge data
can't express:

| Rule | Why it exists | How it's modelled |
|---|---|---|
| US transborder needs pre-clearance gates | US preclearance at YYZ; passengers must not mix with domestic or international flows | `transborder` category, F gates |
| Swing gates (D/F, E/F) need a security sweep between zones | CBSA / sterile-area integrity when barriers move | 30 min between flights of different zones on a swing gate |
| Wingtip clearance between adjacent gates | ICAO Annex 14 / TP 312 separation | combined wingspan limit per neighbouring pair |
| Tarmac holds and APPR | Air Passenger Protection Regulations: passengers must be offered disembarkation after 3 h on the tarmac (plus up to 45 min if take-off is imminent) | planned holds up to 180 min, penalty rising steeply with time (3x for medical diversions); holds logged with IATA delay codes 87 (stand) and 93 (reactionary) |
| Connecting passengers | missed connections | passengers x walking distance between the two gates |

Scenario: `yyz/scenarios/pearson_evening_bank.json` (built by `yyz/build_scenarios.py`): an
evening bank with a jetbridge failure on swing gate E69/F69, a thunderstorm bunching seven
arrivals, a 777 medical diversion, a 787 swap on a US flight (it holds 20 min for widebody stand
F60) and a cancellation.

Map data (c) OpenStreetMap contributors, available under the ODbL; see `yyz/osm/README.md`.

## Limits and next steps

* The evaluator has no "unassign" or "remote stand" action, so some outage cases can't be saved.
  A real system would tow to a remote stand (the Pearson layer does this).
* Single-thread solving adds a few seconds to the first plan of very large days. A production
  version would warm-start from the previous plan and solve per pier in parallel.
* Next: learn delay distributions from history (A-CDM TOBT updates) to price buffers by
  probability, and feed live TOBT/TSAT changes instead of scheduled times.

## Demo script (about 4 minutes, story: operator trust)

1. **Problem (30 s).** An evening at Pearson: a storm bunches arrivals, a jetbridge fails, a medical
   diversion comes in. Gate planners have to re-plan in minutes, and nobody trusts a black box.
2. **The plan, and why it beats today's tools (45 s).** Open the dashboard. The top-left box runs
   the same evening, same storm and failures, through greedy rules (keep gates, take the first
   good free gate: how rule-based tools re-plan). Both gate all 83 flights legally, but greedy
   leaves 11 flights holding on the tarmac for 320 min (about 1,320 passenger-hours); AeroGate,
   seeing the whole evening at once, holds 3 for 70 min (about 234): 82% fewer passenger-hours
   stuck on the tarmac and a 20% lower score. Every update is solved by CP-SAT and every decision
   recorded.
3. **The storm (60 s).** Click the 16:15 update. The panel lists what changed and why: three
   flights moved before they landed (no charge, no passengers at the old gate), four stayed put.
   The map shows the moves as arrows.
4. **The storm, planned the old way (45 s).** Open `http://127.0.0.1:8770/#t=18:12&plan=greedy`
   (or drag the clock to 18:12 and press "Play the greedy plan on the map"). Red banner: this is
   greedy rules, same storm. Three red aircraft wait on the taxiways for gates (SWR40D for E70,
   POE1186 for D34/F34, ACA762 for F65), and the 787 swap AC768 holds 90 min. Press "Back to
   AeroGate": same minute, nobody waiting, ACA762 taxis straight in, AC768 holds 30 min. Press Play
   in either view to watch it unfold; around 20:55 greedy has four waiting against AeroGate's two.
5. **One decision (45 s).** Click AC873: the rules its gate passed, what it costs, and why each of
   the other gates lost (taken, wrong type, too small, costlier).
6. **Operator in control (30 s).** "Test a manual move" to D22: refused, with the reasons (customs
   gate needed, overlaps WS661, wingtip clearance). Overrides are allowed, unsafe ones are not.
7. **Diversion (15 s).** Click 17:45: the medical diversion gets a gate immediately, with its reason.
8. **Results (30 s).** How it works: best score on the challenge set, fewest hard failures on 40
   random airports, runs in milliseconds.

## Project layout

```
solution_aerogate.py, solution.py   evaluator entry points
aerogate/                           model, CP-SAT solver, evaluator adapter, explanations
dashboard/                          operator web app
yyz/                                Pearson realism layer (layout, scenario builder, simulator)
tools/                              scenario generator and benchmark
tests/test_aerogate.py              solver, safety net, Pearson layer, dashboard API
results/                            benchmark outputs
```

`evaluator.py` and `gms/` are the challenge's files, unchanged.

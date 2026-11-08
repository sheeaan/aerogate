# Gate Assignment Algorithm 

## Table of Contents
- [Flight Schedule and Other Considerations](#flight-schedule-and-other-considerations)
- [Required Input and Outputs](#required-input-and-outputs)
- [Getting Started](#getting-started)
- [Evaluation](#evaluation)

## Flight Schedule and Other Considerations 
Airports plan gates the way this challenge is structured: the full day's flight schedule is filed first, then a timeline of updates arrives at later information times.

```text
0500  planning     the full filed schedule
0900  disruption  a gate outage or aircraft swap
1000  disruption  a delay or cancellation
```

The opening planning message contains the filed schedule for the day. Later messages may report a delay, gate outage, aircraft change, cancellation, or priority diversion. An unscheduled diversion can also arrive during the day with `priority` set and need a gate immediately.

Reassignments affect passengers, ground crews, gate displays, and baggage operations, so a stable recovery is usually better than reshuffling the entire airport after every update.

If you're working on the assignment algorithm itself (improving it or replacing it), it should:

- assign every compatible flight when capacity allows
- prevent overlapping aircraft from using the same gate
- respect aircraft size, jetbridge, international, domestic, and cargo rules
- move flights away from unavailable or newly incompatible gates
- handle unassigned or malformed cases without crashing
- minimize reassignments and passenger walking distance
- work on schedules beyond the visible examples

## Required Input and Outputs

If you're writing or modifying an assignment algorithm, the evaluator calls your `decide(observation)` function at each information time. Skip this section if you're building on top of the existing algorithm instead.

The observation includes:

- current time
- gate details and outages
- waiting, assigned, and recently changed flights
- current gate occupancy
- aircraft information

Return assignments using this shape:

```python
{
    "assignments": [(flight_id, gate_id)],
    "reassignments": [(flight_id, gate_id)],
}
```

Use `assignments` for a flight receiving its first gate and `reassignments` for a flight moving from an existing gate.

## Getting Started
1. Download and install VS Code (or any code editor of your choice). It should be noted that all the starter files are in python.
2. Afterwards, download the following starter files located in this subproblem folder:

#### Starter Files
| Location | Purpose |
| --- | --- |
| [`solution_firstfit.py`](solution_firstfit.py) | A correct, minimal first-fit baseline and one possible solution interface |
| [`solution_scored.py`](solution_scored.py) | A more scoring-aware reference algorithm to study or use |
| [`evaluator.py`](evaluator.py) | Replays a scenario and checks the solution's assignments |
| [`visualize.py`](visualize.py) | Serves an interactive timeline or exports a visualization |
| [`gms/`](gms/) | The evaluator's internal domain package; participants normally do not edit it |
| [`flight_data/`](flight_data/) | Example schedules and disruption timelines |
| [`static_info.json`](static_info.json) | Gate inventory, aircraft information, and station data |
| [`JsonFlightMessageSpecification.md`](JsonFlightMessageSpecification.md) | The input message format |

3. To to run the baseline code, type this into the console:

```bash
python evaluator.py --scenario flight_data/simple.json --solution solution
```

4.  To run the more optimized code, type the following into the console: 

```bash
python evaluator.py --scenario flight_data/simple.json --solution solution_scored
```

5. To open the visualizer, type the following into the console  
```bash
python visualize.py --serve
```

Open the local address printed in the terminal. On Windows, you can also double-click `launch_visualizer.bat`.

6. Try Disruption Scenarios
Useful starting scenarios include:

| Scenario | What it demonstrates |
| --- | --- |
| [`simple.json`](flight_data/simple.json) | Basic placement and repeated aircraft presence |
| [`cascade_2.json`](flight_data/cascade_2.json) | A delay that forces reassignment |
| [`gate_outage.json`](flight_data/gate_outage.json) | A gate becoming unavailable |
| [`equipment_upgrade.json`](flight_data/equipment_upgrade.json) | An aircraft change that invalidates a gate |
| [`emergencies.json`](flight_data/emergencies.json) | Priority diversions arriving during the day |
| [`busy_day.json`](flight_data/busy_day.json) | A larger schedule with delays and cancellation |

Do not modify `evaluator.py` or the `gms/` package unless challenge staff asks you to. Put your decision logic in your own solution module

## Evaluation
The evaluator takes into consideration a couple of things:

#### Hard Failures 
A run fails when the solution produces an invalid plan, including:

- overlapping aircraft at one gate
- an aircraft that is too large for its gate
- a missing required jetbridge
- an international, domestic, passenger, or cargo gate-type violation
- an unknown or cancelled flight assignment
- invalid output format
- a changed flight left in an invalid gate

#### Soft Score

Valid runs receive a score where lower is better. The score considers:

- reassignments, especially after gate occupancy begins
- walking distance
- domestic flights using international gates
- flights left unassigned at the end

Every supplied scenario is designed to allow a solution with zero hard failures. Hidden scenarios may use different schedules and airport layouts. Besides considering hard failures and soft scores, it is also important to consider code quality, the clarity of the visual model, and if your changes are meaningful/useful to airport staff. 


# JSON Flight Message Specification

## Overview

This document describes a JSON-based format for communicating flight schedule information between systems. This is an alternative to the traditional IATA ASM (Aircraft Schedule Message) format, using modern JSON structure with human-readable property names.

## Key Industry Terms

- **Carrier**: An airline identified by a two-character code (e.g., "AC" for Air Canada, "AA" for American Airlines).

- **Station**: An airport identified by a three-character code (e.g., "YYZ" for Toronto, "JFK" for New York, "LAX" for Los Angeles).

- **Flight Number**: The flight identifier consisting of 1-4 digits (e.g., "100", "1234").

- **Flight Suffix**: An optional letter after the flight number (e.g., "A" in flight AC100A).

- **Flight Leg**: A single segment from one airport to another. A flight can have multiple legs.

- **Leg Type**:
    - **Originating** = First leg of the flight
    - **Through** = Connecting leg in a multi-leg flight

- **Aircraft Type**: The model of aircraft (e.g., "73G" for Boeing 737-700, "321" for Airbus A321).

## Message Actions

- **CreateFlight** = Create a new flight schedule
- **ReplaceFlight** = Replace an existing flight schedule
- **UpdateTiming** = Update only timing information
- **CancelFlight** = Cancel a flight
- **ReinstateFlight** = Reinstate a cancelled flight
- **UpdateEquipment** = Update aircraft information
- **GateOutage** = Mark a gate unavailable for a time window (a resource message, not a flight message)
- **DivertFlight** = An unscheduled inbound that needs a gate soon (a medical diversion, an air turnback, ...)

---

## Creating a New Flight

### Example - Simple Direct Flight

```json
{
  "action": "CreateFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "123",
    "flightSuffix": null,
    "originatingDate": "2025-06-15"
  },
  "legs": [
    {
      "legType": "Originating",
      "aircraftType": "73G",
      "departureStation": "YYZ",
      "arrivalStation": "YVR",
      "scheduledDepartureTime": "12:00",
      "scheduledArrivalTime": "14:30"
    }
  ]
}
```

**Plain English**:
> "Create a new flight schedule for Air Canada flight 123 on June 15th, 2025. It's a single-leg flight using a Boeing 737-700, departing Toronto at 12:00 PM and arriving in Vancouver at 2:30 PM local time."

---

### Example - Multi-Leg Flight Route

```json
{
  "action": "CreateFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "456",
    "flightSuffix": null,
    "originatingDate": "2025-08-20"
  },
  "legs": [
    {
      "legType": "Originating",
      "aircraftType": "321",
      "departureStation": "YYZ",
      "arrivalStation": "YUL",
      "scheduledDepartureTime": "08:00",
      "scheduledArrivalTime": "10:00"
    },
    {
      "legType": "Through",
      "aircraftType": "321",
      "departureStation": "YUL",
      "arrivalStation": "YYZ",
      "scheduledDepartureTime": "11:00",
      "scheduledArrivalTime": "13:00"
    }
  ]
}
```

**Plain English**:
> "Create a new flight schedule for Air Canada flight 456 on August 20th, 2025. It's a two-leg route using an Airbus A321:
> - First leg: Toronto to Montreal, departing 8:00 AM arriving 10:00 AM
> - Second leg: Montreal to Toronto, departing 11:00 AM arriving 1:00 PM"

---

## Field Descriptions

### Action Field

**`action`** (string, required)

Specifies the type of operation to perform:
- `"CreateFlight"` = Create a new flight schedule (equivalent to ASM NEW)
- `"ReplaceFlight"` = Replace existing schedule (equivalent to ASM RPL)
- `"UpdateTiming"` = Update timing only (equivalent to ASM TIM)
- `"CancelFlight"` = Cancel a flight (equivalent to ASM CNL)
- `"ReinstateFlight"` = Reinstate cancelled flight (equivalent to ASM RIN)
- `"UpdateEquipment"` = Update aircraft type (equivalent to ASM EQT)

---

### Flight Object

The `flight` object identifies which flight is being created or modified.

**`carrier`** (string, required)
- Two-character airline code (e.g., "AC", "UA", "BA")
- The airline operating this flight

**`flightNumber`** (string, required)
- 1-4 digit flight identifier (e.g., "100", "1234")
- Uniquely identifies the flight for that carrier

**`flightSuffix`** (string, optional)
- Single letter suffix (e.g., "A", "B")
- Use `null` if no suffix
- Used when multiple versions of the same flight number exist

**`originatingDate`** (string, required)
- ISO 8601 date format: "YYYY-MM-DD" (e.g., "2025-06-15")
- The local date when the flight sequence begins at the first station

---

### Legs Array

The `legs` array contains one or more flight leg objects. Each leg represents a segment from one airport to another.

**`legType`** (string, required)
- `"Originating"` = First leg of the flight
- `"Through"` = Subsequent connecting legs
- First leg must always be "Originating"

**`aircraftType`** (string, required)
- 3-character aircraft code (e.g., "73G", "321", "789")
- The model of aircraft operating this leg

**`departureStation`** (string, required)
- Three-character airport code (e.g., "YYZ", "JFK", "LAX")
- Where this leg departs from

**`arrivalStation`** (string, required)
- Three-character airport code (e.g., "YVR", "LHR", "AMS")
- Where this leg arrives

**`scheduledDepartureTime`** (string, required)
- 24-hour time format: "HH:MM" (e.g., "08:00", "14:30", "23:45")
- Local time at the departure station

**`scheduledArrivalTime`** (string, required)
- 24-hour time format: "HH:MM" (e.g., "10:00", "17:15", "01:30")
- Local time at the arrival station
- Can be next day if overnight (indicated by time earlier than departure)

---

## Complete Examples

### Example 1: Create Three-Leg Flight Route

```json
{
  "action": "CreateFlight",
  "flight": {
    "carrier": "UA",
    "flightNumber": "1000",
    "flightSuffix": null,
    "originatingDate": "2025-09-01"
  },
  "legs": [
    {
      "legType": "Originating",
      "aircraftType": "789",
      "departureStation": "JFK",
      "arrivalStation": "LAX",
      "scheduledDepartureTime": "09:00",
      "scheduledArrivalTime": "12:00"
    },
    {
      "legType": "Through",
      "aircraftType": "789",
      "departureStation": "LAX",
      "arrivalStation": "SFO",
      "scheduledDepartureTime": "13:30",
      "scheduledArrivalTime": "15:00"
    },
    {
      "legType": "Through",
      "aircraftType": "789",
      "departureStation": "SFO",
      "arrivalStation": "JFK",
      "scheduledDepartureTime": "16:30",
      "scheduledArrivalTime": "00:45"
    }
  ]
}
```

**Plain English**:
> "Create a new flight schedule for United flight 1000 on September 1st, 2025. It's a three-leg route using a Boeing 787-9:
> - First leg: JFK to LAX, departing 9:00 AM arriving 12:00 PM
> - Second leg: LAX to SFO, departing 1:30 PM arriving 3:00 PM
> - Third leg: SFO to JFK, departing 4:30 PM arriving 12:45 AM (next day)"

---

### Example 2: Replace Flight Schedule

```json
{
  "action": "ReplaceFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "100",
    "flightSuffix": null,
    "originatingDate": "2025-06-15"
  },
  "legs": [
    {
      "legType": "Originating",
      "aircraftType": "73G",
      "departureStation": "YYZ",
      "arrivalStation": "YUL",
      "scheduledDepartureTime": "16:00",
      "scheduledArrivalTime": "18:00"
    }
  ]
}
```

**Plain English**:
> "Replace the existing schedule for Air Canada flight 100 on June 15th, 2025 with a new departure time of 4:00 PM and arrival time of 6:00 PM."

---

### Example 3: Update Flight Timing

```json
{
  "action": "UpdateTiming",
  "flight": {
    "carrier": "AC",
    "flightNumber": "200",
    "flightSuffix": null,
    "originatingDate": "2025-08-20"
  },
  "legs": [
    {
      "legType": "Originating",
      "aircraftType": "321",
      "departureStation": "YYZ",
      "arrivalStation": "YUL",
      "scheduledDepartureTime": "08:15",
      "scheduledArrivalTime": "10:15"
    }
  ]
}
```

**Plain English**:
> "Update only the timing for Air Canada flight 200 on August 20th, 2025. New departure is 8:15 AM, new arrival is 10:15 AM."

---

## Cancel Flight Messages

### Example 1: Cancel Entire Flight

```json
{
  "action": "CancelFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "100",
    "flightSuffix": null,
    "originatingDate": "2025-06-15"
  },
  "cancelScope": {
    "type": "AllLegs"
  }
}
```

**Plain English**:
> "Cancel all legs of Air Canada flight 100 on June 15th, 2025."

---

### Example 2: Cancel Specific Leg

```json
{
  "action": "CancelFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "200",
    "flightSuffix": null,
    "originatingDate": "2025-08-20"
  },
  "cancelScope": {
    "type": "SpecificLeg",
    "departureStation": "YUL",
    "arrivalStation": "YYZ"
  }
}
```

**Plain English**:
> "Cancel the specific leg of Air Canada flight 200 on August 20th, 2025 that goes from Montreal (YUL) to Toronto (YYZ)."

---

## Reinstate Flight Message

```json
{
  "action": "ReinstateFlight",
  "flight": {
    "carrier": "AC",
    "flightNumber": "100",
    "flightSuffix": null,
    "originatingDate": "2025-06-15"
  }
}
```

**Plain English**:
> "Reinstate Air Canada flight 100 on June 15th, 2025 that was previously cancelled. All legs return to scheduled status."

---

## Update Equipment Messages

### Example 1: Update Equipment for All Legs

```json
{
  "action": "UpdateEquipment",
  "flight": {
    "carrier": "AC",
    "flightNumber": "100",
    "flightSuffix": null,
    "originatingDate": "2025-06-15"
  },
  "equipmentUpdate": {
    "scope": "AllLegs",
    "aircraftType": "789"
  }
}
```

**Plain English**:
> "Update the aircraft type for all legs of Air Canada flight 100 on June 15th, 2025 to a Boeing 787-9."

---

### Example 2: Update Equipment for Specific Leg

```json
{
  "action": "UpdateEquipment",
  "flight": {
    "carrier": "AC",
    "flightNumber": "200",
    "flightSuffix": null,
    "originatingDate": "2025-08-20"
  },
  "equipmentUpdate": {
    "scope": "SpecificLeg",
    "departureStation": "YYZ",
    "arrivalStation": "YUL",
    "aircraftType": "73G"
  }
}
```

**Plain English**:
> "Update the aircraft type for the Toronto to Montreal leg of Air Canada flight 200 on August 20th, 2025 to a Boeing 737-700."

---

## Gate Outage Messages

A **GateOutage** is a *resource* message, not a flight message. It announces that a
specific gate will be unavailable for a time window (a maintenance event, equipment
failure, or operational closure). It has **no `flight` object** and **no `legs`** — it
carries the gate id and the outage window instead.

```json
{
  "action": "GateOutage",
  "gate": "D1",
  "scheduledStartTime": "10:00",
  "scheduledEndTime": "15:00"
}
```

**Plain English**:
> "Gate D1 is out of service from 10:00 AM to 3:00 PM. No flight may occupy it during
> that window, and any flight already assigned there must be moved."

- **`gate`** (string, required) — the gate id, e.g. `"D1"`.
- **`scheduledStartTime`** (string, required) — `HH:MM`, when the gate goes offline.
- **`scheduledEndTime`** (string, optional) — `HH:MM`, when it returns. If omitted, the
  outage lasts until further notice. May be earlier than the start time if the window
  crosses midnight.

Like flight messages, a GateOutage appears at an info-delivery time in the schedule, so
the system only learns about it when it is announced.

---

## Divert Flight Messages

A **DivertFlight** is an *unscheduled* inbound that was not in the filed schedule and now
needs a gate soon — a medical emergency diversion, or an aircraft that departed and has to
turn back. It looks like a one-leg `CreateFlight` plus a `reason`, and it usually arrives
only a short time after it is announced.

```json
{
  "action": "DivertFlight",
  "reason": "medical",
  "flight": { "carrier": "QK", "flightNumber": "501", "flightSuffix": null, "originatingDate": "2025-06-15" },
  "legs": [
    { "legType": "Originating", "aircraftType": "321", "departureStation": "YQB", "arrivalStation": "YYZ", "scheduledDepartureTime": "10:00", "scheduledArrivalTime": "11:15" }
  ]
}
```

**Plain English**:
> "An A321 from Quebec City is diverting to Toronto for a medical emergency and will land
> at 11:15 — find it a gate now."

- **`reason`** (string) — e.g. `"medical"`, `"turnback"`, `"diversion"` (informational).
- **`legs`** — one inbound leg ending at YYZ, same shape as a flight leg.
- A turnback (a plane that left YYZ and returns) is modeled the same way: the returning
  aircraft arrives unscheduled (often with a flight suffix like `"R"`).

The solution sees diverted flights flagged as **priority** in the observation, and leaving
one unassigned costs a heavier penalty than an ordinary flight.

---

## JSON Schema Notes

### Required vs Optional Fields

**Always Required:**
- `action`
- `flight` object with all its properties (except `flightSuffix` which can be `null`)

**Conditionally Required:**
- `legs` array - Required for `CreateFlight`, `ReplaceFlight`, and `UpdateTiming` actions
- `cancelScope` - Required for `CancelFlight` action
- `equipmentUpdate` - Required for `UpdateEquipment` action

**Optional:**
- `flightSuffix` - Can be `null` or omitted if not applicable

---

### Data Types

- **Strings**: Used for codes, identifiers, times
- **Arrays**: Used for legs collection
- **Objects**: Used for complex structures (flight, legs, cancelScope, equipmentUpdate)
- **ISO 8601 Dates**: Used for originating date (YYYY-MM-DD format)
- **24-hour Time**: Used for departure/arrival times (HH:MM format)

---

### Naming Convention

- Property names use camelCase (e.g., `departureStation`, `aircraftType`)
- Enum values use PascalCase (e.g., `"Originating"`, `"Through"`, `"AllLegs"`)
- All airline/airport codes in UPPERCASE

---

### Validation Rules

1. **Carrier**: Must be exactly 2 characters
2. **Flight Number**: Must be 1-4 digits
3. **Flight Suffix**: Must be exactly 1 letter or `null`
4. **Station Codes**: Must be exactly 3 characters
5. **Aircraft Type**: Must be exactly 3 characters
6. **Times**: Must be in HH:MM format (00:00 to 23:59)
7. **Dates**: Must be valid ISO 8601 date (YYYY-MM-DD)
8. **Leg Type**: Must be "Originating" or "Through"
9. **First Leg**: Must always have legType "Originating"
10. **Subsequent Legs**: Must have legType "Through"
11. **Leg Connections**: Arrival station of one leg must match departure station of next leg
12. **Cancel Scope Type**: Must be "AllLegs" or "SpecificLeg"
13. **Equipment Scope**: Must be "AllLegs" or "SpecificLeg"

---

## Message Processing Rules

When working with JSON flight messages:

1. **CreateFlight** requires complete leg information for all legs
2. **ReplaceFlight** replaces entire schedule - provide all new leg information
3. **UpdateTiming** updates only times - aircraft and stations from existing schedule
4. **CancelFlight** with "AllLegs" cancels entire flight
5. **CancelFlight** with "SpecificLeg" requires departureStation and arrivalStation
6. **ReinstateFlight** only works on previously cancelled flights
7. **UpdateEquipment** with "AllLegs" updates all legs to same aircraft type
8. **UpdateEquipment** with "SpecificLeg" requires departureStation and arrivalStation
9. **Flight dates** are in local time at the originating station
10. **Times** are in 24-hour format and in local time at each respective station
11. **Multi-leg flights** must have connecting legs (arrival of one = departure of next)

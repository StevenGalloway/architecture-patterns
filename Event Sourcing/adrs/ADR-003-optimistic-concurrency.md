# ADR-003: Enforce optimistic concurrency with expected aggregate version

## Status
Accepted

## Date
2026-01-11

## Context
Multiple writers may issue commands concurrently. Without concurrency control, you can lose updates or append events in invalid sequences.

## Decision
Command handlers supply `expected_version` to the event store. The event store appends only if:
`current_version == expected_version`, otherwise returns 409.

## Consequences
- prevents lost updates
- clients/handlers must retry by reloading and reapplying intent

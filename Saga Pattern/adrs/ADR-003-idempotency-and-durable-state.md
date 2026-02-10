# ADR-003: Persist saga state and processed message IDs durably

## Status
Accepted

## Date
2026-01-11

## Context
Orchestrator restarts must not lose progress. Duplicate messages must not advance the saga incorrectly.

## Decision
- Store saga state in a durable store (BoltDB in this example)
- Track processed message IDs for dedupe (idempotency)
- Guard state transitions (ignore out-of-order events)

## Consequences
- safe recovery after crash/restart
- adds storage, schema/versioning, and operational considerations

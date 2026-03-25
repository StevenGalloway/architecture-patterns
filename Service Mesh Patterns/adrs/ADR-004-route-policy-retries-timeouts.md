# ADR-004: Define retries and timeouts at the mesh layer (with safeguards)

## Status
Accepted

## Date
2026-01-11

## Context
Unbounded retries and inconsistent timeouts can create retry storms and cascading failures.

## Decision
Use mesh resources (e.g., ServiceProfile) to define:
- per-route timeout budgets
- limited retries with backoff (where supported)
Add safeguards:
- do not retry non-idempotent operations by default
- cap retry attempts and overall request deadline

## Consequences
- consistent client behavior across services
- requires careful policy governance to avoid amplifying incidents

# ADR-005: Instrument cache metrics and define SLOs

## Status
Accepted

## Date
2026-01-11

## Context
Caching issues can be silent: low hit ratio, evictions, stale data.

## Decision
Track:
- hit/miss ratios, latency, evictions, Redis errors
- stampede lock contention and stale serve rate
Set SLOs for p95/p99 latency and error budgets per endpoint.

## Consequences
- safer tuning and faster incident response
- requires dashboards and alert ownership

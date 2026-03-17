# ADR-005: Observability, alerts, and runbooks for invalidation

## Status
Accepted

## Date
2026-01-11

## Context
Cache coherency failures can be silent (stale reads, low hit ratio, event lag).

## Decision
Instrument:
- invalidation publish/consume counts
- consumer errors and reconnects
- cache hit ratio (L1/L2), stale serve rate
Runbooks:
- how to flush namespaces safely
- how to troubleshoot NATS/Redis outages
- how to verify propagation across instances

## Consequences
- faster incident resolution and safer tuning
- requires dashboards and ownership

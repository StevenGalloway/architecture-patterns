# ADR-005: Define operational SLOs and runbooks for streaming

## Status
Accepted

## Date
2026-01-11

## Context
Streaming failures can silently degrade data freshness and trust.

## Decision
Track and alert on:
- consumer lag
- checkpoint failures / restart loops
- late event rates
- end-to-end freshness SLO (event time to serving time)
Provide runbooks for replay, backfill, and incident response.

## Consequences
- predictable operations and faster recovery
- requires dashboards, alerts, and on-call readiness

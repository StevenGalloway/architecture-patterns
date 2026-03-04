# ADR-005: Instrument bulkhead saturation and tune limits using SLOs

## Status
Accepted

## Date
2026-01-11

## Context
Bulkhead limits are workload- and dependency-specific. Without visibility, limits will drift and cause either needless rejects or insufficient isolation.

## Decision
Track and alert on:
- permits in-use and saturation time
- reject counts / rates (by dependency)
- downstream latency (p95/p99) and timeout rates
- correlation to incident timelines and deploys

## Consequences
- enables safe tuning and faster incident response
- requires dashboards and on-call runbooks

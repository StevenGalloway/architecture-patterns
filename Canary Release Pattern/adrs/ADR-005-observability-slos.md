# ADR-005: Observability is mandatory for Canary rollouts

## Status
Accepted

## Date
2026-01-11

## Context
Canary analysis needs reliable data to make correct decisions.

## Decision
Instrument and alert on:
- request rate, error rate, p95/p99 latency
- dependency failures/timeouts
- rollout events (step transitions, aborts, promotions)
Maintain dashboards and runbooks for interpreting canary results.

## Consequences
- safer and faster delivery
- requires ownership for metrics and alert hygiene

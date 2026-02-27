# ADR-005: Observability and SLOs for resilience controls

## Status
Accepted

## Date
2026-01-11

## Context
Resilience cannot be tuned safely without visibility into latency, error rates, and breaker behavior.

## Decision
Instrument and alert on:
- downstream latency (p50/p95/p99), timeouts
- retry counts and retry success rate
- circuit breaker state transitions + time open
- fallback rate and error budgets

## Consequences
- safer tuning and faster incident response
- requires dashboards and alert ownership

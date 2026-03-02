# ADR-003: Prefer fail-fast over unbounded queueing

## Status
Accepted

## Date
2026-01-11

## Context
Queueing inside a saturated system often increases latency and makes failure recovery slower (tail latency blowups).

## Decision
Prefer **fail-fast** when bulkhead permits are exhausted:
- return 429/503 (optionally with Retry-After)
- degrade gracefully with fallback for eligible endpoints
- avoid unbounded internal queues

## Consequences
- protects system stability and preserves headroom
- requires client-facing behavior expectations and potential retries at caller side

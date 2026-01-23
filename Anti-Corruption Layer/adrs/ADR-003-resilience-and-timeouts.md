# ADR-003: Apply strict timeouts and circuit breaker in the ACL

## Status
Accepted

## Date
2026-01-11

## Context
Vendor APIs are prone to latency spikes and throttling. We must protect upstream services and preserve user experience.

## Decision
In the ACL:
- enforce per-call **timeout budgets**
- apply **retries with backoff + jitter** for idempotent reads only
- use a **circuit breaker** for sustained failures
- optionally cache stable responses (short TTL) when acceptable

## Consequences
- Prevents cascading failures from vendor instability
- May return partial/fallback responses depending on product requirements

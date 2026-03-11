# ADR-004: Use event-driven invalidation for correctness-sensitive data

## Status
Accepted

## Date
2026-01-11

## Context
TTL-only caching can be stale longer than business tolerates after writes.

## Decision
Publish domain events on writes and invalidate affected keys:
- pub/sub for small systems
- outbox/CDC for reliable publication at scale

## Consequences
- better freshness without ultra-short TTLs
- requires event infrastructure and idempotent handlers

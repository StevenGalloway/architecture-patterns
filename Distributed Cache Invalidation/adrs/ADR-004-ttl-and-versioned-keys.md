# ADR-004: Use TTLs and versioned keys as safety nets

## Status
Accepted

## Date
2026-01-11

## Context
Pub/Sub can drop messages under failure conditions. TTL-only caching can be too stale, but TTL prevents infinite staleness if invalidation is missed.

## Decision
- Maintain reasonable TTLs on cache entries
- Use versioned keys (`v1`, `v2`) during deploys/schema changes

## Consequences
- improved robustness when invalidation is imperfect
- requires TTL tuning and migration practices

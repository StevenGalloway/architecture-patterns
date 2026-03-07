# ADR-003: Use Redis for global rate limit state

## Status
Accepted

## Date
2026-01-11

## Context
In a horizontally scaled edge tier, local in-memory counters are insufficient for consistent enforcement.

## Decision
Store quota counters in **Redis** with key TTLs aligned to window boundaries.

## Consequences
- consistent enforcement across edge instances
- Redis availability becomes part of the critical path; requires HA and monitoring

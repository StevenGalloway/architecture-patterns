# ADR-002: Use SWR + distributed locks to prevent cache stampedes

## Status
Accepted

## Date
2026-01-11

## Context
High concurrency can cause many workers to miss at once, overloading the origin.

## Decision
- Use a short-lived **distributed lock** per hot key (SETNX + TTL)
- Serve **stale-while-revalidate (SWR)** when a refresh is in flight

## Consequences
- higher availability during spikes
- bounded staleness must be acceptable per endpoint

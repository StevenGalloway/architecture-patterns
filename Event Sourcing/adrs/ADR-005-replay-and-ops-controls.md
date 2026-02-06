# ADR-005: Provide replay tooling and operational controls

## Status
Accepted

## Date
2026-01-11

## Context
Projection bugs, schema changes, and new read models require rebuilding derived data. Without replay tooling, recovery and migrations are risky.

## Decision
- Projector stores a cursor and supports resetting it for replay/backfill
- Rebuild read models into versioned stores (v1/v2) and cut over safely
- Emit metrics for lag, throughput, and apply failures

## Consequences
- safer operations and migrations
- requires runbooks and capacity planning for large replays

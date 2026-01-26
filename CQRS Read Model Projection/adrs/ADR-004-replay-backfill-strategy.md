# ADR-004: Support replay/backfill to rebuild read models

## Status
Accepted

## Date
2026-01-11

## Context
Projection bugs, schema changes, or new read models require rebuilding from historical events or write-side truth.

## Decision
Provide operational capabilities:
- Reset projector offset (replay from beginning)
- Rebuild read model from scratch
- Optionally seed from a write DB snapshot, then catch up via events
- Monitor rebuild progress and lag

## Consequences
- Faster recovery from projection issues and safer migrations
- Requires tooling, runbooks, and capacity planning for replays

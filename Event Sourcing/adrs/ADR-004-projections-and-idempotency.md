# ADR-004: Projections are idempotent and track processed events

## Status
Accepted

## Date
2026-01-11

## Context
Projection pipelines are commonly at-least-once; duplicates can occur. Replays must not corrupt read models.

## Decision
- Projector tracks applied events in `processed_events` keyed by `event_id`
- Projection writes are idempotent (upserts)
- Per-aggregate ordering uses `aggregate_version`

## Consequences
- safe retries and replays
- adds storage and logic to the projector

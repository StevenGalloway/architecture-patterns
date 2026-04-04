# ADR-003: Establish replay/backfill strategy for correctness

## Status
Accepted

## Date
2026-01-11

## Context
Logic changes and late data require reprocessing to maintain accurate views.

## Decision
- retain Kafka topics long enough for expected backfills (or archive to object storage)
- use checkpointed stream processing
- implement “recompute windows” and/or overwrite partitions for backfills

## Consequences
- correctness improvements with controlled reprocessing
- requires cost management and clear operational procedures

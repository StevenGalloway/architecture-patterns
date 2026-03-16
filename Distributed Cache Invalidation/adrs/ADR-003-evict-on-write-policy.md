# ADR-003: Evict-on-write invalidation policy

## Status
Accepted

## Date
2026-01-11

## Context
Write paths must ensure stale cached values are not served after an update.

## Decision
On successful origin write:
- publish invalidation event
- locally evict L1 and delete L2 keys
Consumers:
- treat invalidation events as idempotent (safe to process multiple times)

## Consequences
- reduces stale windows across instances
- increases cache churn for write-heavy datasets

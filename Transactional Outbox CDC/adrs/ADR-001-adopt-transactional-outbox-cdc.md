# ADR-001: Adopt Transactional Outbox + CDC for integration event publication

## Status
Accepted

## Date
2026-01-11

## Context
We must publish integration events reliably when local state changes. Dual-writes to the database and message broker create inconsistency under failures.

## Decision
Use **Transactional Outbox**:
- Write business data and outbox event rows in the same DB transaction.
Use **CDC (Debezium)**:
- Stream committed outbox rows from Postgres WAL into Kafka topics.

## Consequences
### Positive
- Eliminates dual-write consistency bugs
- Events correspond to committed state
- Supports replay/backfill through Kafka offsets and outbox history

### Negative
- Requires CDC + Kafka operations
- Consumers must handle duplicates (at-least-once)

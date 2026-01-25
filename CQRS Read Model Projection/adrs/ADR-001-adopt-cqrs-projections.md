# ADR-001: Adopt CQRS with event-driven read model projections

## Status
Accepted

## Date
2026-01-11

## Context
Our system has high read volume with evolving query patterns and strict write-side invariants. A single shared model creates performance bottlenecks and slows iteration.

## Decision
Adopt **CQRS**:
- Commands handled by a write-optimized service + write database
- Domain events emitted on successful writes
- A projector builds and maintains denormalized read models
- Query service reads exclusively from read models

## Consequences
### Positive
- Independent scaling of reads and writes
- Faster evolution of read schemas without write-side refactors
- Cleaner domain enforcement on write side

### Negative
- Eventual consistency for reads
- Requires projection monitoring, replay tooling, and schema/version governance

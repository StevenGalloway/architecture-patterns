# ADR-001: Adopt Event Sourcing for the Account domain

## Status
Accepted

## Date
2026-01-11

## Context
We require strong auditability, deterministic replay, and traceability for transaction-like operations. CRUD updates obscure the sequence of business facts and complicate reconciliation and debugging.

## Decision
Adopt **Event Sourcing**:
- persist immutable domain events in an append-only event store
- derive current state by replaying events (optionally with snapshots)
- use projections for low-latency queries

## Consequences
### Positive
- complete audit trail and temporal reconstruction
- deterministic replay for debugging and backfills
- easy creation of new read models without write schema changes

### Negative
- increased operational complexity (projections, replays)
- requires event schema governance and versioning

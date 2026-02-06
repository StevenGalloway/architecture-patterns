# Event Sourcing Pattern (Enterprise-Ready)

## Summary
**Event Sourcing** stores application state as an **append-only sequence of immutable events** rather than as “current state” rows. The current state is derived by replaying events (often with snapshots and projections for performance).

Instead of persisting `Account.balance = 125`, you persist facts like:
- `AccountOpened`
- `MoneyDeposited`
- `MoneyWithdrawn`

State is computed as: `balance = Σ(deposits) - Σ(withdrawals)`

This package focuses on enterprise realities:
- **event contracts and versioning**
- **optimistic concurrency (expected version)**
- **idempotency**
- **snapshots and read projections**
- **replay/backfill and operational controls**
- **auditability and traceability**

---

## Problem
Traditional CRUD state storage struggles when you need:
- full audit history (“who changed what and why?”),
- temporal queries (“what did we know at time T?”),
- high-confidence replay for bugs and reconciliation,
- complex business workflows that evolve over time.

---

## Constraints & Forces
- Events are long-lived contracts (schema evolution is hard)
- Duplicates can occur when projecting (at-least-once processing)
- Ordering matters per aggregate
- Reads need low latency → projections are usually required
- Replays/backfills must be safe and operationally manageable

---

## Solution
### Write path
- Commands validate invariants and append events to an **Event Store**
- Use **optimistic concurrency**:
  - client sends `expected_version`
  - event store rejects if current aggregate version != expected_version

### Read path
- Build **read models** by projecting events into query-optimized stores
- Optionally generate **snapshots** to speed up rehydration

### Operational tooling
- Replay events to rebuild projections
- Version projections (v1/v2) during migrations
- Monitor projection lag and failures

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-append-and-rehydrate-sequence.mmd`
- `diagrams/03-projection-snapshot-replay.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-event-sourcing.md`
- `adrs/ADR-002-event-schema-versioning.md`
- `adrs/ADR-003-optimistic-concurrency.md`
- `adrs/ADR-004-projections-and-idempotency.md`
- `adrs/ADR-005-replay-and-ops-controls.md`

---

## Example (Different Tech)
This example uses **Python + FastAPI + SQLite** (different from previous Node/Express patterns):
- `command-api`: accepts commands and appends events
- `projector`: tails the event store and builds a read model
- `query-api`: serves queries from the read model

See `examples/python-event-sourcing/`.

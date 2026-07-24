# Event Sourcing Pattern (Enterprise-Ready)

## Summary
**Event Sourcing** stores application state as an **append-only sequence of immutable events** rather than as "current state" rows. The current state is derived by replaying events (often with snapshots and projections for performance).

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
- full audit history ("who changed what and why?"),
- temporal queries ("what did we know at time T?"),
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

## Failure Modes & Mitigations

| Failure Mode | Signal | Mitigation |
|---|---|---|
| Projection lag grows unbounded | `projection.lag.seconds` > SLO | Investigate projector errors; check event store read latency; scale projector compute |
| OCC conflicts on hot aggregate | `occ_failures.rate` sustained > 0 | Redesign aggregate boundary; consider splitting the aggregate |
| Schema version mismatch | `projection.errors.rate` spike | Version dispatch in projector; deploy schema-aware projector before publishing new event version |
| Snapshot staleness → slow rehydration | `rehydrate.latency.p99` spike | Verify snapshot job health; trigger snapshot backfill for affected aggregate type |
| Event log storage exhaustion | Disk utilization trend | Verify archival job is running; move events > 90 days to object storage |
| Replay corrupts production read model | Read model returns wrong data | Replay isolation: always replay to a separate read model; swap atomically when complete |

---

## Security Considerations

The event log is simultaneously the most valuable asset in the system and the most sensitive: it contains the complete history of every business fact, including data that has since been superseded. Unauthorized write access is uniquely severe because events cannot be corrected without breaking the audit guarantee — a fabricated event becomes permanent history. Write path access must be restricted to the command handler service account at the database permission level, not just at the application level. Immutability must be enforced by database constraints that prevent UPDATE and DELETE on event rows, not by application discipline alone. GDPR's right to erasure conflicts directly with immutability: the resolution is crypto-shredding — encrypting PII fields per-subject and deleting the encryption key on erasure, leaving the event record intact but the PII permanently unreadable. Replay operations must run in isolated environments against separate read models; replaying directly against production read models risks replacing live data with historical state.

→ See [SECURITY.md](SECURITY.md)

---

## Observability Considerations

Projection lag is the primary health signal for an event-sourced system and has no equivalent in traditional CRUD observability. A system where commands succeed but projections are hours behind looks healthy to conventional request-latency monitoring — but queries are returning stale data. The OCC (optimistic concurrency conflict) error rate is a contention indicator: a sustained non-zero rate on a specific aggregate type signals that the aggregate boundary is too coarse and multiple concurrent writers are competing. Snapshot age is a leading indicator of rehydration latency: when the snapshot job falls behind for a hot aggregate type, rehydration latency begins growing before it is visible in user-facing metrics. Replay event rate is the key operational indicator: a spike in `eventsource.replay.events.replayed.total` distinguishes a planned backfill (expected infrastructure load) from an anomalous projection restart (potential incident).

→ See [OBSERVABILITY.md](OBSERVABILITY.md)

---

## Team Topology

Event Sourcing requires a **complicated-subsystem team** — not just platform engineers — because the operational concerns (replay correctness, snapshot validity, schema evolution, projection ordering guarantees) require deep pattern expertise. The most important structural insight: **the aggregate boundary is the team boundary**. If two teams publish events to the same aggregate stream, you get conflicting invariant enforcement — the command handler cannot correctly validate business rules when it does not control all events that affect aggregate state. Conway's Law predicts this failure: any organization where aggregate ownership is ambiguous will eventually produce an aggregate with inconsistent invariants.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md)

---

## Cost Analysis

Event Sourcing's cost profile differs fundamentally from CRUD persistence: the event log grows forever and cannot be truncated without destroying the audit trail. At 1B events/month with 1.5 KB average payload, unmanaged hot storage accumulates to ~126 TB over 7 years — requiring a tiered archival strategy from day one. **Snapshot strategy is the primary cost lever**: snapshot frequency directly trades storage cost against rehydration compute cost, and no snapshot strategy causes rehydration latency to grow linearly with aggregate age.

| Option | 10M events/mo | 100M events/mo | 1B events/mo | Best For |
|---|---|---|---|---|
| PostgreSQL self-managed | ~$65 | ~$210 | ~$900 | High volume, operational maturity |
| EventStoreDB managed | ~$240 | ~$695 | ~$2,500 | Teams new to event sourcing |
| DynamoDB Streams + Lambda | ~$80 | ~$370 | ~$2,600 | Spiky workloads (replay limitations apply) |

PostgreSQL self-hosted wins at high event volume but requires building replay infrastructure, snapshot management, and monitoring from scratch. EventStoreDB managed wins at lower volumes because the built-in replay API, projection engine, and operational tooling eliminate 4–6 engineer-weeks of platform work.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md)

---

## AI Integration

Event Sourcing and AI systems share a fundamental requirement: a complete, timestamped, immutable record of what happened and why. Key integration themes:

- **Audit trail for AI decisions** — Every model prediction is sourced as an event with model version, input features hash, confidence score, and contributing factors. Satisfies GDPR Art. 22 right to explanation and emerging AI governance regulations years after the decision was made.
- **Event replay for model retraining** — The event log is a self-contained, labeled training dataset. Replay events through a new feature extractor to generate training data without a separate ETL pipeline — eliminating training-serving skew.
- **AI action sourcing in agentic systems** — Every action taken by an autonomous AI agent is an event. The event store provides the rollback and compensation foundation that agentic systems require: replay from a checkpoint before a bad decision, with the bad action preserved in history as evidence.
- **Temporal queries for model drift detection** — Query what the model predicted for requests with given characteristics 6 months ago. Without Event Sourcing, this comparison is impossible; predictions were overwritten.
- **Projection versioning maps to model versioning** — A retrained model is a new projection of the same event log with a different feature extraction function. Both model versions can be evaluated side-by-side by projecting the same events through two feature extractors simultaneously.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md)

---

## Platform Engineering

The event store is a platform capability — not something each domain team stands up independently. When teams implement their own append-only tables, they diverge on idempotency semantics, schema validation strategies, and sequence numbering schemes. These inconsistencies surface as production incidents that require expensive cross-team remediation. A team adopting Event Sourcing through the platform receives: managed event store, schema registry integration, standard event envelope, idempotent append API, replay API, projection monitoring, and snapshot management — without standing up any infrastructure. Anti-patterns that signal the platform has failed include teams writing events directly to shared tables, teams implementing their own deduplication instead of using the platform's idempotent append API, and teams maintaining a parallel mutable state table alongside their event store.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md)

---

## Business Case

Event Sourcing transforms a 3-day manual audit reconstruction process (with provable gaps) into a 10-minute query, directly addresses regulatory audit findings, and provides the infrastructure for bug investigations that currently require multi-team, multi-day efforts — at a cost of 2 engineers × 4 weeks and $200–800/month ongoing infrastructure.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md)

---

## Diagrams

### C4 Model
- [`diagrams/c4-context.mmd`](diagrams/c4-context.mmd) — System context: command users, query users, ops engineers, and external systems (Identity Provider, Message Broker, Schema Registry, Archival Storage)
- [`diagrams/c4-container.mmd`](diagrams/c4-container.mmd) — Container view: Command Handler, Event Store, Snapshot Store, Projection Engine, Read Model Store, Query API, Replay Controller

### Architecture & Flow
- [`diagrams/01-context.mmd`](diagrams/01-context.mmd)
- [`diagrams/02-append-and-rehydrate-sequence.mmd`](diagrams/02-append-and-rehydrate-sequence.mmd)
- [`diagrams/03-projection-snapshot-replay.mmd`](diagrams/03-projection-snapshot-replay.mmd)

---

## ADRs
- [ADR-001: Adopt Event Sourcing for the Account Domain](adrs/ADR-001-adopt-event-sourcing.md)
- [ADR-002: Event Schema Versioning and 7-Year Retention](adrs/ADR-002-event-schema-versioning.md)
- [ADR-003: Optimistic Concurrency Control](adrs/ADR-003-optimistic-concurrency.md)
- [ADR-004: Projections and Idempotency](adrs/ADR-004-projections-and-idempotency.md)
- [ADR-005: Replay and Operational Controls](adrs/ADR-005-replay-and-ops-controls.md)

---

## Example (Different Tech)
This example uses **Python + FastAPI + SQLite** (different from previous Node/Express patterns):
- `command-api`: accepts commands and appends events
- `projector`: tails the event store and builds a read model
- `query-api`: serves queries from the read model

See `examples/python-event-sourcing/`.

# CQRS + Read Model Projection (Beyond the Basic)

## Summary
**CQRS (Command Query Responsibility Segregation)** separates the **write path** (commands that change state) from the **read path** (queries optimized for retrieval).

In an enterprise setup, CQRS becomes powerful when paired with **Read Model Projection**:
- Commands write to a **normalized write store** (transactional model)
- Domain events are emitted
- A **projector** consumes events and builds one or more **denormalized read models**
- Query services read from the read store(s) optimized for specific access patterns

This “beyond basic” version focuses on the practical realities:
- **eventual consistency**
- **backfills & replays**
- **projection versioning**
- **idempotency**
- **schema evolution**
- **operational controls**

---

## Problem
Single-model systems struggle when:
- reads are high-volume and require complex joins/search/sorts
- writes require strict validation and transactional integrity
- mixing read/write concerns causes performance bottlenecks and data model rigidity

Teams also need to evolve query shapes independently without blocking write-side changes.

---

## Constraints & Forces
- Read traffic often dwarfs write traffic (10x–100x)
- Query patterns evolve rapidly (new screens, analytics, search)
- Write side must preserve business invariants and correctness
- Distributed systems require tolerance for duplicates and out-of-order events
- Projection lag must be measurable and controlled
- Backfills and schema evolution must be safe

---

## Solution
Implement CQRS with event-driven projections:

### Write path (Commands)
- Commands go to the **Command Service**
- Validate invariants and persist to **Write DB**
- Publish a domain event (e.g., `OrderCreated`) to an event bus

### Projection path
- A **Projector** consumes domain events
- Updates one or more **Read Models** (denormalized tables/views/document store)
- Implements idempotency and ordering rules

### Read path (Queries)
- Query Service reads exclusively from **Read DB**
- Read schema is optimized for UI/consumer query patterns
- Multiple read models are allowed (per use case)

---

## “Beyond the basic” enterprise features
1. **Projection versioning**
   - v1 and v2 read models can coexist during migration
2. **Replay/backfill**
   - rebuild read models from an event stream or from write DB snapshots + event catch-up
3. **Lag monitoring**
   - measure “event time” vs “projection time” and alert on lag
4. **Idempotency & dedupe**
   - protect against duplicate event delivery (at-least-once)
5. **Schema evolution**
   - event versioning and backward compatible projections
6. **Consistency strategy**
   - define acceptable staleness; offer “read-your-writes” where required (optional)

---

## When to Use
- High read throughput and complex query needs
- Distinct write invariants and read optimization requirements
- Multiple downstream consumers require stable event stream
- You can accept eventual consistency on reads (for many views)

---

## When Not to Use
- Simple CRUD with low read complexity
- Strict read-after-write consistency required everywhere
- Team lacks operational maturity for eventing/projection reliability

---

## Tradeoffs
### Benefits
- Scale reads independently
- Faster UI iteration (read models evolve without write refactors)
- Clearer domain correctness on write side
- Enables multiple tailored read models

### Costs / Risks
- Eventual consistency: reads can be stale
- Projection pipeline adds failure modes
- Operational overhead: monitoring, replays, schema evolution

---

## Failure Modes & Mitigations
1. **Projection lag**
   - Mitigation: backpressure controls, scaling, lag dashboards, alerting
2. **Duplicate/out-of-order events**
   - Mitigation: idempotency keys, per-aggregate ordering, dedupe store
3. **Projection bugs corrupt read model**
   - Mitigation: versioned projections, rebuild-from-scratch capability, canary projectors
4. **Schema evolution breaks consumers**
   - Mitigation: event versioning, compatibility tests, staged rollouts
5. **Read model drift from write truth**
   - Mitigation: reconciliation jobs, periodic checks, replay tooling

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-command-to-projection-sequence.mmd`
- `diagrams/03-projection-replay-and-versioning.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-cqrs-projections.md`
- `adrs/ADR-002-event-contracts-and-versioning.md`
- `adrs/ADR-003-idempotent-projection.md`
- `adrs/ADR-004-replay-backfill-strategy.md`
- `adrs/ADR-005-consistency-read-your-writes.md`

---

## Example
See `examples/node-cqrs/` for a runnable demo:
- `command-service` writes orders and emits events
- `event-bus-mock` is a minimal event bus (HTTP publish + SSE subscribe)
- `projector` consumes events and updates a read model store
- `query-service` serves optimized read queries from the read model

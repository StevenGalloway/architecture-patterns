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

## Security Considerations

CQRS introduces security boundaries that do not exist in a single-model architecture. The event bus is a new attack surface: a compromised projector that can write to the event bus could inject false domain events, corrupting read models that downstream services and users trust. Read model stores hold denormalized data optimized for fast retrieval — which also means sensitive data is present in more places and in more exposed formats.

**Key security dimensions of CQRS:**
- **Event bus access control:** Publish permissions must be restricted to command services that own the event type. A projector should have read-only access to the event stream, never write access. A compromised projector writing to the event bus is a critical integrity failure.
- **Read model access scoping:** Read models are often denormalized and contain data from multiple domain entities. A query service that returns an entire read model to any authenticated caller may expose data that a given user is not authorized to see. Field-level access control must be applied at the query service layer, not just the read model.
- **Event replay security:** Replay operations process historical events at high volume. A replay trigger is a privileged operation — it can corrupt read models if the projection logic has changed incorrectly, and it generates significant event bus load that can affect other consumers. Replay authorization should require a separate elevated permission.
- **PII in event payloads:** Domain events that carry PII (customer email, order address) propagate that PII to every consumer of the event stream, including analytics projectors that may retain data for long periods. PII event fields must be minimized at the schema level, not managed per-consumer.

**Compliance relevance:** GDPR Article 17 (right to erasure — PII in immutable event streams requires a specific deletion strategy), SOC 2 CC6.1 (read model access audit log), PCI DSS Requirement 7 (access control for read models containing payment-adjacent data).

→ See [SECURITY.md](SECURITY.md) for the full threat model, event bus access control requirements, read model authorization patterns, event replay security controls, PII in event streams handling, and the right-to-erasure implementation strategy.

---

## Observability Considerations

The CQRS projection pipeline introduces a delay between write-side events and read-side data. Without observability on this delay — projection lag — the system has no way to distinguish "the projector is up to date" from "the projector is 4 hours behind and nobody knows." Projection lag is the primary observability concern that has no equivalent in a single-model architecture.

**Golden signals for CQRS projections:**
- **Latency:** Projection lag is the key latency metric: the time between an event's timestamp and the time it is reflected in the read model. Track `projection.lag.p95` per projector per event type. For real-time features, lag > 5 seconds should alert.
- **Traffic:** Monitor `projection.events_processed.rate` per projector. A drop in event processing rate indicates a stalled projector or a upstream event bus health issue.
- **Errors:** Track `projection.replay.error.rate` (projection errors during replay are harder to recover from than live errors), `projection.dead_letter.rate` (events that could not be processed after all retries), and `projection.duplicate.detection.rate` (at-least-once delivery metric).
- **Saturation:** Projector consumer group lag (how many events are in the backlog ahead of the current offset) is the primary saturation metric. A growing backlog means the projector is falling behind event production rate.

**SLO targets (reference):** Projection lag p95 < 2 seconds for real-time read models, < 30 seconds for analytics read models. Dead-letter queue rate < 0.01%. Projector availability 99.9%.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full projection lag measurement methodology, SLI/SLO definitions, structured log schema for projection events, dashboard designs, and 6 chaos engineering test scenarios including projector stall recovery.

---

## Team Topology

CQRS introduces a structural ownership problem: the projector sits exactly at the boundary between the command-side team and the consumer teams. Whoever owns the projector inherits dependencies from both directions — they must understand the domain event schema and the read model's query requirements simultaneously.

The recommended model at scale: the platform team provides a projector framework (event bus connectivity, offset management, idempotency, retry, lag monitoring, replay orchestration), and consumer teams write projection functions (pure transformations from event payload to read model update). Consumer teams own their projection logic and their read model schema; the platform team owns the infrastructure that runs it.

**Conway's Law signal:** If the projector is owned by the command-side team, the read models will look like the write-side schema with minor variations — consumers will find the data shape awkward and build transformations on top. If each consumer team owns their projector, read models match each consumer's mental model exactly, and the event schema becomes the contract.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the three ownership models, Conway's Law predictions for each, the interlock failure mode (analytics team needs data that the command-side team doesn't currently publish), and the scaling model from 1–2 to 10+ read models.

---

## Cost Analysis

CQRS adds infrastructure costs that do not exist in a single-model architecture: the event bus, the projector compute, and additional read model stores. The strategic question is whether the read path performance gains justify this overhead — and the answer is heavily traffic-dependent.

| Scale | Write traffic | Read traffic | Additional monthly cost | Break-even signal |
|---|---|---|---|---|
| Small | <1K writes/day | <100K reads/day | $50–$150 (managed Kafka + projector Fargate + one extra DB) | Likely not justified |
| Medium | 10K–100K writes/day | 10M reads/day | $300–$1,200 | Read DB query costs exceed CQRS overhead |
| Large | 1M+ writes/day | 1B+ reads/day | $3,000–$15,000 | Single-model architecture is not viable |

The break-even point: when read traffic is 100× write traffic and read queries are expensive (joins, aggregations, full-text search), CQRS read models reduce database load enough to justify the additional infrastructure cost and operational complexity within 6–12 months.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full cost breakdown including event bus, projector compute, read model storage at three scale tiers, and the cost of projection pipeline failures (replay cost after a projector bug is a significant hidden cost).

---

## AI Integration

CQRS and ML feature stores are the same pattern applied to the same problem: separate the write path (domain events / training labels) from the read path (feature retrieval for inference). Understanding this equivalence enables teams to apply CQRS operational maturity (projection versioning, replay strategy, lag monitoring) to ML feature store problems.

**Key ways this pattern extends for AI workloads:**
- **ML feature store as a read model:** ML features are projections of domain events — order history, user behavior, product interactions — computed and cached for fast inference retrieval. The CQRS projector is the feature computation pipeline; the read model is the feature store. The same projection versioning and replay strategy that applies to domain read models applies to feature store rebuild.
- **Separate read models for AI inference vs. human UI:** An inference read model is optimized for vector lookups and batch feature retrieval — low-cardinality keys, columnar storage, pre-computed embeddings. A UI read model is optimized for pagination, filtering, and display formatting. These are genuinely different access patterns requiring genuinely different schema designs.
- **Training data as a projection:** Project domain events into training datasets on a separate write path. The projector filters, transforms, and labels events for ML consumption. Replay gives you historical training data regeneration when labeling logic changes.
- **Projection versioning for model retraining:** When a model is retrained on a new feature schema, the projection rebuild strategy applies directly: do you migrate in place (risky), run v1 and v2 in parallel (safe, expensive), or rebuild from scratch (always safe, operationally complex)? This is the same rebuild vs. migration tradeoff CQRS practitioners already manage.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full feature store architecture as a CQRS read model, separate inference vs. UI read model design, training data projection pattern, and projection versioning strategy for model retraining cycles.

---

## Platform Engineering

The CQRS projection pipeline is a platform capability that consumer teams should consume via a framework, not build from scratch. Every projector needs the same infrastructure: event bus connectivity, consumer group offset management, at-least-once delivery handling, idempotency enforcement, lag monitoring, and replay orchestration. These are solved problems once the platform team invests in the solution.

**The paved road model:** A consumer team that needs a new read model should declare their projection configuration and write their projection function. The platform provides the runtime that handles everything else. Consumer teams should not write Kafka consumer group management code, implement their own idempotency store, or build lag monitoring — the platform framework provides these.

**Self-service projection registration:** Consumer teams declare their projection configuration in a YAML file in their repository. The platform framework reads this configuration, connects to the event bus, and runs the declared projection handler. No platform team ticket required for standard use cases.

**Platform contract:** The platform team commits to the projector framework handling at-least-once delivery correctly, lag metrics being emitted automatically per projector, and replay tooling being available as a runbook step — not a code change.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the projector framework interface, self-service configuration schema, platform contract definition, replay authorization and procedure, and signals that the projection pipeline has accumulated too much business logic.

---

## Business Case

CQRS with read model projection is the architectural foundation for high-read systems: it decouples query performance from write-side schema constraints, enables independent read model evolution, and provides the event stream that powers analytics, ML features, and real-time dashboards without impacting write performance.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for non-technical stakeholders (CPO, CFO, VP Engineering): the problem in plain language, what implementation costs in engineer-weeks and monthly infrastructure, what the business gains, and the risk of inaction.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (command service, event bus, projectors, read model stores, query services)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (command handler, write DB, event bus, projector framework, per-consumer read model stores, query service)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-command-to-projection-sequence.mmd](diagrams/02-command-to-projection-sequence.mmd) — Command to event to projection sequence flow
- [03-projection-replay-and-versioning.mmd](diagrams/03-projection-replay-and-versioning.mmd) — Projection replay and versioning strategy

---

## Architecture Decision Records
- [ADR-001: Adopt CQRS with event-driven projections](adrs/ADR-001-adopt-cqrs-projections.md)
- [ADR-002: Event contracts and versioning](adrs/ADR-002-event-contracts-and-versioning.md)
- [ADR-003: Idempotent projection strategy](adrs/ADR-003-idempotent-projection.md)
- [ADR-004: Replay and backfill strategy](adrs/ADR-004-replay-backfill-strategy.md)
- [ADR-005: Consistency and read-your-writes](adrs/ADR-005-consistency-read-your-writes.md)

---

## Example
See `examples/node-cqrs/` for a runnable demo:
- `command-service` writes orders and emits events
- `event-bus-mock` is a minimal event bus (HTTP publish + SSE subscribe)
- `projector` consumes events and updates a read model store
- `query-service` serves optimized read queries from the read model

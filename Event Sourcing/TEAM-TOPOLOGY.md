# Team Topology — Event Sourcing Pattern

## Who Owns the Event Store?

Event Sourcing introduces three distinct ownership concerns that must be explicitly assigned: the event store infrastructure, the event contracts (schemas), and the read model projections. Conflating these three is the most reliable way to create a team bottleneck.

This matters because Event Sourcing is not a CRUD database with audit logging bolted on. It is a fundamentally different persistence model that requires deep expertise in event schema governance, replay operations, projection lifecycle management, and aggregate invariant enforcement.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Event Store Platform Team** | Complicated-subsystem team | Event store infrastructure, durability guarantees, replay API, snapshot management, schema registry integration, monitoring |
| **Domain Teams (e.g., Accounts)** | Stream-aligned | Aggregate command handlers, event definitions (schemas), projection logic for their own read models |
| **Architecture / Governance** | Enabling team | Event contract standards, schema evolution policy, event naming conventions, cross-domain event consumption review |

The event store is not a simple platform service like object storage. It requires a **complicated-subsystem team** — not just platform engineers — because the operational properties (replay correctness, snapshot validity, projection ordering guarantees) require deep pattern expertise, not just infrastructure skills.

---

## Conway's Law Implications

**The aggregate boundary IS the team boundary.**

If two teams publish events to the same aggregate stream, you get conflicting invariant enforcement. Team A's command handler thinks the account balance invariant is enforced by validating against events it knows about. Team B publishes a `MoneyReserved` event the Team A handler does not model. The aggregate loads an incorrect state. You have a production correctness bug that is invisible until a reconciliation run.

The organizational corollary: every aggregate type must have exactly one owning team. That team owns the command handler, the event schemas for that aggregate, and the write path enforcement. Other teams may consume events from that aggregate as downstream read models. They may not write to it.

**What the org structure predicts about your event store:**

- **Multiple teams writing to the same aggregate stream** → Invariant violations, split-brain aggregate state, impossible-to-debug balance discrepancies.
- **Platform team owns projections for stream-aligned teams** → Platform team becomes a bottleneck for every new reporting requirement. Teams cannot evolve their read models independently.
- **No dedicated event store expertise** → Replay operations are ad-hoc, snapshot strategies are inconsistent, schema versioning is informal until a breaking change causes a production outage.

---

## Failure Mode: The "It's Just a Database" Trap

The most dangerous failure pattern with Event Sourcing: a stream-aligned team that owns the event store infrastructure begins treating it as a regular database. Engineers start querying the event log directly with SQL to build reports (bypassing projections). Other engineers start inserting correction rows with `INSERT` statements during incident response (bypassing the aggregate write path).

Once direct DB access to the event log becomes a habit, the event store's immutability guarantee is gone. The audit trail is corrupted. Replays produce different results depending on whether those manually inserted rows satisfy the schema validator.

**Signal to watch for:** Any SQL query against the raw events table that does not go through the replay API or the projection engine. This is the equivalent of directly reading the WAL in a traditional database — it bypasses every invariant the system was designed to enforce.

**Prevention:** Database-level permissions block all UPDATE, DELETE, and out-of-band INSERT access to the event log table. Only the command handler service account has INSERT access, and only via the append API, not raw SQL.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Event Store Platform → Domain Teams | **X-as-a-service** | Domain teams consume the event store append API, replay API, and schema registry without standing up infrastructure. No collaboration required for standard use. |
| Architecture Enabling → Domain Teams | **Enabling** | Architecture team reviews event schema proposals, enforces naming conventions, and approves breaking schema changes before merge. |
| Domain Teams → Event Store Platform | **Collaboration** | Required for non-standard needs: new aggregate types requiring custom partitioning, cross-aggregate transaction requirements, bulk replay for new projections. Time-box these engagements. |
| Domain Team → Domain Team | **X-as-a-service** | Downstream teams consume events from another domain's stream as a read-only feed (via the message broker). No direct event store access. |

---

## Aggregate Boundary = Team Boundary

This is the most important structural insight for Event Sourcing at scale. A useful test: if you cannot answer "which team has the authority to reject a command that would violate this aggregate's invariants?", your aggregate boundary is wrong.

The boundary must be enforced organizationally as well as technically:
- One team owns one or more aggregate types (never shared ownership of a single aggregate type)
- That team owns the event schema for those aggregates
- That team's CI pipeline owns the schema compatibility check before any event schema change merges

---

## Cognitive Load Considerations

Event Sourcing imposes high intrinsic cognitive load:
- Engineers must reason about state as a function of events, not as a single mutable row
- Debugging requires loading event streams, not just querying a table
- Schema evolution requires backward-compatible changes across potentially years of stored events
- Replay operations must be understood well enough to trigger safely without corrupting read models

Mitigations:
- Provide a local replay tool that developers can run against a seeded event stream to test projection changes without touching production
- Event viewer tooling that shows aggregate state at any point-in-time (reduces the "I need to mentally replay 3 years of events" cognitive load)
- Standardized event envelope (event_id, event_type, event_version, occurred_at, aggregate_id, aggregate_version) removes accidental complexity from schema decisions
- Runbook for every operational scenario (replay, snapshot rebuild, projection reset) means incident response does not require a specialist

---

## Scaling the Team Model

| Scale | Recommended Model |
|---|---|
| 1–2 teams | One team owns everything: event store, aggregates, projections. Treat the pattern as a discipline, not a platform. |
| 3–8 teams | Dedicated event store platform team. Domain teams own their aggregate domains and projections. Schema review is lightweight (PR review by architecture enabling team). |
| 8+ teams | Formal event contract review board. Schema registry is mandatory with automated compatibility checks. Dedicated replay infrastructure team. Cross-domain event consumption tracked as explicit dependencies. |

At 8+ teams, the event schema registry becomes a critical piece of governance infrastructure. Every event schema is versioned, documented, and change-controlled with the same rigor as an API contract. Breaking schema changes require a deprecation period, a migration path for existing projectors, and a coordinated rollout.

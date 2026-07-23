# Platform Engineering — Event Sourcing Pattern

## The Event Store as a Platform Capability

Event Sourcing is not just a design pattern that teams implement individually. At any organization with more than two teams using it, the event store must be a **platform-provided capability** — not something each team stands up independently.

The reason is not operational convenience. It is correctness. When teams stand up their own PostgreSQL append-only tables:
- They implement different idempotency semantics (some use `ON CONFLICT IGNORE`, others use application-level dedup)
- They implement different schema validation strategies (some validate on write, some on read)
- They implement different sequence numbering schemes (some use global sequences, some use per-aggregate sequences)
- They implement different replay APIs (usually no replay API — replay is a one-off script)

By the time these inconsistencies surface as a production incident, undoing them requires migrating each team's event store to a common model — an expensive and risky operation.

**The platform team's job is to make the correct thing the easy thing.**

---

## The Paved Road

A team that wants to adopt Event Sourcing should receive the following capabilities from the platform, without standing up any infrastructure themselves:

| Capability | Description | Self-Service? |
|---|---|---|
| **Managed event store** | Append-only event persistence with durability guarantees, without the team managing PostgreSQL or EventStoreDB | Yes — provision via API/IaC |
| **Standard event envelope** | `event_id`, `event_type`, `event_version`, `occurred_at`, `aggregate_id`, `aggregate_type`, `aggregate_version`, `correlation_id`, `causation_id` — enforced by the platform before storage | Automatic |
| **Schema registry integration** | Event schemas are registered with the schema registry before the first event of that type is stored. The platform validates every incoming event against its registered schema. | Self-service schema registration via PR |
| **Idempotent append API** | A `POST /events` endpoint that guarantees: (a) duplicate `event_id` is rejected with `409`, (b) optimistic concurrency check on `aggregate_version`, (c) atomic multi-event append per command | Yes — SDK provided |
| **Replay API** | `GET /streams/{aggregate_type}/{aggregate_id}/events?from_version=N` and `GET /streams/{aggregate_type}/events?from_position=N` — standard pagination, checkpoint support | Yes — available to all domain teams |
| **Projection monitoring** | Pre-built dashboards for projection lag, error rate, and consumer group health. Alerting on SLO breach. | Automatic |
| **Snapshot management** | Configurable snapshot frequency per aggregate type. Snapshot storage managed by platform. | Configurable per aggregate type |
| **Namespaced streams** | Each team's events are in a namespaced stream (`accounts.*`, `orders.*`). Teams cannot read or write streams outside their namespace without explicit cross-team access grants. | Automatic on registration |

---

## Self-Service Model

### Team Onboarding

A team that wants to adopt Event Sourcing for a new domain completes three steps:

1. **Register the aggregate domain** — Submit a PR to the platform config repo that declares:
   - Aggregate type name (`Account`)
   - Stream namespace (`accounts.*`)
   - Owning team
   - Retention policy (default: 7 years)
   - Snapshot frequency (default: every 100 events)

2. **Register event schemas** — Submit schemas to the schema registry for each event type. CI validates schema evolution rules (no required field removal, no type changes). Platform team reviews and approves via PR.

3. **Receive credentials** — Platform provisions a service account with `INSERT` access to the team's namespace in the event store. Connection string is delivered via secrets manager. The team's CI pipeline can now write events.

No tickets to the platform team. No manual provisioning. No event store configuration — the team owns their aggregate domain from day one.

### Cross-Domain Event Consumption

When Team B needs to consume events from Team A's aggregate stream (e.g., the Orders team needs `AccountOpened` events to create a customer record):

1. Team B opens a PR adding a read grant in the platform config: `accounts.* → orders-projector (read)`
2. Team A approves the PR (they own the stream)
3. Platform provisions read access for the `orders-projector` service account

This explicit grant model ensures:
- Teams know who is consuming their events (implicit dependency tracking)
- Schema changes to `accounts.*` trigger notifications to all registered consumers
- Access is revocable if the downstream team no longer needs it

---

## Platform Contract

The platform makes the following commitments to teams that use the managed event store:

| SLO | Target | Measurement |
|---|---|---|
| **Event durability** | 99.99% — an appended event that receives a `200 OK` will not be lost | Measured via integrity check job |
| **Write availability** | 99.9% — the append API is available 99.9% of the time | Measured at the append endpoint |
| **Replay API availability** | 99.9% — the replay API is available 99.9% of the time | Measured at the replay endpoint |
| **Schema validation** | 100% — no event that violates its registered schema is stored | Measured as schema validation bypass rate |
| **Write latency** | p99 < 100ms for single-event appends | Measured at API boundary |
| **Projection monitoring** | Projection lag alerts fire within 5 minutes of SLO breach | Measured as alert latency |

**What the platform does not commit to:**
- Read model correctness (teams own their projections)
- Projection catch-up time after an outage (teams own their projectors)
- The business meaning of events (teams own their schemas)

---

## Anti-Patterns That Signal Platform Failure

When you see these patterns in a team's codebase, it means the platform has not delivered sufficient value — and the team has worked around it:

### Anti-Pattern 1: Teams Writing Events Directly to Shared Tables

```sql
-- Found in team's application code:
INSERT INTO events (event_id, event_type, payload, occurred_at)
VALUES ($1, $2, $3, NOW())
```

A team that bypasses the platform append API is not getting: schema validation, idempotency enforcement, or sequence ordering guarantees. Their events are in the event store, but without platform guarantees. **Fix:** The platform append API must be demonstrably easier to use than direct SQL. Provide SDKs in all languages the organization uses. If the SDK does not exist in the team's language, building it is the platform team's job.

### Anti-Pattern 2: Teams Implementing Their Own Deduplication

```python
# Found in team's projector code:
if event_id in processed_event_cache:
    continue
processed_event_cache.add(event_id)
```

A team that implements their own idempotency mechanism is not using the platform's idempotent projection support. This means two projectors in the same team may use different dedup implementations. **Fix:** The platform's projection consumer library handles deduplication transparently. Teams should not write dedup logic.

### Anti-Pattern 3: Parallel State Stores Alongside Events

```python
# Found in team's data model:
# events table (append-only) + accounts table (mutable current state)
UPDATE accounts SET balance = $1 WHERE account_id = $2
```

A team that maintains a mutable current-state table alongside their event store has defeated the Event Sourcing pattern. They have two sources of truth that will diverge. **Fix:** The platform must provide a snapshot API that eliminates the perceived need for a parallel mutable table. If teams are adding parallel state stores because rehydration is too slow, the snapshot strategy is wrong — not the architecture.

### Anti-Pattern 4: Schema Changes Without Registry Update

A team deploys a new event type or adds a required field to an existing event schema without updating the schema registry. Downstream projectors begin receiving events they cannot parse. **Fix:** The platform's append endpoint rejects events for unregistered schemas. Schema registration must be a required step in the team's deployment pipeline. CI lint should catch unregistered schemas before deployment.

---

## Developer Experience Requirements

The platform team's primary product is developer experience. A managed event store that is harder to use than a raw PostgreSQL table will not be adopted.

Minimum DX requirements:

| Requirement | Implementation |
|---|---|
| Local development support | Docker Compose image of the platform event store that runs locally, seeded with example events |
| SDK in all org languages | Python, Go, Node.js, Java SDKs with typed event envelope, idempotent append, and streaming consumer |
| Local replay tool | CLI tool: `platform-es replay --aggregate-type Account --aggregate-id acc-123 --to-version 45` |
| Event viewer | Web UI or CLI that shows event streams for a given aggregate, with formatted payload and version history |
| Schema linting in CI | CI action that validates event schema changes against compatibility rules (no breaking changes) |
| Projection scaffolding | `platform-es init-projector` generates boilerplate for a new projection consumer with checkpoint handling and error retry |

If any of these are missing, teams will build workarounds that become the next generation of anti-patterns.

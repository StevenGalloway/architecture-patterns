# Team Topology — CQRS Read Model Projection

## Who Owns the Projector?

CQRS introduces a structural ownership problem that does not exist in a single-database architecture: the command side, the projector, and the read models are each owned by potentially different teams, and the projector sits exactly at the boundary between them.

This is not a technical problem. It is an organizational one. The projector consumes domain events published by the command-side team and produces read models consumed by the query-side teams. It is the coupling point between them, and whoever owns it inherits dependencies from both directions.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Orders Domain Team** | Stream-aligned | Command handler, write-side PostgreSQL schema, domain event definitions and publishing |
| **Customer Experience Team** | Stream-aligned | Customer order history query service, owns the history read model schema |
| **Fulfillment Operations Team** | Stream-aligned | Merchant fulfillment dashboard query service, owns the Redis read model schema |
| **Business Intelligence Team** | Stream-aligned | Analytics query surface, owns the column-store read model schema |
| **Platform Engineering** | Platform team | Event bus infrastructure, projector framework, schema registry, replay tooling, read model store provisioning |

The projection logic for each read model is the consumer team's concern — they define what fields they need and how to compute them. The infrastructure that runs projectors, guarantees delivery, and enables replay is a platform team concern.

---

## Three Ownership Models and Their Trade-offs

### Model 1: Command-Side Team Owns All Projectors

The Orders domain team owns and operates the projector that builds all three read models.

**Rationale:** The domain team knows the event schema best and can ensure projector logic remains consistent with the write model.

**Failure mode:** The analytics team needs a new field in the analytics read model. They file a ticket with the Orders team. The Orders team has no context on the analytics use case, must understand the BI team's requirements, and must schedule the change among competing priorities for the write-side backlog. A change that takes the BI team one afternoon to specify takes the Orders team two sprints to deliver.

**At 1–2 read models:** acceptable. **At 3+ read models with different business owners:** this model creates a permanent bottleneck. Each consumer team has zero autonomy over the data shape they need.

### Model 2: Each Consumer Team Owns Their Own Projector

Each team that consumes a read model owns the projector that builds it. The Customer Experience team runs a projector that subscribes to order events and maintains the customer history DB. The Fulfillment team runs theirs. The BI team runs theirs.

**Rationale:** Consumer teams are experts in their own data needs. They iterate on their read models without cross-team coordination.

**Failure mode:** Three projectors subscribe to the same event stream. When the Orders team changes the `OrderStatusUpdated` event schema, three teams must update their projectors. The change is coordinated using the schema registry (see ADR-002), but the operational burden of three separate projector services — three deployment pipelines, three on-call rotations, three instances of replay tooling — grows with each new consumer.

**At 2–3 read models with different owners:** correct model. **At 8+ read models:** operational complexity requires standardization, which pulls you toward Model 3.

### Model 3: Platform Team Owns Projector Infrastructure; Consumer Teams Own Projection Logic (Recommended at Scale)

The platform team provides a projector framework — a runtime that handles event bus connectivity, offset management, idempotency, retry, lag monitoring, and replay orchestration. Consumer teams write projection functions (pure transformations from event payload to read model update) and declare what store type they need. The platform runs those functions.

**Rationale:** The operational complexity of running projectors is common across all consumer teams. The business logic of what to project is unique to each consumer. Separate these two concerns.

**Consumer team experience:**

```yaml
# fulfillment-team/projector-config.yaml
projection:
  name: fulfillment-dashboard-v2
  event_types:
    - OrderCreated
    - OrderStatusUpdated
    - OrderCancelled
  store:
    type: redis
    instance: fulfillment-cache-prod
  handler: ./handlers/fulfillment-projection.ts
  idempotency_key: "event_id"
  lag_alert_threshold_seconds: 5
```

The platform team owns everything except `handler` and the schema of the read model store. The consumer team owns those.

---

## Conway's Law Implications

The read model schema is a mirror of your consumer team's mental model, not the write-side schema. This is the point of CQRS. If the fulfillment team needs a `open_order_count_by_sku_and_warehouse` field, they can have it — without touching the write-side normalized schema that the Orders team owns.

What Conway's Law predicts:
- **If the projector is owned by the command-side team**, the read models will look like the write-side schema with minor variations. Consumers will find the data shape awkward for their use cases and build transformations on top of it.
- **If each consumer team owns their own projector**, the read models will be exactly what each consumer needs. The event schema becomes the contract between the command side and all consumers.
- **If the platform team owns projector infrastructure**, event schema stability becomes a platform concern. The platform team has a strong incentive to maintain a schema registry and enforce backward-compatible event evolution.

---

## The Interlock Failure Mode

The most common organizational failure in CQRS at scale: the analytics team needs a new computed field in the analytics read model. The field requires a new piece of data in the `OrderCreated` event that the Orders team doesn't currently publish. The chain of dependency becomes:

1. Analytics team specs the field
2. BI team files a request to the Orders team to add the field to the event payload
3. Orders team adds the field to the event schema, publishes a new schema version to the schema registry
4. Analytics team updates their projector to consume the new field
5. Analytics team replays the event stream to backfill historical data with the new field

Steps 3 and 4 require coordination between two teams. If the Orders team is on a different sprint cadence, this takes 3–6 weeks. The fix: establish event schema change process upfront. The Orders team publishes events with rich payloads by default (include data they may not yet know consumers need). The schema registry makes backward compatibility a CI check, not a negotiation.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform team → consumer teams | **X-as-a-service** | Consumer teams declare projection config; platform runs it. No direct collaboration required for standard use cases. |
| Orders team → all consumer teams | **X-as-a-service** | Orders team publishes domain events as a service. Consumer teams subscribe without coordination. Event schema is the API contract. |
| Consumer team → Orders team | **Collaboration (bounded)** | Required only when the consumer needs new data in the event payload that the Orders team does not currently publish. Time-boxed; resolved via schema registry PR. |
| Platform team → Orders team | **Enabling** | Platform team enforces event schema standards, backward compatibility rules, and event bus configuration. |
| Security → platform team | **Enabling** | Security sets standards for event signing, read model access controls, and audit logging. Platform implements. |

---

## Cognitive Load on the Command-Side Team

In a single-database architecture, the Orders team owns one schema and one set of indexes. In CQRS, the Orders team publishes events that are consumed by projectors they may not own. They must now reason about:

- Which fields are part of the public event contract (cannot be removed without versioning)
- Which events downstream projectors depend on
- Schema backward compatibility requirements (are consumer projectors running older event schema versions?)

This is a real increase in cognitive load. Mitigations:
- Schema registry with automated backward-compatibility checks on every event schema PR
- Consumer declarations in the registry: "fulfillment-projector depends on OrderStatusUpdated v2.x"
- Platform team owns the registry and the compatibility tooling; Orders team only writes events

---

## Scaling the Ownership Model

| Read models | Teams | Recommended structure |
|---|---|---|
| 1–2 | 1 domain team, 1–2 consumers | Domain team owns all projectors. Low overhead. |
| 3–5 | 1 domain team, 3–5 consumers | Consumer teams own their projectors. Schema registry required. |
| 5–10 | Multiple domain teams, 5+ consumers | Platform team provides projector framework. Consumer teams own projection logic. Event mesh emerges. |
| 10+ | Multiple domain teams, 10+ consumers | Dedicated Data Platform team. Projection framework is a product. Consumer self-service is a hard requirement. |

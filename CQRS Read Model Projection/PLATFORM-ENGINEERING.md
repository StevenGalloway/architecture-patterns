# Platform Engineering — CQRS Read Model Projection

## CQRS Infrastructure as a Platform Capability

When a second team asks to add a read model to the orders event stream, the platform question surfaces immediately: do they have to rebuild projection infrastructure from scratch, or does the platform provide it?

At one read model owned by one team, CQRS is a design pattern. At three read models owned by three different teams, CQRS is infrastructure. Infrastructure needs a platform team.

The platform provides what is common across all read models: event bus connectivity, offset management, idempotency, retry, lag monitoring, replay orchestration, and read model store provisioning. Consumer teams provide what is unique to their use case: the projection function (how to transform an event into a read model update) and the read model schema.

This separation is the difference between a CQRS implementation that scales to 10 read models with 5 teams and one that collapses under its own coordination overhead at 4.

---

## Platform Capabilities

### 1. Event Bus Infrastructure

The platform team owns and operates the event bus. Consumer teams consume from it; the command-side team publishes to it. Neither writes bus configuration.

**Platform provides:**
- Topic provisioning with appropriate partition count and replication factor
- Retention policy configuration (default: 30 days, sufficient for replay)
- Dead-letter topic per consumer group, automatically created
- Consumer group quota enforcement (max lag before platform alert)
- Schema registry (Confluent Schema Registry or AWS Glue Schema Registry) with backward-compatibility enforcement

**Consumer teams provide:**
- Consumer group name (namespaced: `team-name.projector-name.v1`)
- Declaration of which event types the projector needs
- Schema compatibility acknowledgment on each event schema version upgrade

### 2. Projector Framework

The projector framework is the platform's most valuable contribution. It is a runtime that handles the operational concerns of consuming events and writing to read model stores, so consumer teams write only the transformation logic.

**What the framework handles:**

| Concern | Framework behavior |
|---|---|
| Event consumption | Manages Kafka/SQS consumer, offset commits, consumer group rebalancing |
| Idempotency | Checks idempotency store before calling projection function; skips duplicate events |
| Retry | Exponential backoff on transient write failures; routes to DLQ after configured max retries |
| Lag monitoring | Emits `projector.lag_ms` metric per consumer group; triggers alert if lag exceeds threshold |
| Schema deserialization | Deserializes events using schema registry; routes schema-mismatch events to DLQ with error code |
| Checkpoint management | Commits consumer offsets only after successful read model write and idempotency record |
| Graceful shutdown | On SIGTERM, finishes in-flight event batch and commits offsets before exiting |

**What the consumer team writes:**

```typescript
// fulfillment-team/projector/handlers.ts

export const projectionHandlers: ProjectionHandlers = {
  OrderCreated: async (event: OrderCreated, store: ReadModelStore) => {
    const key = `fulfillment:sku:${event.payload.sku_id}:open_orders`;
    await store.increment(key, 1);
    await store.setExpiry(key, 86400); // 24h TTL
  },

  OrderStatusUpdated: async (event: OrderStatusUpdated, store: ReadModelStore) => {
    if (event.payload.new_status === 'FULFILLED') {
      const key = `fulfillment:sku:${event.payload.sku_id}:open_orders`;
      await store.decrement(key, 1);
    }
  },

  OrderCancelled: async (event: OrderCancelled, store: ReadModelStore) => {
    const key = `fulfillment:sku:${event.payload.sku_id}:open_orders`;
    await store.decrement(key, 1);
  },
};
```

The consumer team has no Kafka consumer code, no idempotency logic, no retry logic, and no metric emission. The framework handles all of it.

### 3. Read Model Store Provisioning

Consumer teams select a store type from a catalog. The platform provisions the instance, credentials, and network access.

```yaml
# fulfillment-team/read-model.yaml
read_model:
  name: fulfillment-dashboard
  version: v2
  store_type: redis
  size: medium           # platform-defined: small/medium/large maps to cache size
  access:
    - service: fulfillment-query-service
      permission: read
    - service: fulfillment-projector
      permission: write
  ttl_default_seconds: 86400
  alert_memory_threshold_pct: 80
```

The platform team provisions the ElastiCache instance, creates the Redis ACL credentials, places them in Secrets Manager, and delivers the secret ARN to the consumer team. The consumer team's projector and query service reference the secret ARN in their deployment config. No direct credential management by the consumer team.

Catalog of store types:

| Type | Backed by | Best for |
|---|---|---|
| `redis` | ElastiCache | Real-time counts, key-value lookup, low latency (<1ms) |
| `postgres-row` | Aurora PostgreSQL | Paginated list queries, sort/filter, joins |
| `postgres-column` | Redshift or Aurora + Parquet | Aggregate queries, analytics, GROUP BY |
| `document` | DynamoDB | Sparse schemas, high-volume key lookup, per-item TTL |
| `search` | OpenSearch | Full-text search, faceted filtering |

### 4. Replay Tooling

Replay is a platform operation. Consumer teams request a replay; the platform executes it.

Consumer team interface:

```bash
# Request a replay for the fulfillment projector
platform replay request \
  --projector fulfillment-dashboard-v2 \
  --from-timestamp 2026-01-01T00:00:00Z \
  --to-timestamp 2026-03-01T00:00:00Z \
  --target shadow   # writes to shadow store; live store unaffected until cutover

# Check replay status
platform replay status --projector fulfillment-dashboard-v2

# Cutover to rebuilt read model (requires second approval)
platform replay cutover --projector fulfillment-dashboard-v2 --approve
```

The platform team owns the replay controller service. They do not approve replay requests (that is the consumer team's business decision) but they maintain the tooling, monitor replay progress, and respond if a replay causes write storms on the read model store.

Replay safety: the replay controller rate-limits event delivery to the projector during catch-up (configurable: default 10,000 events/second). This prevents a replay from overwhelming the read model store while live projection continues on a separate consumer group.

### 5. Schema Registry

The schema registry is owned by the platform team. The command-side team registers event schemas. Consumer teams declare compatibility requirements.

**Platform enforces:**
- All events published to `orders.events` must be registered in the schema registry
- New schema versions must be backward-compatible by default (BACKWARD compatibility mode)
- Schema changes that break backward compatibility require a major version bump and a migration plan
- CI check on the command-side repository: "does this event schema change break any registered consumer?"

**Command-side team workflow:**

```bash
# Register new event schema version
schema-registry register \
  --topic orders.events \
  --type OrderCreated \
  --version v2.1 \
  --schema ./schemas/order-created-v2.1.json \
  --compatibility BACKWARD

# Check: does this change break any consumer?
schema-registry check-consumers \
  --topic orders.events \
  --type OrderCreated \
  --proposed-version v2.1
# Output: fulfillment-projector-v2 declares BACKWARD compatible — OK
#         analytics-projector-v1 declares FULL compatible — BREAKING (missing field x)
```

The schema registry check runs in CI on every event schema change. A breaking change fails CI until the consumer teams have acknowledged it and updated their projector to handle both versions.

---

## Self-Service: Adding a New Read Model Without the Command Team

The platform's operational goal: a consumer team should be able to add a new read model from the orders event stream, deploy a projector, and have it serving queries in production — without any involvement from the Orders domain team.

**Steps under the platform model:**

1. Consumer team reads the event schema from the schema registry. No ticket to the Orders team.
2. Consumer team declares a read model in their team's `read-model.yaml`. Platform provisions the store.
3. Consumer team writes projection handlers using the projector framework SDK.
4. Consumer team deploys the projector (their own CI/CD pipeline; the platform framework is a library dependency).
5. Consumer team requests replay for initial backfill (platform executes on approval).
6. Consumer team deploys their query service reading from the new read model.

The Orders team is not in this workflow. The event stream and schema registry are self-service. This is the correct model.

**When the Orders team must be involved:** only when the consumer team needs new data in the event payload that is not currently published. This requires a schema change on the command side. The schema registry PR process is the coordination mechanism, not a support ticket queue.

---

## Platform Contract

The platform team publishes and maintains the following contract:

### What the platform guarantees

| Capability | Commitment |
|---|---|
| Event bus availability | 99.9% monthly uptime; events are durably stored for 30 days |
| Event delivery | At-least-once delivery to all registered consumer groups |
| Schema registry availability | 99.9% monthly uptime; schema registry unavailability does not block event consumption (schemas are cached by the projector framework) |
| Projector framework correctness | Idempotency guarantees hold under single-region failure; replay produces read model equivalent to live projection |
| Store provisioning SLA | New read model store provisioned within 1 business day of approved `read-model.yaml` PR |
| Breaking change notice | 30 days notice for any change to projector framework API or projector config schema |

### What consumer teams are responsible for

| Responsibility | Owner |
|---|---|
| Projection function correctness | Consumer team |
| Read model schema design | Consumer team |
| Query service availability | Consumer team |
| Declaring event schema compatibility requirements | Consumer team |
| Requesting replay when read model is inconsistent | Consumer team |
| DLQ review and replay decisions | Consumer team |

---

## Signals That CQRS Has Become a Platform Anti-Pattern

| Signal | Root cause | Fix |
|---|---|---|
| Consumer teams cannot add a new read model without filing a ticket to the command-side team | No self-service: event schemas are undocumented, schema registry is missing, or projector framework is not available as a library | Build schema registry; publish projector framework as an internal SDK |
| Projection lag is consistently >30 seconds and nobody acts on it | Lag monitoring exists but no team owns the SLO; or the projector is undersized | Assign clear lag SLO ownership to the consumer team; right-size projector compute; add lag-based autoscaling |
| Replay has never been tested in production | Replay tooling exists but is considered too risky to run | Run a replay drill against a staging environment quarterly; run the first production replay against a non-critical read model to build confidence |
| Consumer teams run their own event polling loops against the write-side database | Projector framework is too complex to use, or the event bus is not available for direct subscription | Simplify the projector framework developer experience; validate self-service path end-to-end |
| Schema changes on the command side break projectors in production | No schema compatibility enforcement in CI | Add schema registry backward-compatibility check to command-side CI pipeline; enforce before merge |
| Three teams manage three separate Kafka consumer configurations with three different idempotency implementations | Projector framework was not adopted; each team reimplemented the wheel | Migrate teams to the shared projector framework; retire bespoke consumer code |

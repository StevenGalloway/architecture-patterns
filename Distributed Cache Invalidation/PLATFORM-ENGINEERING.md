# Platform Engineering — Distributed Cache Invalidation

## Cache Invalidation as a Platform Capability

Teams should not need to implement NATS subscriptions, key eviction logic, L1/L2 coordination, or consumer lag monitoring. Each team reimplementing these primitives independently produces:

- Inconsistent key naming that breaks cross-service invalidation
- NATS consumer groups that duplicate events rather than sharing them
- L1 caches that evict keys on a different schedule than L2, creating inter-layer inconsistency
- No consumer lag visibility, so invalidation failures are invisible

The platform provides a **cache client library** that handles all of this. Teams call `cache.get()` and `cache.set()`. The platform handles subscribe, evict, reconnect, metrics emission, and TTL safety nets automatically.

---

## Paved Road Model

| Without platform (every team builds their own) | With platform (paved road) |
|---|---|
| Each team writes its own NATS subscriber | Platform library subscribes automatically on startup |
| Each team implements their own L1 eviction on invalidation event | Platform library evicts L1 and L2 on every received invalidation event |
| Each team invents its own key format (`product-123`, `item_456`, `prod:item:789`) | Key format is enforced by the library at key registration time |
| No coordination between teams on NATS consumer group names → duplicate event processing | Platform library registers the correct consumer group name based on service identity |
| Consumer lag is invisible unless each team independently builds alerting | Platform library emits `invalidation.consumer.lag` per instance to the observability platform |
| A rolling deploy causes a gap in NATS subscription; invalidation events are missed | Platform library uses JetStream durable consumers; events are replayed after reconnect |
| Testing invalidation behavior requires a running NATS instance | Platform library provides a test helper for asserting invalidation events in unit tests |

The paved road must be faster and easier than building your own. If teams can get a working cache by writing 10 lines of library code, they will. If they have to file a platform ticket to register a subscription, they won't.

---

## Self-Service via Declarative Config

Teams declare their cache namespace, invalidation triggers, and TTL policy in a `cache-config.yaml` in their service repository. The platform library reads this config at startup and wires up all NATS subscriptions automatically. Teams never write pub/sub code.

```yaml
# cache-config.yaml
namespace: product-catalog
tenant_aware: true

invalidation:
  subscribe_topic: catalog.product.updated
  key_pattern: "product:{entity_id}"

l1:
  max_entries: 10000
  ttl_seconds: 60

l2:
  ttl_seconds: 300
```

**What the library does with this config:**
1. Validates the namespace is registered in the platform key schema registry
2. Registers a durable JetStream consumer on `catalog.product.updated`
3. On each received event, extracts `entity_id` from the event payload and constructs the full key: `{env}:{tenant_id}:v2:product:{entity_id}`
4. Evicts the key from L1 (in-process LRU map)
5. Issues a DEL command to Redis L2
6. Emits `invalidation.keys.evicted` metric with `namespace=product-catalog` label
7. Acknowledges the NATS message after eviction completes (not before — ensures at-least-once eviction)

**What teams never write:** NATS connection management, consumer group registration, L1 eviction logic, Redis DEL, metric emission, reconnect handling, deserialization error handling.

---

## Platform Contract

### What the platform provides

| Capability | Guarantee |
|---|---|
| Invalidation event delivery latency | p99 < 100ms from event publish to consumer eviction under normal NATS conditions |
| Consumer lag monitoring and alerting | Platform monitors lag per consumer group; pages on-call when lag > 5,000 events |
| Cache library compatibility | Node.js, Python, Go, Java; same interface, same behavior |
| Redis cluster availability | 99.9% monthly uptime SLA |
| NATS cluster availability | 99.9% monthly uptime SLA |
| JetStream replay | Up to 24-hour message retention for consumer reconnect replay |
| Key schema registry | Platform team reviews and approves all namespace registrations; prevents collision |
| Breaking change notice | Minimum 30 days notice for any breaking change to cache-config.yaml schema |

### What service teams are responsible for

| Responsibility | Owner |
|---|---|
| Correct key design within their namespace | Stream-aligned team |
| Publishing invalidation events on every data write | Write service team |
| Not bypassing the platform library to write directly to Redis | All teams |
| Declaring cache-config.yaml accurately (namespace, TTL, invalidation trigger) | Stream-aligned team |
| Calling `cache.invalidate(keys)` synchronously in the write path (not async) | Write service team |

The most common team failure mode is publishing invalidation events asynchronously after the write response has been returned to the client. This creates a race condition: a client that immediately reads after writing may hit a cache entry that hasn't been invalidated yet. Invalidation event publication must happen before the write response is returned (see ADR-003).

---

## Developer Experience

### Local Development

Local development requires a local NATS and Redis. The platform provides a `docker-compose` fragment that teams include in their `docker-compose.yml`:

```yaml
# Provided by platform — include in your service's docker-compose.yml
services:
  nats:
    image: nats:2.10-alpine
    command: ["--js"]
    ports: ["4222:4222"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

The platform library automatically detects local mode (when NATS is not available or `PLATFORM_ENV=local`) and runs in **TTL-only mode**: cache.get() and cache.set() work normally against Redis, but invalidation subscriptions are not established. This gives teams a working local cache without requiring a full NATS setup for basic development.

When a team needs to test invalidation behavior locally, they run with NATS included and use the platform's test publisher:

```bash
# Publish a test invalidation event from the CLI
platform-tools cache publish-invalidation --topic catalog.product.updated --entity-id 456
```

### Unit Testing Invalidation

The platform library's test helper exposes an in-memory event bus for asserting invalidation behavior without a running NATS instance:

```typescript
import { CacheTestHelper } from '@platform/cache/testing';

it('publishes invalidation event on product update', async () => {
  const helper = new CacheTestHelper();
  await updateProduct({ id: '456', price: 79.99 });
  helper.assertEventPublished('catalog.product.updated', { entity_id: '456' });
});
```

This makes invalidation event publication a testable assertion in unit tests, not just an integration test concern.

---

## Anti-Patterns

**1. Publishing invalidation events without a corresponding subscription**

A write service publishes `catalog.product.updated` events, but the cache consumer team hasn't registered a subscription yet (their `cache-config.yaml` references a different topic name). Events are published and delivered by NATS, but no consumer receives them. Stale data persists indefinitely.

Prevention: the platform key schema registry requires every registered invalidation topic to have at least one active consumer group. The platform alerts when a topic has zero active consumers for more than 5 minutes.

**2. Multiple teams owning the same NATS topic**

Team A publishes `catalog.product.updated`. Team B also publishes to `catalog.product.updated` (for a different write path on the same entity type). Team C consumes from `catalog.product.updated`. Team C receives events from both publishers, but the event schema is slightly different between Team A and Team B. Deserialization fails intermittently.

Prevention: each NATS topic has a single registered publisher, enforced by the platform's event schema registry. Multiple write services that update the same entity type must coordinate through a single canonical event format, or use separate topics and share a consumer-side fan-in configuration.

**3. Using invalidation as a data sync mechanism**

A write service publishes invalidation events that contain the new value alongside the key:
```json
{ "key": "product:456", "new_value": { "price": 79.99, "name": "Widget" } }
```
This couples the producer's data schema to every consumer. When the producer adds a new field to the product schema, all consumers must update simultaneously. The event bus becomes a hidden data contract between services.

Invalidation events must contain only keys. Consumers fetch fresh data from their own source on cache miss. This is the evict-on-write policy (ADR-003) and it is enforced by the platform library — the `publishInvalidation()` method only accepts key arrays, not values.

**4. No TTL safety net**

A team configures `l1.ttl_seconds: 0` and `l2.ttl_seconds: 0` because they trust invalidation events completely and want maximum cache persistence. A NATS partition lasts 3 minutes — during those 3 minutes, no invalidation events are delivered. After the partition heals, JetStream replays the missed events. But during the 3-minute window, stale data is served with no bound on how stale it can get.

TTL is not optional. ADR-004 documents the minimum TTL requirements: L1 maximum 60 seconds, L2 maximum 5 minutes. These are safety nets, not the primary freshness mechanism. The platform library enforces minimum TTLs and will not register a cache namespace with TTL disabled.

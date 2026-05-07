# ADR-001: Use Pub/Sub for distributed cache invalidation

## Status
Accepted

## Date
2025-05-28

## Context
The Product API runs as 8 horizontally scaled instances. Each instance maintains a local in-process cache (L1) to avoid Redis round-trips for the most frequently accessed product data, and all instances share a Redis cache (L2) as a second tier. L1 holds up to 10,000 entries with a 60-second TTL; L2 holds up to 500,000 entries with a 5-minute TTL.

For most product data, eventual consistency over a 60-second window is acceptable. But for two categories, the staleness window is unacceptable:

**Pricing updates:** Promotional prices can activate on a schedule (e.g., a flash sale begins at 12:00:00). If a price change activates but 7 of the 8 API instances continue serving the pre-promotion price from their local caches for up to 60 seconds, customers routed to those instances see the wrong price while customers routed to the one instance that had a cache miss see the correct promotional price. This creates price inconsistency within the same second.

**Product status updates:** When a product is marked out-of-stock or discontinued, it must not be shown as available to any user. An L1 cache TTL of 60 seconds means the product could be advertised as in-stock for up to a minute after the status change, leading to cart additions that fail at checkout.

Direct cache invalidation (having the write path call each instance's API to evict the key) was considered but rejected: it requires the write service to know the address of every running API instance, which is incompatible with auto-scaling and instance replacement. A pub/sub approach where instances subscribe and self-evict on receiving an invalidation event is more resilient to topology changes.

## Decision
Use NATS JetStream as the pub/sub system for cache invalidation events. When a product's price, status, or any correctness-sensitive field is updated in the database, the write service publishes an invalidation event to the `cache.invalidation` subject. The event payload contains the affected cache keys (not the new values; keys only).

All API instances subscribe to the `cache.invalidation` subject and, on receiving an event, evict the specified keys from their local L1 cache and delete them from the L2 Redis cache. Subsequent reads populate the cache from the origin database.

NATS JetStream provides durable delivery: subscribers that are temporarily offline will receive missed invalidation events when they reconnect, preventing a restarted instance from serving stale data from its repopulated L1 cache.

## Alternatives Considered

**Redis Pub/Sub for invalidation broadcasts:** Use Redis's native pub/sub channel (`PUBLISH`/`SUBSCRIBE`) to broadcast invalidation events. Available without additional infrastructure since Redis is already deployed. Rejected because Redis Pub/Sub does not persist messages: subscribers that are offline (due to restart or network partition) miss messages published during their absence. A restarted API instance would repopulate its L1 cache from Redis without knowing which keys had been invalidated during the restart, and Redis pub/sub would not replay the missed invalidations.

**TTL-only invalidation (no explicit invalidation events):** Rely solely on short TTLs (10-15 seconds for price data) without explicit invalidation events. Zero additional infrastructure required. Rejected because 10-15 second TTLs generate 6-9x more cache misses than the current 60-second TTLs, which would increase Redis query volume by 400-600% and origin database queries by a similar factor. The infrastructure cost of TTL-only invalidation at this traffic volume exceeds the cost of the pub/sub infrastructure.

**Write-through cache (update cache on write, not just the origin):** When pricing or status is updated, write the new value to the cache simultaneously with the database. All instances would immediately have the new value without needing to invalidate and reload. Rejected because write-through requires the write service to know the exact cache key structure for every entity it updates, coupling the write path to the cache layer. It also does not address L1 cache entries in each instance's in-process memory.

## Consequences

### Positive
- Pricing and status changes propagate to all instances' L1 and L2 caches within the NATS message delivery latency (measured at under 20ms under normal conditions)
- Durable delivery ensures that restarted instances receive all invalidation events missed during their downtime before they begin serving traffic
- Write services do not need to know the number or addresses of API instances; they publish to a topic and all current and future subscribers receive the event

### Negative
- NATS JetStream is a new infrastructure dependency; it requires deployment, monitoring, and operational expertise alongside Redis
- An invalidation event that names 50 keys to evict (for a bulk product update) generates 50 × 8 cache deletions (L1 + L2 per instance), which may cause a brief cache miss spike for high-traffic products

### Risks
- **NATS outage causes invalidation gap.** If NATS JetStream is unavailable, invalidation events are not delivered. API instances continue serving data from their caches without knowing that updates have occurred. The TTL safety net (ADR-004) bounds the maximum staleness, but price or status updates made during a NATS outage will be stale for up to the TTL window. Mitigation: NATS JetStream availability is monitored with a page-level alert; the write path logs a warning when invalidation events cannot be published.

## Review Trigger
Revisit if the team deploys a service mesh with native cache invalidation support, or if NATS JetStream proves operationally expensive relative to its benefit compared to a Redis Streams approach that uses the existing Redis infrastructure.

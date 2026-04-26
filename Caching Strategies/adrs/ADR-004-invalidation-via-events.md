# ADR-004: Use event-driven invalidation for correctness-sensitive data

## Status
Accepted

## Date
2025-10-29

## Context
TTL-based cache expiry works well for data where bounded staleness is acceptable. Product descriptions, category hierarchies, and user preference settings can be 60-300 seconds stale without causing incorrect behavior. However, two data types in the catalog system have stricter correctness requirements:

**Pricing data:** The pricing team runs promotions that can activate or deactivate on minute-level boundaries. A promotional price that should activate at 12:00:00 being served stale until 12:01:00 causes customers to see the non-promotional price and potentially abandon checkout. More critically, a price correction (fixing an incorrectly entered price) must propagate within seconds, not minutes, for compliance and trust reasons.

**Inventory availability:** Showing a product as "in stock" when it sold out 90 seconds ago causes customers to add items to cart, proceed through checkout, and receive a failure at order submission. Each such failure has a measurable impact on cart abandonment rates and customer satisfaction.

For both of these data types, TTL-only caching with a 30-60 second window was producing a user-visible quality problem. The fix was to add proactive cache invalidation triggered by the data-change events that already existed in the system.

## Decision
Pricing and inventory data use **event-driven cache invalidation** in addition to TTL expiry. When either data type changes, the responsible service publishes a domain event, and the caching layer subscribes to those events to invalidate affected cache keys immediately.

Event subscription is implemented as follows:
- The Pricing service publishes `PriceUpdated` events to the `pricing.changes` topic on the internal event bus when a price is created, updated, activated, or deactivated
- The Inventory service publishes `InventoryUpdated` events to the `inventory.changes` topic when stock levels change materially (>5 unit delta to avoid constant invalidation from minor adjustments)
- The Catalog caching service subscribes to both topics and invalidates the relevant cache keys on receipt

For services where publishing via a direct event bus is unreliable (the event could be lost if the service crashes after the write but before the publish), the Transactional Outbox pattern is used to ensure the event is published atomically with the underlying data write.

## Alternatives Considered

**Write-through cache on data updates:** When the Pricing service writes a new price, it simultaneously writes the new value to the cache. Rejected because write-through requires the Pricing service to know the cache key structure and have a direct dependency on the cache layer. Cross-service coupling for cache population violates the service ownership model; the Catalog service owns the cache for catalog data.

**Ultra-short TTLs (5-10 seconds) instead of invalidation:** Use very short TTLs for pricing and inventory to limit staleness without event-driven invalidation. Rejected because 5-second TTLs for inventory at 1,200 requests/second would generate 240 origin queries per second per product, eliminating the cache benefit entirely for popular products. The origin would experience higher load than without caching.

**Client-initiated invalidation (stale-if-error + manual refresh endpoint):** Expose a cache invalidation API endpoint that the Pricing service calls directly after each write. Simpler than event bus integration but rejected because the HTTP call from Pricing service to the invalidation endpoint fails silently if the endpoint is unavailable or the Pricing service crashes between the write and the invalidation call. The Transactional Outbox approach ensures the event is persisted with the write and will eventually be delivered even if the service crashes.

## Consequences

### Positive
- Pricing and inventory cache staleness reduced from up to 60 seconds to under 2 seconds (event bus propagation latency)
- Price corrections propagate to the cache within the event delivery window, meeting compliance requirements for price correction timeliness
- Cart abandonment rate from out-of-stock errors reduced by approximately 40% in the month after event-driven inventory invalidation was deployed

### Negative
- Requires event bus infrastructure and reliable event publication (Transactional Outbox) as a hard dependency for correctness-sensitive data
- Idempotent invalidation handlers are required: if an `InventoryUpdated` event is delivered twice (at-least-once delivery semantics), the second invalidation must not cause errors

### Risks
- **Invalidation event loss.** If an event is lost before the invalidation handler processes it, the cache will serve stale data until the TTL expires. Mitigation: the TTL acts as a safety net -- even without event-driven invalidation, the price data will expire within 60 seconds. Monitoring tracks the gap between known data writes and cache invalidation events.

## Review Trigger
Revisit if the event bus is replaced with a different infrastructure (e.g., CDC from the database directly), which may allow invalidation to be triggered from the database write-ahead log rather than application-level events.

# ADR-004: Use TTLs and versioned keys as safety nets

## Status
Accepted

## Date
2025-11-26

## Context
The pub/sub invalidation approach (ADR-001) provides fast cache eviction when it works correctly. But pub/sub systems have failure modes: NATS may be temporarily unavailable, the write service may fail to publish an event after a database write, or an API instance may miss events during a brief network partition and not receive the replay because the JetStream consumer was not properly configured.

In each of these failure cases, the cache would serve stale data indefinitely -- there would be no mechanism to bound the staleness window. A promotional price change published to NATS during a 30-second NATS hiccup would not be reflected in the cache until the next cache invalidation event for that key, which might not come until the product's price changes again.

Additionally, schema changes in the product API response structure needed a mechanism to ensure that old cached responses (with the previous schema) were not served alongside new responses (with the updated schema) during and after a deployment.

## Decision
TTLs and versioned keys serve as redundant safety nets for the invalidation system. They are not the primary invalidation mechanism (that is pub/sub) but they bound the impact of invalidation failures.

**TTL policy per entity type:**
- Pricing data: fresh TTL 30 seconds, stale TTL 90 seconds (correctness-sensitive, short TTL as safety net)
- Product availability status: fresh TTL 60 seconds, stale TTL 120 seconds
- Product catalog metadata (descriptions, images): fresh TTL 300 seconds, stale TTL 600 seconds
- Global reference data (categories, attributes): fresh TTL 600 seconds, stale TTL 1,200 seconds

TTLs are set with ±15% random jitter to prevent synchronized expiry of keys populated during the same batch load.

**Versioned keys on schema change:** When the product API response structure changes in a way that requires the key scheme's `schema_version` segment to be incremented (per ADR-002), old-version cache entries are left to expire naturally. The new version starts with an empty cache. This is deliberately passive: no active cleanup of old keys is performed. The TTL safety net ensures old-version keys expire within their TTL window, after which they no longer occupy cache memory.

**Schema version coupling:** The `schema_version` segment in the cache key is driven by the response schema version number managed in the API service configuration. A deployment that changes the schema version causes all subsequent reads to use a new key prefix, effectively starting with a cold cache for that entity type. This is an acceptable cold-start cost for the benefit of guaranteed correctness.

## Alternatives Considered

**Infinite TTL (keys expire only on explicit eviction):** No TTL on cache entries; entries exist until evicted by an invalidation event or until Redis memory pressure causes LRU eviction. Maximizes cache hit rate for stable data. Rejected because it provides no safety net for invalidation failures: a missed invalidation event leaves a stale entry in the cache until the next invalidation for that key, which may never come.

**Very short TTLs (under 10 seconds) as the primary freshness mechanism:** Rely on short TTLs to keep data fresh without needing event-driven invalidation. Rejected because the cache stampede and origin load analysis showed that 10-second TTLs would increase origin database queries by 300-500% at current traffic levels. Short TTLs are a poor trade-off when pub/sub invalidation provides sub-20ms freshness with a much lower cache miss rate.

**Active cleanup of old schema-version keys during deployment:** Run a Redis SCAN + DEL operation targeting old-version keys as part of the deployment process. Ensures old keys are removed immediately rather than expiring naturally. Rejected because a SCAN + DEL on millions of Redis keys during a deployment adds significant load to Redis during what is already a sensitive operational period. Passive expiry via TTL is safer.

## Consequences

### Positive
- Invalidation failures (NATS outage, missed pub/sub event) result in bounded staleness rather than indefinite staleness; the TTL ensures that all entries expire and are refreshed eventually
- Schema version changes in the key format ensure correctness during deployments: the new version key starts cold but always reflects the current schema
- TTL jitter prevents synchronized expiry for keys populated during the same warm-up period, reducing cache miss spikes

### Negative
- TTLs cause periodic cache misses even for data that has not changed, adding baseline origin load proportional to the inverse of the TTL window
- The cold-start period after a schema version increment can cause elevated database load while the cache repopulates; for large entity types, this may require rate-limiting the repopulation

### Risks
- **TTL values not updated when invalidation failure rate increases.** If the pub/sub invalidation system experiences chronic partial failures (some events lost), the effective staleness window for affected data is the TTL, not the pub/sub propagation delay. If the TTLs are set based on pub/sub reliability, they may be too long for an environment where pub/sub is unreliable.

## Review Trigger
Revisit TTL values if the pub/sub invalidation system experiences availability issues that exceed 0.1% of invalidation events lost. If the invalidation system becomes unreliable, shorter TTLs are needed to compensate.

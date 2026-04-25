# ADR-001: Use Cache-Aside as default caching strategy

## Status
Accepted

## Date
2025-04-30

## Context
The Product Catalog service was the first to require caching. At current traffic levels, catalog reads constitute about 70% of all API requests, and product data changes infrequently -- most products are updated at most a few times per day. Without caching, every catalog read required a full database query, and at 1,200 requests per second the database was approaching its connection limit during peak hours.

We evaluated caching strategies for a service where the database is authoritative, multiple service instances share the same cache, and the application code is primarily read-heavy with infrequent writes. We needed a strategy that was straightforward to implement, kept the database as the unambiguous source of truth, and allowed the cache to be treated as optional (a failed cache should degrade to slower database reads, not cause service errors).

The team had prior experience with read-through caching from a previous project. That experience highlighted the coupling problem: a read-through cache requires that cache misses be handled transparently inside the cache layer, which means the cache layer needs to know how to query the origin database. In practice this produced an overly smart cache component with embedded query logic that was difficult to test and debug.

## Decision
Use **Cache-Aside** (also known as Lazy Loading) as the default caching pattern:
1. On a read request, check the cache first
2. On cache hit, return the cached value
3. On cache miss, fetch from the origin (database), populate the cache with the result, and return it
4. The cache is not consulted on writes; writes go directly to the origin and the cache is invalidated or updated separately

The cache is treated as optional at the infrastructure level: if the cache is unavailable, the service falls through to the origin for every request. This degrades performance but does not cause data errors.

## Alternatives Considered

**Read-Through caching:** The cache layer intercepts reads and transparently fetches from the origin on misses, so callers never interact with the origin directly. Rejected because it requires the cache to understand origin access patterns (query structure, authentication, connection pooling) -- logic that belongs in the service, not the infrastructure. It also makes the cache a hard dependency; a cache failure becomes an origin access failure.

**Write-Through caching:** On writes, data is written to both the cache and the origin atomically before the write is acknowledged. Rejected because atomic write-to-both requires coordinated transactions across two different storage systems, adding complexity and failure modes. For our read-heavy workload, the write path's caching needs are better served by explicit invalidation after a confirmed origin write.

**Read-Replicas without caching:** Scale read capacity by adding database replicas rather than introducing a cache. Rejected as insufficient for the catalog use case: at 1,200 reads/second for a catalog with approximately 50,000 products, most reads hit the same popular products repeatedly. Read replicas scale query throughput but do not reduce the work done per read. A cache eliminates the repeated work entirely for hot data.

## Consequences

### Positive
- The origin database remains the authoritative source of truth; a full cache eviction returns the system to correct behavior immediately
- Cache misses are handled entirely in application code, making the miss path as testable as any other code path
- Failed or unavailable cache results in degraded performance (higher origin load, higher latency) but not incorrect behavior

### Negative
- First access after a cache miss (or after cache population) always hits the origin; for newly deployed services or after a cache flush, all requests are origin reads until the cache warms up
- Each miss requires two round trips (cache check, then origin query), adding overhead to cold paths

### Risks
- **Thundering herd on cold start or cache flush.** If all keys expire simultaneously or the cache is flushed, all instances hit the origin concurrently. Mitigation: see ADR-002 for stampede protection.

## Review Trigger
Revisit if write frequency increases significantly (e.g., real-time pricing updates on every product view), at which point the invalidation overhead of cache-aside may become greater than the benefit and a write-through or TTL-only approach with shorter TTLs may be more appropriate.

# ADR-003: Evict-on-write invalidation policy

## Status
Accepted

## Date
2025-10-01

## Context
Once the key scheme and pub/sub infrastructure were in place (ADR-001 and ADR-002), the write policy needed to be defined: at what point in the write path should the cache be invalidated, and what exactly should be evicted?

Two timing options were considered: evict before the database write (write-invalidate-then-write) or evict after the database write (write-then-invalidate). A third option, write-through (populate the new value in the cache simultaneously with the database write), was also evaluated.

The write-invalidate-then-write order was rejected because it creates a window where the cache has been evicted but the database write has not yet completed. During that window, a cache miss would hit the database and repopulate the cache with the old value -- before the new value is committed. The cache would then serve the old value even after the write completes.

The write-through approach was tested and rejected for a specific reason: the write service does not always know the exact cache key that should be updated. In a multi-tier cache (L1 per instance + L2 Redis), write-through requires the write service to update every instance's L1 cache -- which requires it to know the number and addresses of all running instances, and to push the new value to each one. This is operationally fragile.

## Decision
The invalidation policy is **evict-on-write**: after a successful database write, evict the affected keys from the cache rather than populating them with the new value.

The sequence:
1. Write service writes the new value to the database
2. Write service publishes an invalidation event to the NATS `cache.invalidation` subject, listing the affected cache keys
3. Write service locally evicts the specified keys from its own L1 cache (if it has one)
4. Write service deletes the specified keys from the L2 Redis cache directly (not via the pub/sub path; this provides faster L2 eviction than waiting for the pub/sub consumer to receive and process the event)
5. All other API instances receive the pub/sub invalidation event and evict the keys from their L1 caches and delete from L2

On the next read request for an evicted key, the requesting instance populates the cache from the database with the freshly written value.

**Idempotency:** Invalidation events are idempotent to process: deleting a key that does not exist in the cache is a no-op. Multiple deliveries of the same invalidation event produce the same result as a single delivery.

**Eviction scope:** The invalidation event contains the exact affected keys, not patterns. Deriving which keys are affected by a given write is the write service's responsibility. For a product price update, the write service knows the product ID and tenant ID, so it knows which key to evict. For bulk updates (e.g., activating a promotional pricing tier for all products in a category), the write service generates the complete set of affected keys before publishing.

## Alternatives Considered

**Update cache value on write (write-through):** When the database write completes, push the new value to the L2 Redis cache and notify all instances to replace their L1 entry. Rejected because pushing to all instances' L1 caches requires the write service to know instance addresses and maintain connections, which is incompatible with auto-scaling.

**Stale-while-revalidate instead of explicit eviction:** Do not evict on write; instead, mark the key as stale and allow reads to trigger a background refresh. The stale value is served until the refresh completes. Rejected for correctness-sensitive fields (price, status) because serving a stale price or status even briefly after a write is the problem we are solving. Stale-while-revalidate is appropriate for non-correctness-sensitive data only.

**Pre-emptive cache warming after eviction:** After evicting the key, immediately fetch the new value from the database and populate the cache, so that the next read is a cache hit. Rejected because it doubles the database load for every write (one write + one immediate read), and the pre-warming read may race with other processes that have already populated the key.

## Consequences

### Positive
- The evict-on-write policy is simple to implement and reason about: after a successful write, the cache no longer contains the old value, and the next read populates it with the correct new value
- Idempotent eviction events mean that duplicate event delivery (from pub/sub redelivery) has no negative effect
- The write service's direct L2 deletion provides faster L2 eviction than waiting for the pub/sub consumer path

### Negative
- Every write causes a cache miss for the first read of the evicted key, adding a database round-trip for frequently written data
- For write-heavy datasets (e.g., real-time inventory counts that update every few seconds), evict-on-write produces near-zero cache hit rates because the key is evicted before most reads can find it in the cache

### Risks
- **Write service fails to publish invalidation event after database write.** The database write succeeds but the NATS publish fails (NATS temporarily unavailable). The cache is not evicted. Subsequent reads return the old value until the TTL expires. Mitigation: the write service retries the invalidation event publish before returning success to the caller; if retries fail, it logs a warning and the TTL safety net limits the staleness window.

## Review Trigger
Revisit for write-heavy datasets where evict-on-write produces unacceptably low cache hit rates. For those specific data types, a shorter TTL without eviction may produce better cache efficiency than eviction on every write.

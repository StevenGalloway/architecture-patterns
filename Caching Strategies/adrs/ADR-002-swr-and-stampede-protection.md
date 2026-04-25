# ADR-002: Use SWR + distributed locks to prevent cache stampedes

## Status
Accepted

## Date
2025-07-09

## Context
After cache-aside was deployed, we observed a recurring pattern on the product detail page: for very popular products (the top 200 items by view volume), TTL expiry caused all service instances to simultaneously experience a cache miss and issue parallel database queries for the same product. At 8 instances and peak traffic of 1,200 requests per second, a single popular product expiring its TTL could generate 50-80 simultaneous database queries before the first instance had time to repopulate the cache.

For most products this was not a problem -- the database could absorb the brief spike. But for the top 20 products (featured items, homepage promotions), the stampede caused measurable database CPU spikes on every TTL cycle. Each spike lasted 200-400ms. With a 60-second TTL and 20 hot products with TTLs staggered only by initial load time, the database saw multiple mini-spikes per minute.

We needed a mechanism to ensure that when a popular key expires, only one instance reloads the data from the origin while all other instances receive a slightly stale response, rather than all instances racing to reload simultaneously.

## Decision
Two mechanisms are combined for hot keys:

**Stale-While-Revalidate (SWR):** Cache entries are stored with two TTLs: a "fresh" TTL (60 seconds for product data) and a "stale" TTL (120 seconds). When a request arrives for a key that is past its fresh TTL but within its stale TTL, the cache returns the stale value immediately and triggers an asynchronous background revalidation. Callers receive a response immediately rather than waiting for the origin.

**Distributed lock per hot key (SETNX + TTL):** The background revalidation acquires a short-lived Redis lock for the specific key before querying the origin. If the lock is already held (another instance is already reloading this key), the revalidation attempt is dropped -- the first instance to acquire the lock will repopulate the cache, and the stale value continues to be served until that repopulation completes.

The combined behavior: at most one origin query per key per revalidation cycle, with zero latency impact on callers because stale data is served during the revalidation period.

## Alternatives Considered

**Probabilistic early revalidation (PER):** Trigger a revalidation with increasing probability as a key approaches its TTL, so some requests start reloading the key before it expires. One instance "wins" the race to refresh early. Rejected because PER requires tuning a decay function that affects when pre-expiry revalidation starts, and it still allows multiple simultaneous refreshes (just spread over the pre-expiry window rather than at the exact expiry moment). The distributed lock approach provides harder isolation.

**Push invalidation with background refresh:** A separate cache warming service preloads popular keys before they expire, preventing misses entirely. Rejected as an initial solution because it requires the warming service to know which keys are "popular" and track TTLs across all instances -- a significant operational complexity that is not justified until the stampede problem is proven to be chronic at scale.

**Longer TTLs to reduce stampede frequency:** Increase TTL to 300 seconds or more, reducing how often expiries occur for popular products. Partially adopted (stale TTL is 120s, longer than the 60s fresh TTL), but not sufficient alone because longer TTLs without SWR just mean larger staleness windows, not fewer stampedes.

## Consequences

### Positive
- Hot key expiry no longer causes database CPU spikes; origin load during revalidation is limited to one query per key per revalidation cycle regardless of concurrent request volume
- Callers experience no added latency during revalidation because stale data is served immediately
- The distributed lock's short TTL (5 seconds) ensures that a failed or slow revalidation releases the lock quickly and does not block the next refresh cycle

### Negative
- Data served during the stale window (60-120 seconds) may be up to 60 seconds stale; for product data this is acceptable, but it is not appropriate for correctness-sensitive data (prices, inventory availability)
- The SWR mechanism requires background goroutines or async tasks for revalidation; if the background reload queue fills up, revalidation may be delayed

### Risks
- **Stale serving after an important product update.** If a product price is corrected, it may continue to be served from the stale cache for up to 60 seconds. Mitigation: price-sensitive fields are excluded from the SWR path; price data uses a shorter TTL and explicit event-driven invalidation (see ADR-004).

## Review Trigger
Revisit if the number of distinct hot keys exceeds the Redis memory budget for distributed locks, or if the background revalidation pattern creates observable latency in the Redis connection pool during peak traffic.

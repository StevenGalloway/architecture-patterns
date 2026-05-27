# ADR-003: Use Redis for global rate limit state

## Status
Accepted

## Date
2025-11-05

## Context
The API gateway runs as 6 horizontally scaled instances behind a load balancer. Without shared state, each instance would maintain its own independent rate limit counters. A client whose requests are distributed across all 6 instances could make 6x the intended limit without any single instance detecting the violation.

For example, with a 30 requests/minute limit and 6 gateway instances, a client routing 5 requests per minute to each instance would pass each instance's individual counter check while making 30 requests per minute in aggregate. The per-instance check would never trigger.

The need for global rate limit state is not unique to our deployment; it is a fundamental property of any horizontally scaled edge tier where clients are not sticky (load-balanced without session affinity). The question was not whether to share state, but which store to use.

We evaluated Redis (already deployed for caching), a PostgreSQL table with row-level locking, and a dedicated rate limiting service (Envoy's rate limit service or a similar component).

## Decision
Store rate limit state in **Redis** using the existing Redis deployment (the same cluster used for application caching, in a separate logical keyspace). Redis is well-suited for rate limiting state: it provides atomic increment operations, per-key TTL for automatic counter expiry, and sub-millisecond response times.

Rate limit keys follow the naming convention:
- Token bucket state: `ratelimit:{env}:{rule_name}:{identifier}` (e.g., `ratelimit:prod:catalog_ip:203.0.113.1`)
- Daily quota: `ratelimit:{env}:daily:{api_key}:{YYYY-MM-DD}` (e.g., `ratelimit:prod:daily:key-abc123:2025-11-05`)

The daily quota key's TTL is set to 48 hours (2x the quota window) to ensure the key expires and the counter resets even if the scheduled cleanup job is delayed.

**Fail-open on Redis unavailability:** If Redis is unavailable (connection timeout or error), the rate limit check fails open: requests are allowed through without limit enforcement. This is explicitly preferred over fail-closed (blocking all traffic when the rate limit store is unavailable). The rationale: a Redis outage should not cause a complete API outage. Abuse during a Redis outage is a lesser harm than blocking all legitimate traffic.

Redis for rate limiting is monitored separately from Redis for caching: if Redis is down, rate limiting is non-functional, and this must trigger an immediate alert.

## Alternatives Considered

**Local in-memory counters with a gossip protocol:** Each gateway instance maintains local counters and periodically shares its counts with other instances via a gossip protocol (e.g., memberlist). Eventually consistent across instances. Rejected because gossip-based synchronization introduces a convergence delay (seconds to tens of seconds), during which a client distributing requests across instances can exceed the limit before all instances' counters converge. For a 30-requests/minute limit, a 10-second convergence gap allows 5 requests per second across instances without detection.

**PostgreSQL rate limit table:** Store rate limit counters in a PostgreSQL table. Use `UPDATE ... RETURNING` for atomic increment. Rejected because PostgreSQL transaction overhead (connection acquisition, WAL writes for each increment) adds 2-8ms per rate limit check at typical load, compared to under 1ms for Redis. At 1,000 requests per second across 6 gateway instances, the PostgreSQL approach would require 1,000 transactions per second just for rate limit updates, creating contention with the application database.

**Dedicated rate limit microservice (Envoy rate limit service):** Deploy a separate service that manages all rate limit state and exposes a gRPC API for gateway instances to query. Provides clean separation of concerns. Rejected because it adds a new service dependency to the request path. A separate rate limit service that is unavailable blocks rate limit checks (or requires fail-open handling), and it adds deployment complexity. Redis already provides all the required functionality without an additional service.

## Consequences

### Positive
- All 6 gateway instances share a single consistent view of each client's request count; a client distributing requests across instances is correctly rate limited in aggregate
- Redis's atomic Lua script execution enables the token bucket algorithm (read-decrement-write) to be implemented without race conditions
- The existing Redis deployment is reused; no new infrastructure is required

### Negative
- Redis becomes a critical path dependency for every API request; a Redis outage causes fail-open behavior (no rate limiting), which is preferable to fail-closed but still means abuse is possible during outages
- Redis instance sizing must account for both the application caching load and the rate limit state load; if the rate limit keyspace grows larger than anticipated, it may compete for memory with caching entries

### Risks
- **Redis memory eviction of rate limit keys.** If Redis is configured with `allkeys-lru` or similar eviction policies, rate limit keys may be evicted under memory pressure. An evicted daily quota key resets the client's counter to zero, allowing them to exceed their daily limit. Mitigation: the rate limit keyspace is stored in a separate Redis database (SELECT 1) or a separate Redis instance from the LRU-eviction caching keyspace, using `noeviction` policy for rate limit keys.

## Review Trigger
Revisit if the team deploys a service mesh with built-in rate limiting that uses the mesh's own distributed state (e.g., Istio's RateLimit with Redis backend), which would allow rate limiting to be managed at the sidecar layer rather than the gateway layer.

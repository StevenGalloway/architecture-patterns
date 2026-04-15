# ADR-003: Implement per-tenant token bucket rate limiting at the gateway

## Status
Accepted

## Date
2025-08-13

## Context
Two incidents drove this decision. In the first, a misconfigured integration from a partner client sent 40,000 requests in 90 seconds to the Orders API, saturating its connection pool and causing timeouts for all other tenants for approximately four minutes. In the second, a scraper hit our product catalog endpoints continuously during business hours, inflating our infrastructure bill by roughly 15% with zero revenue contribution.

Neither service had rate limiting of its own -- adding it to each service individually would have meant duplicating the same token bucket logic and Redis state management across seven services. The gateway was already the single entry point, making it the natural place to enforce usage policies consistently.

## Decision
We implement per-tenant token bucket rate limiting at the gateway layer. Each tenant is identified by their `tenant_id` JWT claim. Limits are defined per route group:
- `/auth/*` endpoints: 30 requests/minute (burst: 10)
- `/api/v1/orders/*`: 500 requests/minute (burst: 100)
- `/api/v1/catalog/*`: 1,000 requests/minute (burst: 200)
- Global fallback: 100 requests/minute per tenant for unclassified routes

Limit state is stored in Redis using a sliding window token bucket per key (`rate:{tenant_id}:{route_group}`). On limit exhaustion, the gateway returns 429 with `Retry-After` and `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

Initial limits were set conservatively based on observed p99 usage patterns and will be adjusted after 30 days of monitoring.

## Alternatives Considered

**Fixed window counters instead of token bucket:** Simpler to implement (INCR + TTL in Redis). Rejected because fixed windows allow a burst of 2x the limit across a window boundary -- a tenant can exhaust the limit at the end of one window and immediately again at the start of the next, which is the thundering herd scenario we were trying to prevent.

**Rate limiting inside each service:** Keeps rate limiting close to the protected resource. Rejected because it requires duplicating Redis state management and limit configuration in seven services. A limit change would require seven coordinated deployments.

**Third-party rate limiting service (e.g., cloud WAF):** Would offload the complexity. Rejected for now because we are not using a cloud-managed gateway (see ADR-001) and adding a separate managed service for rate limiting alone adds cost and a new vendor dependency.

## Consequences

### Positive
- Upstream services are protected from traffic spikes with no changes required in service code
- Tenants receive consistent, fair usage limits regardless of which endpoint they call
- Limit headers in every response let API consumers build retry logic without guessing

### Negative
- Redis becomes a dependency for every request that passes through the gateway; Redis unavailability degrades to no rate limiting rather than blocking all traffic (fail-open behavior, which is intentional)
- Limit configuration requires an operational process to review and adjust as tenants' legitimate usage grows; wrong limits will cause unnecessary 429s for paying customers
- Per-route limit definitions must be kept in sync with the actual route configuration

### Risks
- **Redis outage causes fail-open (no limiting).** This is intentional -- we prefer availability over strict enforcement. Alert on Redis connectivity loss so the operations team can respond before abuse escalates.

## Review Trigger
Revisit the per-route limit values after 30 days of production traffic data. Revisit the Redis fail-open decision if a security incident occurs where an attacker deliberately takes down Redis to bypass rate limiting.

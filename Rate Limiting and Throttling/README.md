# Rate Limiting + Throttling Pattern

## Summary
**Rate limiting** and **throttling** protect systems from overload, abuse, and accidental traffic spikes by enforcing a maximum request rate or quota per key (user, IP, API key, tenant, or route).

- **Rate limiting**: enforce a *policy* (e.g., 100 req/min per API key).
- **Throttling**: *shape* traffic when limits are exceeded (e.g., queue, delay, degrade, or reject).

In enterprise architectures, rate limiting is commonly applied at:
- API gateways / edge proxies (first line of defense)
- service mesh sidecars (east-west controls)
- application layer (fine-grained, tenant-aware controls)

This repo demonstrates an edge-centric approach using **OpenResty (NGINX + Lua) + Redis** with a simple backend service.

---

## Problem
Without limits, services can be taken down by:
- traffic spikes (launches, batch jobs, retries)
- abusive clients (scraping, brute force, DDoS)
- “noisy neighbors” in multi-tenant systems
- misbehaving integrations with tight retry loops

---

## Constraints & Forces
- Limits must be measurable and enforceable at scale
- Different clients/routes have different budgets (tiering)
- Distributed systems need consistent global enforcement (shared state)
- Retries + timeouts can multiply traffic during incidents
- You need a safe response strategy (429 + Retry-After, or degrade)

---

## Solution
### Choose a limiting algorithm
Common approaches:
- **Token Bucket** (burst-friendly): allows short bursts, enforces average rate
- **Leaky Bucket** (smoother): requests “drip” at steady rate
- **Fixed Window** (simple, but bursty at window boundaries)
- **Sliding Window** (more accurate, more costly)
- **Concurrency limit** (protect downstream resources; overlaps with Bulkhead)

### Choose enforcement points
- **Edge/API gateway**: protect upstreams early, consistent policy
- **Application layer**: tenant-aware policies, per-operation budgets

### Define a client contract
- Return **429 Too Many Requests**
- Include `Retry-After` (seconds) and/or standardized rate limit headers:
  - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### Multi-tenant tiering
- per tier (free/pro/enterprise)
- per route (login vs search vs checkout)
- per key (API key, user id, IP)

---

## When to Use
- Public APIs (B2B/B2C), mobile apps, partner integrations
- Multi-tenant SaaS (noisy neighbor protection)
- High-cost operations (LLM calls, payment auth, complex searches)

## When Not to Use (or be careful)
- Internal service-to-service calls where a mesh policy is better
- Workflows requiring guaranteed acceptance (then queue + backpressure might be preferred)
- Non-idempotent endpoints: rejecting can create retries that cause duplicates unless clients are well-behaved

---

## Tradeoffs
### Benefits
- Prevents overload and improves availability
- Provides fairness across tenants/clients
- Reduces security risk and abuse

### Costs / Risks
- Requires policy governance and ongoing tuning
- Shared-state limiters need Redis (or gateway-specific stores)
- Improper configs can block legitimate traffic or cause customer pain

---

## Failure Modes & Mitigations
1. **Redis down → global limiter fails**
   - Mitigation: fail open for low-risk endpoints; fail closed for auth; alert + fallback local limits
2. **Retry storms amplify traffic**
   - Mitigation: set client guidance, circuit breakers, and server-side `Retry-After`
3. **Tier misconfiguration**
   - Mitigation: config-as-code with reviews, automated tests, canary rollout
4. **Burst at window boundaries**
   - Mitigation: use token bucket or sliding window
5. **Abuse via IP rotation**
   - Mitigation: API key limits + behavior analytics + WAF

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-edge-rate-limit-sequence.mmd`
- `diagrams/03-tiered-policies.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-rate-limiting-at-edge.md`
- `adrs/ADR-002-algorithm-token-bucket-and-quota.md`
- `adrs/ADR-003-redis-for-global-state.md`
- `adrs/ADR-004-client-contract-headers.md`
- `adrs/ADR-005-observability-and-runbooks.md`

---

## Example (New Tech)
This example uses **OpenResty (NGINX + Lua) + Redis + Deno**:
- `edge`: NGINX/Lua enforces:
  - **per-IP token bucket** (burst-friendly)
  - **per-API-key quota** (global, stored in Redis; demo daily quota)
- `service`: simple Deno backend returning JSON
- `infra`: docker-compose to run edge, redis, and backend

See `examples/openresty-redis-deno/`.

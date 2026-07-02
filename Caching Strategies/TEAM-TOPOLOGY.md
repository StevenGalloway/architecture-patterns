# Team Topology — Caching Strategies

## Who Owns the Cache?

Caching ownership depends on scale. At small scale, caching is a **stream-aligned team** responsibility: the team that owns a service owns its cache. At medium and large scale, caching becomes a **platform team** asset — shared Redis infrastructure, key namespace governance, and stampede protection become too expensive to rebuild per team.

The critical rule that holds at every scale: **the team that owns the data must own the cache key design for that data.** Cache key design encodes your domain model's identity and freshness requirements. When that knowledge lives in a different team than the key design, you get TTL policies that don't match update frequency, key schemas that collide across services, and multi-day debug cycles for "mystery stale" bugs.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | Redis fleet provisioning, HA, upgrades, memory quota enforcement, eviction policy configuration, stampede protection primitives, shared cache client library |
| **Stream-aligned (e.g., Product, Orders)** | Stream-aligned | Cache key namespace design, TTL selection within platform-defined tiers, invalidation event contracts, what data is cached and when |
| **Security** | Enabling team | PII-in-cache policy, encryption-at-rest requirements, tenant isolation standards, GDPR erasure path for cached data |
| **Data / CDC** | Enabling team | Change-data-capture event contracts that drive cache invalidation; guarantees on event ordering and delivery |

The platform team owns the Redis cluster and the shared client library. It does not own which data gets cached or what the keys look like. Those decisions belong to the stream-aligned team that owns the originating data.

---

## Conway's Law Implications

Cache key design is a mirror of your team structure. When teams coordinate, keys are namespaced cleanly. When they don't, key collisions happen silently.

**What the org structure predicts about your cache layer:**

- **Platform team owns Redis infra; service teams design keys independently with no governance** → key collisions in shared caches, no namespace isolation between tenants, TTL policies set arbitrarily per engineer rather than per data class. "Mystery stale" incidents take two to four days to diagnose because no one team has full visibility.
- **Single team owns both Redis and all key design** → correct at 1-3 services, becomes a bottleneck at 6+, team knowledge silos make caching impenetrable for new engineers.
- **Platform team owns infrastructure + key namespace schema; stream-aligned teams own key design within their namespace** → scales. Teams are autonomous within guardrails. This is the recommended model at 4+ services.

The hybrid model requires the platform team to invest in namespace governance: a key schema standard, automated collision detection in CI, and a key design review as part of the service onboarding checklist.

---

## Failure Mode: Org Mismatch

The most common caching failure pattern: platform team owns Redis, but service teams independently design keys without coordination. Within six months you have:

1. Team A uses `product:{id}` as a key. Team B uses `product:{tenant_id}:{id}`. Team C uses `{tenant_id}:product:{id}`. All three services share a Redis cluster. None of the keys collide — until a new engineer copies Team A's pattern while writing a multi-tenant service.
2. Two services set different TTLs for the same underlying data. One caches user profile for 5 minutes, another for 60 minutes. A user updates their name; one service shows the new name, the other shows the old one. Support tickets open. Two days later someone finds the TTL mismatch.
3. One service stores raw PII in cache without encryption, violating a policy the security team published but never enforced technically. A cache dump during an incident exposes data.

**Signal to watch for:** any service that reads another team's cached keys directly (cross-namespace reads). This means the key schema is now a shared contract with no owner. Enforce namespace boundaries at the platform layer; different namespaces should not share read access.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform → stream-aligned | **X-as-a-service** | Teams consume Redis as a managed service: provisioned namespace, connection pooling, stampede protection, memory quota, and observability included. No Redis operations knowledge required. |
| Security → platform | **Enabling** | Security team defines PII-in-cache policy, encryption requirements, and GDPR erasure paths. Platform team implements controls in the shared cache client library. Quarterly policy review. |
| Stream-aligned ↔ stream-aligned | **Collaboration** | When two services share an invalidation event contract (e.g., Product service publishes `product.updated`; Search service listens to invalidate its derived cache). Time-box design sessions; establish the contract, then exit collaboration mode. |
| Data / CDC → platform | **Enabling** | Data team defines event schema and ordering guarantees for CDC events used for cache invalidation. Platform team wires invalidation subscriber to event bus. |

---

## Cognitive Load: Caching Is Harder to Debug Than It Looks

Cache invalidation bugs are some of the hardest bugs to diagnose in distributed systems. The symptom is usually "stale data" with no error — the system returns a valid-looking response that happens to be 30 minutes old. Without structured logging of hit/miss decisions and TTL state, these bugs require Redis MONITOR output and manual key inspection.

The team that introduced a caching strategy needs more than a README. Required artifacts:

- **Runbook:** what to do when hit rate drops below 60% (step-by-step, not "investigate")
- **Runbook:** what to do when a cache stampede is detected (how to engage rate limiting, how to clear the lock)
- **Runbook:** how to perform an emergency cache flush without triggering a thundering herd
- **Key inventory:** documented key schema per namespace, with TTL rationale, eviction policy, and data classification
- **Invalidation map:** which events invalidate which keys — required for debugging "why is this stale?"

If this documentation doesn't exist, the cognitive load of owning the cache falls entirely on the engineer who wrote it — who may not be available during an incident at 2am.

---

## Scaling the Team Model

| Scale | Recommended model |
|---|---|
| 1–3 services, 1–2 teams | One team owns everything: Redis cluster, key design, TTL policy, invalidation. Cache is low complexity. |
| 4–12 services, 3–6 teams | Platform team owns Redis fleet and shared client library. Service teams own key namespaces within platform-defined schema and TTL tiers. Namespace collision detection automated in CI. |
| 12+ services, 6+ teams | Self-service cache namespace provisioning. Teams declare cache requirements (namespace, TTL tier, PII classification, memory quota) via config. Platform provisions automatically. Automated quota enforcement. Key design review as part of service onboarding. |

At 12+ services, caching governance becomes a significant platform investment. Teams that skip the platform library and build their own Redis clients are the clearest signal that the platform has not made the paved road easy enough.

# Distributed Cache Invalidation Pattern

## Summary
Distributed caching often combines:
- **L1**: in-memory cache (per instance, fastest)
- **L2**: shared cache (Redis/Memcached)
- **Origin**: database or downstream service

The hard part is **keeping caches coherent across instances** when data changes. The **Distributed Cache Invalidation** pattern propagates invalidation events so all nodes evict the same keys quickly and consistently.

Common invalidation mechanisms:
- **Pub/Sub** (NATS, Kafka, Redis Pub/Sub) for low-latency broadcasts
- **Outbox + CDC** for durable, transactional event publication (stronger guarantees)
- **Versioned keys** and TTLs to reduce reliance on perfect invalidation
- **Write-through** or **cache-aside** with explicit evict-on-write policies

---

## Problem
In a horizontally scaled service, each instance may keep local state (L1 cache). Without distributed invalidation:
- Instance A updates origin and evicts its own cache
- Instance B continues serving stale values from L1/L2
- Customers see inconsistent results depending on which node they hit

---

## Constraints & Forces
- Multiple caches (L1/L2/CDN) increase speed but also staleness risk
- Events must be **idempotent** and safe to process multiple times
- Event delivery can be at-most-once unless you use durable messaging
- TTL-only caching can be stale longer than allowed after writes
- Multi-tenant keying must prevent data leaks (tenant in key)

---

## Solution
1) **Define a canonical cache key scheme**:
   - `env:tenant:version:entity:id`
2) On write:
   - update origin (DB)
   - publish an **invalidation event** containing affected keys
3) On all instances:
   - subscribe to invalidation events
   - evict L1 + delete L2 keys
4) Use TTLs as a safety net:
   - prevents indefinite staleness if invalidation is missed
5) Add observability:
   - invalidation publish/consume rates
   - stale serve rate, cache hit ratio, consumer lag

---

## When to Use
- Multi-instance services with L1 caches
- Shared cache used by many instances where correctness matters
- Read-heavy domains with moderate update frequency
- Systems where "eventual consistency within seconds" is acceptable

## When Not to Use (or be careful)
- Ultra-strict consistency requirements without durable publication (prefer outbox/CDC)
- Highly volatile data where caching itself provides little value
- Data with strong privacy/regulatory controls unless keys/values are protected

---

## Tradeoffs
### Benefits
- Reduces stale reads across horizontally scaled fleets
- Improves user experience without ultra-short TTLs
- Enables L1 caches safely in many workloads

### Costs / Risks
- Requires messaging infrastructure and ops (NATS/Kafka/etc.)
- Pub/Sub can drop messages (unless durable)
- Key management complexity (fan-out, wildcard invalidation)

---

## Failure Modes & Mitigations
1. **Missed invalidation event → stale data**
   - Mitigation: TTL safety net; versioned keys; durable publication (outbox/CDC)
2. **Event storms (many keys)**
   - Mitigation: key grouping, namespace invalidation, batching, rate limits
3. **Over-invalidation reduces cache hit ratio**
   - Mitigation: invalidate narrowly; include entity-level key mapping
4. **Noisy neighbor invalidations**
   - Mitigation: tenant-scoped keys and subscriptions; tiering
5. **Consumer lag**
   - Mitigation: durable messaging, scaling consumers, alerts

---

## Example (Different Tech)
This example uses **Node.js 20 + Express + Redis + NATS + Postgres**:
- Two API instances (`api-a`, `api-b`) with:
  - L1 in-memory cache (per instance)
  - L2 Redis cache (shared)
- Writes publish invalidation events over **NATS**
- All instances subscribe and evict L1+L2 consistently

See `examples/node-express-redis-nats-postgres/`.

---

## Security Considerations

Distributed cache invalidation creates a messaging channel between write services and cache consumers. This channel is an attack surface that traditional request/response security models don't account for. An attacker who can publish unauthorized invalidation events can flush caches (availability impact). An attacker who can suppress invalidation events can cause stale data to persist indefinitely (data integrity impact).

**Core security controls:**
- NATS (or Kafka) topic access control must be enforced: only authorized write services may publish to invalidation topics. Unauthorized publishers can flush the entire cache by broadcasting wildcard invalidation events, triggering a thundering herd on the origin database.
- Invalidation events must contain only the cache keys to evict — not the new data values. An invalidation event that carries the new value turns the message bus into a data propagation channel, exposing data values to any subscriber of the invalidation topic.
- The tenant ID must be the first segment of every cache key. Without this, a multi-tenant service can serve one tenant's cached data to another when keys collide across tenants in a shared Redis cluster.
- Security-relevant cached data (user permissions, session state, authorization decisions) must have very short TTLs or be invalidated immediately on change. A stale permission check that grants access to a revoked user is a critical security event, not a data freshness issue.
- GDPR right-to-erasure requires a first-class `user.erasure` invalidation event type that evicts all cache keys containing records for the specified user — not relying on TTL expiry, which could keep the user's data in cache for minutes after an erasure request.

**Compliance relevance:** GDPR Art. 17 (erasure must invalidate caches containing user data, not just the origin database), SOC 2 CC6.1 (invalidation events for security-relevant data are access control changes that must be logged), HIPAA (PHI must be invalidated from cache immediately on deletion, not TTL-expired).

→ See [SECURITY.md](SECURITY.md) for the full threat model, 8-entry attack surface table, NATS topic authorization requirements, and the 10-item security review checklist.

---

## Observability Considerations

Cache invalidation failures are silent by design. A missed invalidation event doesn't produce an HTTP error — it produces a stale cache hit that looks identical to a correct cache hit. Without specific instrumentation for invalidation pipeline health, stale data incidents are discovered by end users or business analysts, not by monitoring. By then, the window of incorrectness may have been hours.

**Golden signals for the invalidation pipeline:**
- **Latency:** `invalidation.event.publish_to_consume_latency_ms` — the time from when an invalidation event is published to when all instances have evicted the affected keys. Alert when p99 > 500ms. This is the staleness window for correctness-critical data.
- **Traffic:** `invalidation.events.published.rate` vs `invalidation.events.consumed.rate` per consumer instance. These rates must match. A divergence means some instances are falling behind or not receiving events.
- **Errors:** `invalidation.consumer.lag` — the number of pending unprocessed events per consumer group. Alert when lag exceeds 1,000 events (backlog growing faster than consumed). `invalidation.publish.failures.rate` — NATS unavailable during a write operation means that write's invalidation event was dropped.
- **Saturation:** NATS JetStream storage utilization (alert >70%), Redis eviction rate. If Redis is evicting entries due to memory pressure, invalidation events arrive to find already-missing keys — not an error, but a signal that the cache tier is undersized.

**The silent failure test:** Run a synthetic probe that writes a value to the origin, waits 200ms, then reads from each instance's cache endpoint and verifies the old value is no longer served. This is the only reliable way to continuously validate that invalidation is working end-to-end.

**SLO targets (reference):** Invalidation Propagation SLO — 99th percentile of invalidation events propagate to all consumers within 500ms of publication. Cache Coherence SLO — synthetic probe detects zero stale reads after a confirmed invalidation event, measured continuously.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, SLI/SLO definitions, structured log schema for invalidation events, three dashboard designs, six chaos engineering scenarios, and the three-tier alerting philosophy.

---

## Team Topology

Distributed cache invalidation sits at the intersection of multiple team boundaries, which is exactly what makes it go wrong. The pattern requires coordination between: the team that writes data (must publish invalidation events), the platform team (owns the message bus), and every service team with a cache (must subscribe and evict correctly). When ownership of any one of these is unclear, the system works intermittently and fails silently.

**The critical ownership gap:** "Who publishes the invalidation event?" must have a single unambiguous answer per entity type. If three write services update product data but only one publishes invalidation events, the caches are stale after the other two services' writes — and no error is produced. The write service that changes the data is responsible for publishing the invalidation event.

**Conway's Law:** The cache key design is a team boundary artifact. Teams that independently design their cache keys in a shared Redis cluster will create key collisions, inconsistent namespacing, and mutual dependency on each other's internal key structures. The team that owns the data must own the key design for that data. This requires active platform governance (a shared key schema registry) to prevent drift as teams scale.

**The org mismatch failure:** If the team responsible for pricing data (publishes prices) is separate from the team responsible for the Product API (caches prices), and these teams have independent release cadences and communication norms, the invalidation contract will drift. A pricing schema change that isn't communicated to the Product API team produces serialization errors on invalidation events — which fail silently and leave stale prices in cache.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the full team classification, the ownership gap analysis, interaction modes table, and the scaling model from 3 to 10+ write services (including the transition to CDC-based invalidation).

---

## Cost Analysis

The cost of distributed cache invalidation infrastructure is almost always justified by the database load reduction it enables. L1 in-process caches can only be safely used in horizontally scaled services when invalidation ensures they don't serve stale data. Without invalidation, short TTLs are required — which significantly increases cache miss rates and database query volume.

| Scale | Invalidation infrastructure cost | Database cost reduction |
|---|---|---|
| Small (8 instances, <10K writes/day) | ~$90-150/mo (3-node NATS JetStream) | Neutral (L1 TTL shortening cost ≈ NATS cost) |
| Medium (50 instances, 100K writes/day) | ~$300-500/mo | ~$800-1,200/mo Redis tier reduction from L1 benefit |
| Large (200+ instances, 1M+ writes/day) | ~$1,000-2,400/mo (NATS or Kafka MSK) | ~$10,000-20,000/mo database load reduction |

**The L1 enablement argument:** Without invalidation, L1 caches require 10-15 second TTLs to limit staleness. With invalidation, L1 caches can use 60-second TTLs safely. At 500,000 requests/day with 80% of traffic on hot keys, extending L1 TTL from 10s to 60s reduces Redis query volume by 60-70% — which is worth $800-1,200/month in Redis tier reduction at medium scale.

**Largest hidden cost:** The engineering cost of diagnosing invalidation failures. Stale data incidents are silent and hard to trace. Budget 2-4 engineer-hours per stale data incident; at scale, these happen monthly without a mature observability setup. Invest in the synthetic coherence probe (described in OBSERVABILITY.md) before scaling.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full pricing comparison, L1 cache enablement break-even analysis, and the 4 cost anti-patterns in distributed cache invalidation.

---

## AI Integration

Cache invalidation for AI workloads introduces invalidation triggers that don't exist in traditional systems. The same L1/L2 invalidation pattern applies, but the events that trigger invalidation are model promotions, knowledge base updates, and embedding model version changes — not just write operations on structured data.

**Key AI-specific invalidation patterns:**
- **Model update invalidation:** When a new model version is deployed, all cached inference results from the previous model are stale and must be invalidated. Cache entries must be tagged with the model version (`model_id:model_version:request_hash`) and a `model.promoted` event triggers mass invalidation of all entries from the old version.
- **Embedding cache invalidation:** When a document's content changes, its embedding vector is stale. CDC from the document store triggers targeted invalidation of all embedding cache entries for that document (`embedding:{model_id}:{document_id}:{chunk_index}`). A single document update fans out to N chunk invalidations.
- **Vector index staleness:** ANN indexes (HNSW, IVF) become stale as documents are added or removed. Unlike key-value cache invalidation (cheap: delete a key), vector index invalidation requires a full rebuild or incremental update — a fundamentally more expensive operation that must be scheduled, not triggered synchronously.
- **Semantic cache invalidation:** LLM response caches based on semantic similarity can't use exact-key invalidation. When the knowledge base changes, tag-based invalidation evicts all semantic cache entries tagged with the affected topic or document scope.
- **Multi-model namespace isolation:** Different model versions must have isolated cache namespaces. A semantic cache lookup for model v1.3 must never return a cached result from model v1.2.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full treatment: model version key namespacing, embedding cache fan-out analysis, vector index invalidation strategies, tag-based semantic cache invalidation, and orphaned namespace garbage collection.

---

## Platform Engineering

Cache invalidation should be invisible to application developers. A team that adds caching to their service should write `cache.get()` and `cache.set()` and receive invalidation automatically — they should not implement NATS subscriptions, write eviction logic, or manage L1/L2 coordination. When teams implement their own invalidation logic, the result is inconsistent key formats, no stampede protection, and dark spots in cache observability.

**The paved road:** Teams declare their cache namespace and invalidation triggers in a config file. The platform library reads this config, subscribes to the appropriate NATS topic, and handles L1 eviction and L2 deletion automatically. The team's application code never calls NATS directly.

```yaml
cache-config.yaml:
  namespace: product-catalog
  tenant_aware: true
  invalidation:
    subscribe_topic: catalog.product.updated
    key_pattern: "product:{entity_id}"
  l1:
    max_entries: 10000
    ttl_seconds: 60
  l2:
    ttl_seconds: 300
```

**Platform contract:** Invalidation event delivery within 100ms p99 under normal conditions; consumer lag monitoring and page-level alerts; cache library support for Node.js, Python, Go, and Java; Redis cluster availability 99.9%; NATS JetStream availability 99.9%.

**Signal that invalidation has become a platform problem:** Multiple teams have implemented their own NATS subscribers and eviction logic, producing inconsistent behavior. Teams are using different key formats for the same entity type. Cache-related stale data incidents take more than 30 minutes to diagnose because there's no platform runbook.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the full paved road comparison, declarative cache config schema, complete platform contract, local development setup, test helper patterns, and 4 anti-patterns specific to invalidation.

---

## Business Case

A $120/month NATS cluster enables safe L1 in-process caches across a horizontally scaled fleet — shrinking the price inconsistency window from 60 seconds to under 1 second, while simultaneously reducing Redis query volume by 60-70% and deferring database tier upgrades.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for CPO, CFO, and VP Engineering: the flash sale price inconsistency problem in plain language, what this implementation costs, the specific business gains (instant price propagation, accurate inventory availability), and what we're not changing.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (end user, operations engineer, write service, message bus, API instances, origin database)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (HTTP handler, L1 cache, cache client library, invalidation subscriber, Redis L2, NATS JetStream)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-invalidation-sequence.mmd](diagrams/02-invalidation-sequence.mmd) — Invalidation event flow from write to all consumer instances
- [03-l1-l2-ttl-and-versioning.mmd](diagrams/03-l1-l2-ttl-and-versioning.mmd) — L1/L2 tiered cache with TTL safety net and versioned key fallback

---

## Architecture Decision Records
- [ADR-001: Use NATS JetStream for distributed cache invalidation](adrs/ADR-001-pubsub-for-invalidation.md)
- [ADR-002: Cache key scheme and tenant isolation](adrs/ADR-002-key-scheme-and-tenant-safety.md)
- [ADR-003: Evict-on-write policy](adrs/ADR-003-evict-on-write-policy.md)
- [ADR-004: TTL as safety net for missed invalidations](adrs/ADR-004-ttl-and-versioned-keys.md)
- [ADR-005: Observability standards and invalidation runbooks](adrs/ADR-005-observability-and-runbooks.md)

---

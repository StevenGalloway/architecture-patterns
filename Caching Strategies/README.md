# Caching Strategies Pattern (Enterprise-Ready)

## Summary
Caching improves **latency**, **throughput**, and **cost efficiency** by storing frequently accessed data closer to consumers. In distributed systems, caching is a set of strategies with tradeoffs around **freshness**, **consistency**, **invalidation**, and **failure behavior**.

Common strategies:
- **Cache-Aside (Lazy Loading)**
- **Read-Through**
- **Write-Through**
- **Write-Behind (Write-Back)**
- **Refresh-Ahead**
- **Stale-While-Revalidate (SWR)**
- **Negative Caching**
- **Tiered Caching (L1/L2)**
- **TTL vs Event-Driven Invalidation**

---

## Problem
Datastores and downstream services become bottlenecks under read-heavy or bursty traffic:
- repeated identical reads waste IO/CPU
- "hot keys" cause thundering herds and stampedes
- p95/p99 latency degrades under load

---

## Constraints & Forces
- Freshness vs performance
- Invalidation is hard (and often the real work)
- Cache stampede risk under concurrency
- Key design + multi-tenant isolation
- Observability (hit ratio, evictions, stale serve rate)

---

## Solution
- Use the right strategy per domain (reference vs volatile data)
- Add stampede protection (locks/single-flight) for hot keys
- Combine TTL with event-driven invalidation where correctness matters
- Use versioned keys during schema/deploy changes

---

## Example (Different Tech)
**Python + FastAPI + Redis + Postgres**:
- cache-aside for `GET /products/{id}`
- negative caching for missing items
- SWR + distributed lock (SETNX + TTL) to avoid stampedes

See `examples/python-fastapi-redis-postgres/`.

---

## Security Considerations

The cache is a secondary data store that typically holds the same sensitive data as the primary database but with weaker default access controls. Because authorization is enforced at the application layer — not at the cache layer — any service with network access to the cache endpoint can read any key it can guess or enumerate.

**Core controls required for a production cache:**
- Include tenant ID as the first segment of every cache key. Without this, a multi-tenant system can serve one tenant's data to another through cache key collisions.
- Never cache PANs, CVVs, or unencrypted PII in a shared cache. Encrypt sensitive fields before writing to the cache — not just transport encryption (TLS), but field-level encryption. A Redis dump or network interception must not expose plaintext PII.
- GDPR right-to-erasure cannot be satisfied by TTL expiry alone. A user erasure request requires an immediate invalidation of all cached data for that user, not waiting for TTLs to expire across all tiers.
- Cache key enumeration is a real threat in multi-tenant systems: a predictable key format allows a compromised service to read another tenant's cached data. Use non-guessable components (UUID-based tenant IDs) as key segments.

**Compliance relevance:** GDPR Art. 17 (right to erasure requires cache invalidation path), SOC 2 CC6.1 (access to cached PII must be controlled and auditable), PCI DSS (PANs and CVVs must never appear in a shared cache regardless of TTL).

→ See [SECURITY.md](SECURITY.md) for the full threat model, attack surface table, PII handling requirements, compliance controls, and pre-deployment security checklist.

---

## Observability Considerations

A cache failure is often silent. The system falls back to the database and latency increases without an obvious error. Without specific cache instrumentation, a hit rate regression — caused by a key format change in a deploy — looks like a sudden database performance problem. It isn't.

**Golden signals for the caching layer:**
- **Latency:** Track `cache.get.latency.p99` separately from end-to-end latency. A cache that adds 10ms per request is costing more than it saves. Alert at p99 > 5ms for L2 Redis.
- **Traffic:** `cache.hit.rate` by namespace is the single most important caching metric. A drop from 85% to 40% is a regression, not random variation — correlate against recent deploys. Target: >80% steady-state for warm caches.
- **Errors:** `cache.deserialization.errors.rate` is an underappreciated signal. It spikes immediately after a deploy that changed the serialization format of a cached object. Catch it before users see it.
- **Saturation:** `cache.memory.used_bytes / cache.memory.max_bytes` must stay below 75%. Above that threshold, the eviction policy starts making choices that degrade your hit rate unpredictably.

**SLO targets (reference):** Cache availability 99.9% (GET operations return within 5ms), cache hit rate >80% (measured over 24h rolling window, after 30-minute warm-up period following any cache flush).

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, SLI/SLO definitions, structured log schema, dashboard designs, and chaos engineering test scenarios with pass criteria.

---

## Team Topology

Caching infrastructure is a **platform team** asset; cache key design for a domain's data is a **stream-aligned team** responsibility. These two ownership boundaries must not be confused.

The rule: the team that owns the data owns the cache key design for that data. No other team should derive or guess the key format for data they don't own. In a shared multi-service Redis cluster without enforced namespace governance, teams will create key collisions that are nearly impossible to diagnose post-incident.

**Conway's Law signal:** If engineers from three different teams are discussing whether a Redis key should be `product:{id}` or `products:{tenant_id}:{id}`, the key design ownership is undefined. This is a team boundary gap, not a naming debate. Resolve the ownership, and the naming follows.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the full team type classification, interaction modes table, failure mode analysis, and scaling model from 1–3 to 12+ services.

---

## Cost Analysis

The primary cost decision for caching is instance sizing — Redis is memory-bound, not CPU-bound. Overprovisioning memory costs money; underprovisioning causes eviction-driven hit rate collapses that spike database costs.

| Option | Small (<10GB) | Medium (10-100GB) | Large (100GB+) |
|---|---|---|---|
| AWS ElastiCache | ~$122/mo (r7g.large) | ~$980/mo (r7g.4xlarge) | ~$4,000-8,000/mo (cluster) |
| Upstash (serverless) | ~$20/mo (pay-per-request) | ~$400-800/mo | Not recommended at this scale |
| Self-hosted Redis | ~$70/mo (EC2) | ~$600/mo (cluster infra) | ~$2,000-4,000/mo |
| Redis Enterprise Cloud | — | ~$1,500/mo | ~$10,000+/mo (Active-Active) |

**The L1 cache multiplier:** Adding an in-process L1 cache (10,000 entries, 60-second TTL) reduces L2 Redis query volume by 60-80% for hot-key workloads. This shifts the break-even point for Redis tier upgrades significantly — a workload that would require an r7g.4xlarge without L1 may run comfortably on an r7g.large with L1.

**Largest hidden cost:** Caching large binary objects (images, PDFs, large JSON blobs) in Redis. Redis memory costs $15-30/GB at ElastiCache pricing. S3 costs $0.023/GB. Caching a 500KB PDF in Redis costs roughly 1,000× more per GB than S3. Use Redis for small, frequently-accessed structured data; use CDN/object storage for large assets.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full pricing comparison, break-even analysis, serialization format memory overhead, and cost anti-patterns.

---

## AI Integration

Caching and AI/ML workloads intersect at multiple high-value points that go beyond simply "caching model responses."

**Key intersection points:**
- **Semantic caching for LLM responses:** Instead of exact key matching on the prompt string, embed the prompt and compare cosine similarity against cached prompt embeddings. Semantically equivalent questions (`"What is the capital of France?"` vs `"What's France's capital city?"`) return the same cached response at similarity >0.95. This reduces LLM API costs by 40-60% in typical query workloads without affecting response quality.
- **Transformer KV cache:** LLMs maintain an internal key-value cache during token generation, storing computed attention keys and values for the prompt so they aren't recomputed at each generation step. A 70B parameter model with 128K context requires 80-160GB of KV cache memory during inference. Understanding this is essential for sizing inference infrastructure.
- **Embedding cache for RAG:** Vector embeddings for retrieval-augmented generation are expensive to compute. Cache embeddings at the document chunk level with cache key `{model_id}:{document_id}:{chunk_index}` and invalidate via CDC when the document changes.
- **Model output caching tiers:** L1 (in-process, exact match, <1ms), L2 (Redis, semantic similarity via pgvector, <10ms), L3 (persistent store, long-lived summarizations). Each tier has different invalidation triggers.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full treatment: semantic caching architecture, transformer KV cache memory sizing, embedding cache invalidation patterns, and cache warming strategies for AI feature launches.

---

## Platform Engineering

Caching should be a platform capability — teams should receive Redis connection management, key namespace enforcement, stampede protection, TTL policy, and cache metrics automatically, without writing infrastructure code.

**The paved road:** A team that adds caching to their service should write `cache.get(key)` and `cache.set(key, value, ttl_tier)` — not Redis client initialization, connection pool tuning, key serialization, or distributed lock logic. If they're writing those, the platform hasn't abstracted the right things.

**Self-service:** Teams declare their cache namespace requirements in a config file (namespace, TTL tier, eviction policy, PII classification). The platform provisions the namespace with memory quota, enables monitoring, and registers the namespace in the key schema governance registry.

**Signal that caching has become a platform problem:** Multiple teams are implementing their own Redis clients that bypass the platform library. This produces inconsistent key formats, no stampede protection, and dark spots in the cache observability dashboard.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the paved road comparison table, self-service namespace declaration schema, platform contract definition, and developer experience requirements.

---

## Business Case

A $150-300/month Redis cache can defer a $2,000-5,000/month database tier upgrade by absorbing 60-70% of read traffic — and reduce user-visible p99 latency from ~200ms to <10ms for cached reads.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for CPO, CFO, and VP Engineering: the problem in plain language, implementation cost in engineer-weeks and monthly infrastructure, what the business gains, and the cost of inaction.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (external actors, systems, and relationships)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (L1 in-process cache, cache client library, Redis L2 cluster, invalidation subscriber, metrics exporter)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-cache-aside-and-swr-sequence.mmd](diagrams/02-cache-aside-and-swr-sequence.mmd) — Cache-aside and stale-while-revalidate request flow
- [03-tiered-cache-and-invalidation.mmd](diagrams/03-tiered-cache-and-invalidation.mmd) — L1/L2 tiered cache and invalidation event flow

## Architecture Decision Records
- [ADR-001: Use Cache-Aside as default caching strategy](adrs/ADR-001-adopt-cache-aside.md)
- [ADR-002: Stale-While-Revalidate and stampede protection](adrs/ADR-002-swr-and-stampede-protection.md)
- [ADR-003: Key design and TTL policy](adrs/ADR-003-key-design-and-ttl-policy.md)
- [ADR-004: Event-driven cache invalidation](adrs/ADR-004-invalidation-via-events.md)
- [ADR-005: Observability standards and SLOs](adrs/ADR-005-observability-and-slos.md)

---

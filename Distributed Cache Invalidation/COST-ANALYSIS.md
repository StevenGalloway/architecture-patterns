# Cost Analysis — Distributed Cache Invalidation

## Cost Drivers

Distributed cache invalidation adds cost across four dimensions:

| Dimension | Description |
|---|---|
| **Message bus infrastructure** | NATS JetStream or Kafka cluster — compute and storage for message durability and consumer group tracking |
| **Redis cluster** | Already deployed for L2 cache; invalidation adds minimal overhead (DEL operations are cheap) |
| **Network traffic** | Invalidation events are small (~200–500 bytes each) but high-frequency; cost is negligible at small scale, measurable at large scale |
| **Engineering complexity** | Debugging invalidation gaps is expensive in engineer time — stale data incidents are silent and hard to trace |

The dominant cost driver at most scales is the message bus. The dominant risk driver is the engineering time cost of silent invalidation failures.

---

## Option Comparison at Three Traffic Tiers

### Tier 1: Small (8 API instances, <10K writes/day)

This is the baseline scenario: 8 product API instances, flash sale price changes, out-of-stock status updates.

| Component | Monthly Cost | Notes |
|---|---|---|
| NATS JetStream (3-node cluster, t3.small or ECS Fargate) | $90–$150 | 3-node for HA; JetStream storage for durable replay |
| Redis r7g.large (L2 cache) | Already deployed | Invalidation adds DEL operations — negligible cost increment |
| Invalidation events (~50KB/day × 30 days) | < $1 | NATS JetStream storage is cheap at this volume |
| **Total incremental monthly cost** | **$90–$150** | |

**Rejected alternative — Redis pub/sub ($0 additional):** Redis pub/sub adds no infrastructure cost because Redis is already deployed. Rejected in ADR-001 because pub/sub has no durability — events published when a subscriber is restarting are permanently lost. A rolling deploy of API instances causes a gap window where invalidation events are missed and stale data persists until TTL expiry.

**Rejected alternative — TTL-only (no invalidation infrastructure):** $0 additional infrastructure cost. Rejected because 60-second TTL causes 6–9× more cache misses than invalidation-backed TTL for the same consistency guarantee. The database cost of serving those misses at scale eliminates any infrastructure savings.

---

### Tier 2: Medium (50 API instances, 100K writes/day)

| Component | Monthly Cost | Notes |
|---|---|---|
| NATS JetStream (3-node cluster, m5.large or equivalent) | $300–$500 | Higher throughput; message retention for replay during consumer outages |
| Redis cluster (already deployed) | Already deployed | Invalidation event processing adds ~5% additional Redis command volume |
| L1 cache benefit | –$800 to –$1,200 | L1 absorbs ~70% of Redis queries; this translates to a smaller Redis tier requirement |
| **Net monthly impact** | **Neutral to positive** | Redis tier savings offset or exceed NATS cost |

The L1 cache benefit is the key insight at this tier: without L1 per-instance caching backed by invalidation, every request must hit Redis. With L1 + invalidation, Redis sees roughly 30% of the total request volume. At 50 instances handling meaningful traffic, the Redis tier needed to support L2-only caching is substantially larger than what's needed when L1 absorbs the majority of reads.

---

### Tier 3: Large (200+ instances, 1M+ writes/day)

| Component | Monthly Cost | Notes |
|---|---|---|
| Kafka MSK (3-broker, kafka.m5.large) | $800–$2,000 | NATS is replaced by Kafka at this throughput; CDC integration requires Kafka |
| CDC infrastructure (Debezium + connector) | $200–$400 | Eliminates need for write services to publish events manually |
| Redis cluster (scaled for 200+ instances) | $2,000–$5,000 | L1 cache across 200 instances reduces Redis cluster requirements significantly |
| Invalidation infrastructure total | **$1,000–$2,400/month** | NATS/Kafka + CDC |
| L1 cache benefit (database load reduction) | **–$10,000 to –$20,000/month** | L1 across 200 instances prevents database saturation that would require vertical scaling or read replicas |
| **Net impact** | **Strongly positive** | Invalidation infrastructure pays for itself 5–10× over in database cost avoidance |

At this scale, the alternative to invalidation is not a cheaper architecture — it is a database tier sized to handle 200× the query volume, or a read replica fleet to absorb the load. Both are substantially more expensive than the invalidation infrastructure.

---

## Break-Even Analysis

**Without L1 invalidation:** every request must hit L2 Redis. With a 500K request/day fleet:
- L2 Redis round-trip: 1–3ms per request
- At 500K requests/day, this is 500K Redis commands/day — manageable at small scale

**With L1 invalidation:** L1 serves ~80% of requests (400K/day) at <0.1ms per request. Redis sees ~100K commands/day.

| Metric | L2-only | L1 + L2 + Invalidation |
|---|---|---|
| Redis commands/day | 500K | 100K |
| Average cache read latency | 1–3ms | <0.1ms (L1 hit) / 1–3ms (L2 hit) |
| P99 cache read latency | 5–10ms | 0.5ms (L1 hit) / 5–10ms (L2 hit) |
| Redis tier required | r7g.xlarge | r7g.large |
| Monthly Redis savings | — | ~$150–300 |

The compute cost of Redis round-trips at scale, and the Redis tier needed to sustain them, easily exceeds the NATS infrastructure cost. **Break-even occurs at approximately 50K requests/day for a single service; at higher volumes, the L1 cache benefit dominates.**

---

## Hidden Costs

These costs are real but do not appear in infrastructure billing:

| Cost | Description | Estimated Impact |
|---|---|---|
| **Consumer lag monitoring** | Requires NATS consumer lag metrics, alerting rules, and dashboard setup | 2–4 days of platform engineering time to instrument correctly |
| **Stale data incident response** | Invalidation failures are silent; diagnosing "why is this customer seeing old data?" requires correlating consumer lag, eviction timestamps, and NATS delivery logs | 2–4 engineer-hours per incident; 1–3 incidents/month in poorly governed deployments |
| **Key namespace migration** | When the key schema changes (ADR-002), all existing keys must be invalidated simultaneously. This triggers a thundering herd on the origin database as all instances miss cache for the same entities simultaneously | 1 planned migration window + temporary database capacity increase |
| **Event schema evolution** | Adding fields to invalidation events requires coordinating consumer updates before schema changes are deployed | 0.5–1 day per schema change across all consuming teams |

---

## Cost Anti-Patterns

**1. Publishing invalidation events for data that doesn't need sub-TTL freshness**

If a piece of data changes once per day and the TTL is 60 seconds, the inconsistency window is at most 60 seconds with no invalidation infrastructure at all. Publishing invalidation events for this data adds message bus load without meaningful business benefit. Reserve invalidation for data where the inconsistency window matters: pricing, availability, permissions.

**2. Using Kafka when NATS would suffice**

Kafka MSK is 3–5× more expensive to operate than a NATS JetStream cluster for invalidation workloads. NATS provides durable delivery, consumer groups, and replay — everything invalidation requires. Kafka is justified only when you are also using Kafka for other purposes (CDC, event streaming) and adding invalidation topics is incremental cost rather than net new infrastructure.

**3. Not batching invalidation events for bulk writes**

A bulk price update touching 1,000 products should publish one invalidation event with 1,000 keys, not 1,000 individual events. Individual events create 1,000 NATS publishes, 1,000 × N consumer acknowledgments (where N = number of API instances), and 1,000 × N Redis DEL operations. A batched event is one publish, N consumer acknowledgments, and N × 1,000 DEL operations in a pipeline — the same Redis work at a fraction of the message bus cost.

**4. Underestimating the engineering cost of silent failures**

The cheapest invalidation architecture is no invalidation — but stale data incidents are not cheap. Each incident requires cross-team coordination (which write service published the event? which consumer missed it?), log correlation across multiple services, and a post-mortem. At two incidents per month at four hours per incident across three engineers, the recurring engineering cost is ~$5,000–10,000/month at typical senior engineer rates. The $120/month NATS cluster is not the expensive part.

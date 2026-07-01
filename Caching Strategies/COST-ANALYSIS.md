# Cost Analysis — Caching Strategies

## Cost Drivers

Caching infrastructure costs fall across four dimensions, each with a different scaling behavior:

| Dimension | What drives cost | Scaling behavior |
|---|---|---|
| **Memory** | Redis is memory-bound, not CPU-bound. You pay for GB provisioned. | Linear with dataset size |
| **Data transfer** | Egress from cache to application servers (~$0.09/GB on AWS within-region; cross-region is 2-4×) | Linear with read throughput |
| **Operational overhead** | Eviction policy tuning, hotkey analysis, TTL audits, incident response for stampedes | Sub-linear with scale; mostly fixed platform team cost |
| **Licensing** | Redis OSS ($0) vs. Redis Enterprise vs. ElastiCache vs. Upstash varies significantly | Depends on feature requirements |

Redis pricing is fundamentally different from compute pricing: a 64GB Redis instance costs roughly the same whether it handles 10K or 500K requests per second, because throughput is bounded by network before memory. Size for memory, not request rate.

---

## Option Comparison at Three Traffic Tiers

### Tier 1 — Small (< 10GB working set, < 50K req/sec)

| Option | Specs | Monthly cost | Notes |
|---|---|---|---|
| **AWS ElastiCache r7g.large** | 13.07GB RAM, 1 primary + 1 replica | ~$122 | Managed HA, automated failover, no ops overhead |
| **Upstash Redis** | Pay-per-request, $0.2/100K commands | ~$10–$40 | Best for < 10M commands/month; spiky workloads |
| **Self-hosted Redis on EC2 t3.medium** | 4GB RAM, manual HA setup | ~$35–$70 | Add 0.05–0.1 FTE ops cost; not recommended for < 10 services |
| **Valkey on EC2 (Redis OSS fork)** | 4GB RAM | ~$35–$70 | Same economics as self-hosted; avoids Redis BSL license concerns |

At this tier, ElastiCache is typically the correct choice once you factor in the engineer time avoided by not managing replication and failover manually.

### Tier 2 — Medium (10–100GB working set, 50K–500K req/sec)

| Option | Specs | Monthly cost | Notes |
|---|---|---|---|
| **AWS ElastiCache r7g.4xlarge** | 104.4GB RAM, 1 primary + 2 replicas | ~$980–$1,400 | Cluster mode for horizontal sharding if needed |
| **Redis Enterprise Cloud (AWS)** | 100GB, Active-Active disabled | ~$1,200–$1,800 | Adds Redis Modules (RediSearch, RedisJSON), dedicated support |
| **Self-hosted Redis cluster on EC2** | 3× r6g.2xlarge (52GB each) | ~$500–$700 infra | Add 0.15–0.25 FTE ops cost for maintenance and incidents |
| **GCP Memorystore (Standard)** | 100GB | ~$900–$1,100 | Comparable to ElastiCache; preferred if primary workload is on GCP |

At this tier, the decision hinges on whether you need Redis Modules (RediSearch for query-time filtering of cached results, RedisJSON for partial document caching). OSS Redis handles 95% of caching use cases; modules are worth the premium for specific workloads.

### Tier 3 — Large (100GB+ working set, 500K+ req/sec)

| Option | Specs | Monthly cost | Notes |
|---|---|---|---|
| **AWS ElastiCache cluster with 3 shards + 2 read replicas each** | 300GB+ effective capacity | ~$4,000–$8,000 | Standard architecture for high-throughput; scales horizontally |
| **Redis Enterprise Active-Active (geo-replicated)** | Multi-region, 200GB | ~$10,000–$15,000+ | Required for active-active multi-region with <100ms cross-region cache reads |
| **Self-hosted Redis cluster on dedicated hardware** | 8-node cluster | ~$2,000–$4,000 infra | Add 0.5 FTE dedicated ops; rarely the right choice vs. managed at this scale |

At this tier, Active-Active geo-replication is the differentiating decision. If your architecture requires cache reads in multiple regions without cross-region round trips, Redis Enterprise Active-Active is the only mainstream option. Evaluate this requirement before committing to tier.

---

## L1 Cache Break-Even Analysis

An in-process L1 cache (per-instance memory, LRU eviction, ~10K entries) reduces Redis query volume by 60–80% for hot-key workloads. This has a compounding effect on cost:

**Without L1 cache:** 500K req/sec → 500K Redis commands/sec → requires a large Redis cluster.

**With L1 cache (80% hit rate at L1):** 500K req/sec → 100K Redis commands/sec → a smaller Redis cluster handles the same traffic.

At the Tier 2 boundary (100K commands/sec), an L1 cache shifts the ElastiCache requirement from r7g.4xlarge (~$980/month) to r7g.xlarge (~$245/month) — a $735/month saving that far exceeds the memory overhead of the in-process cache. The engineering cost to implement a 200-line LRU cache pays back in 1–2 months.

**The catch:** L1 caches are per-instance. For write-heavy workloads or data that changes frequently, L1 cache introduces stale-read windows of up to the L1 TTL (typically 30–60 seconds). Don't apply L1 caching to data with strict freshness requirements.

---

## Serialization Format: Hidden Memory Cost

The serialization format for cached values directly impacts memory usage and therefore infrastructure cost:

| Format | Overhead vs. raw data | Serialization cost | Best for |
|---|---|---|---|
| **JSON (UTF-8)** | +30–60% size vs. binary | Low; language-native | Development convenience; readable in Redis CLI; debug-friendly |
| **MessagePack** | +5–15% vs. binary | Low; fast libraries available | Production default; compact binary JSON equivalent |
| **Protobuf** | Near wire-efficient | Medium; requires schema compilation | When you already have Protobuf schemas; enforces schema evolution |
| **Raw bytes (manual)** | 0% overhead | High; manual serialization | Only for extremely high-throughput hot keys where memory cost is the constraint |

Switching a 50GB Redis working set from JSON to MessagePack typically reclaims 15–25GB of memory, which can drop you one instance tier. At ElastiCache pricing, that's $200–$500/month saved from a serialization format change requiring ~1 week of engineering time.

---

## Hidden Costs

These don't appear in the instance pricing table but are often the deciding factor in total cost of ownership:

| Hidden cost | Description | Rough impact |
|---|---|---|
| **Thundering herd events** | Cache flush or mass TTL expiry causes all traffic to hit the database simultaneously. At 10K req/sec, a 30-second stampede generates 300K database queries that your RDS instance wasn't provisioned for. RDS scale-up to absorb this costs more than preventing it with stampede protection. | $0 normally; $1,000–$5,000 per major event in RDS overage or incident engineering hours |
| **Eviction storms under memory pressure** | When Redis memory exceeds `maxmemory`, the eviction policy runs. Under `allkeys-lru`, frequently-used keys get evicted alongside infrequent ones during rapid ingestion. Cache miss rate spikes, database load spikes. | Equivalent to a thundering herd — depends on scale |
| **Over-serialized large values** | Storing large composite objects (e.g., an entire product catalog page at 500KB) in Redis when only 5KB of that is read by the caller. Wastes memory and bandwidth. | 5–20× memory overhead; cascades to larger instance sizing |
| **Dev/staging Redis clusters** | Production Redis isn't the only Redis. Dev, staging, CI environments each need a Redis. At Tier 2 pricing, this triples infrastructure cost unless dev environments use a local Docker Redis or a shared, memory-limited staging cluster. | +50–200% of production cost if not actively managed |
| **Connection overhead** | Redis has a connection limit per instance. Running 50 service instances each with a connection pool of 10 = 500 connections. r7g.large supports 65,000 connections, but connection pool misconfiguration causes "too many clients" errors that look like Redis failures. | Operational incident cost, not direct infrastructure cost |

---

## Cost Anti-Patterns

**1. Caching large binary objects in Redis**
Redis memory costs $15–30/GB depending on instance tier. S3 costs $0.023/GB; a CDN serves the same content for $0.008–$0.02/GB. Caching images, PDFs, or video thumbnails in Redis is a $15–30/GB vs. $0.02/GB decision that always favors object storage. Redis should cache small, structured objects (<100KB per key) that benefit from sub-millisecond retrieval. Anything larger belongs in S3 or a CDN with an appropriate Cache-Control header.

**2. Caching at L2 (Redis) for data that never changes within a request**
Lookup tables, enum mappings, and configuration that is immutable between deployments do not need to go to Redis on every request. An L1 in-process cache with a 10-minute TTL (invalidated on deploy) handles this at zero infrastructure cost. Routing every lookup through Redis for data that changes once a week wastes bandwidth and connection budget.

**3. Over-wide TTLs that prevent memory reclamation**
Setting a 24-hour TTL on all keys because "freshness doesn't matter" fills Redis with stale data that eviction can't reclaim quickly during memory pressure. When memory hits `maxmemory` and eviction runs, it evicts recently-added useful keys alongside 23-hour-old stale keys. Size TTLs to match actual freshness requirements, not to maximize cache hits.

**4. One Redis cluster for all environments and all services**
Mixing production, staging, and CI traffic in one Redis cluster creates operational risk (a CI test that flushes the cache hits production), security risk (staging data accessible via same credentials), and cost attribution problems (impossible to know which team is consuming memory). Use separate clusters per environment at minimum; separate namespaces per service team within each environment.

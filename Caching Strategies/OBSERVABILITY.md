# Observability — Caching Strategies

## Why Observability Matters More for Caching

A cache failure is uniquely deceptive. Unlike a service outage, a cache regression does not produce errors — it produces latency degradation and increased database load that look exactly like a database performance problem. When a deploy causes cache hit rate to drop from 85% to 40%, the on-call engineer sees elevated database query latency, opens a database performance investigation, and finds nothing wrong with the database. The actual cause — a key schema change that silently invalidated the entire working set — is invisible without cache-specific instrumentation.

This means caching observability serves two purposes: detecting cache failures, and preventing cache failures from being misdiagnosed as something else.

**Without cache instrumentation**, the typical resolution path for a cache regression is: alert on database latency → investigate database → rule out database → investigate application → eventually check Redis → find the hit rate → identify the cause. Mean time to resolution: 2–4 hours.

**With cache instrumentation**, the path is: alert on hit rate drop → correlate with recent deploy → identify changed key schema → roll back or hotfix. Mean time to resolution: 15–30 minutes.

---

## Golden Signals Applied to Caching

### 1. Latency

| Metric | Target | Alert threshold |
|---|---|---|
| `cache.get.latency.p99` | < 1ms (L2 Redis, same AZ) | > 5ms sustained for 5 minutes |
| `cache.get.latency.p99` | < 0.1ms (L1 in-process) | > 0.5ms sustained for 2 minutes |
| `cache.miss.latency.p99` | < 50ms (end-to-end including origin fetch) | > 200ms sustained for 5 minutes |
| `cache.set.latency.p99` | < 2ms | > 10ms sustained for 5 minutes |
| `cache.lock.wait.p99` | < 50ms (stampede protection lock acquisition) | > 500ms: stampede in progress |

The delta between `cache.miss.latency.p99` and `cache.get.latency.p99` is the cost of a cache miss: the time to fetch from the origin. This should stay stable. If it grows, the origin (database, API) is degrading — not the cache.

### 2. Traffic

| Metric | What to measure |
|---|---|
| `cache.hit.rate` | Percentage of GET operations that return a value (target: > 80% steady state after 30-minute warm-up) |
| `cache.miss.rate` by key prefix | Which namespaces are missing most; new namespaces will have 0% hit rate initially — distinguish from regressions |
| `cache.eviction.rate` | Keys evicted per second; sustained high eviction = memory pressure; eviction during off-peak = misconfigured `maxmemory` |
| `cache.write.rate` | SET operations per second; spike in write rate often precedes a write amplification problem |
| `cache.key.expiry.rate` | Keys expiring per second; a sudden spike indicates many keys were set simultaneously (mass TTL expiry risk) |
| `cache.negative.hit.rate` | Percentage of lookups returning a cached "not found"; high rate may indicate PII leakage issue (see SECURITY.md) |

### 3. Errors

| Metric | What it signals |
|---|---|
| `cache.connection.errors.rate` | Redis unreachable or connection pool exhausted; if > 0.1%, falling back to database |
| `cache.timeout.rate` | Redis responding too slowly; commands exceeding configured timeout; network or CPU pressure |
| `cache.deserialization.errors.rate` | Cache values cannot be deserialized — caused by a deploy that changed the serialization schema without migrating existing keys |
| `cache.lock.timeout.rate` | Stampede protection locks that were not released within timeout; indicates a caller that acquired a lock and died |

The most insidious error is `cache.deserialization.errors.rate` rising after a deploy. The cache contains values serialized in the old schema; the new code cannot parse them. The service falls back to the database silently, database load spikes, and the symptom looks like a traffic increase. If the deserialization error rate is not instrumented, this takes hours to diagnose.

### 4. Saturation

| Metric | Target | Alert threshold |
|---|---|---|
| `cache.memory.used_bytes / cache.memory.max_bytes` | < 70% steady state | > 75%: page; > 85%: wake on-call — eviction storm imminent |
| `cache.connected_clients` | < 60% of connection limit | > 80% of connection limit: connection pool configuration issue |
| `cache.keyspace.size` by namespace | Track over time | Unusual growth rate: key leak (keys created but not expired or evicted) |
| `cache.blocked_clients` | 0 in normal operation | > 0 for > 30 seconds: a blocking command is running (KEYS, SORT on large set) |
| `cache.replication.lag` | < 100ms for async replication | > 1000ms: replica is falling behind; read-from-replica workloads will see stale data |

---

## SLI / SLO Definitions

### Cache Availability SLO

**SLI:** Percentage of cache GET operations that return within 5ms (either a hit or a miss decision, not including origin fetch).

```
SLI = count(cache.get.latency < 5ms) / count(cache.get.total)
```

**SLO:** 99.9% of cache GET operations return within 5ms, measured over a rolling 24-hour window.

Error budget: 99.9% = 86.4 seconds of budget per day. A Redis restart takes ~5–10 seconds; this means approximately 8–17 restarts per day are within budget — more than enough for rolling deployments.

### Cache Hit Rate SLO

**SLI:** Percentage of cache GET operations that return a cached value (hit rate), measured over a 24-hour rolling window after excluding the first 30 minutes of a new deployment (warm-up period).

```
SLI = count(cache.get.result = "hit") / count(cache.get.total)
      [excluding first 30 minutes after each deployment]
```

**SLO:** > 80% hit rate over the 24-hour rolling window for each active namespace.

A hit rate SLO is unusual — most SLOs cover availability and latency. A cache hit rate SLO is justified because a hit rate below 80% means the cache is not actually absorbing load; it means we are paying for Redis infrastructure without getting the primary benefit.

---

## Structured Log Schema for Cache Events

Every cache operation produces a structured log entry for debugging and audit:

```json
{
  "timestamp": "2025-11-26T14:23:01.482Z",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "service": "orders-service",
  "operation": "get",
  "key_prefix": "acme_corp:orders:order",
  "key_hash": "sha256:8a4f2b1c...",
  "result": "hit",
  "latency_ms": 0.8,
  "ttl_remaining_seconds": 247,
  "tier": "L2",
  "evicted": false,
  "error": null,
  "cache_version": "orders-service@v2.4.1"
}
```

**Deliberately excluded from logs:** the full cache key (may contain tenant ID — use key_prefix + key_hash for correlation without exposing enumerable IDs), the cached value (may contain PII), the full error message if it contains a cache value.

`cache_version` records the deploying service version. This allows correlating hit rate drops to specific deploys by joining cache miss logs with deployment events.

---

## Key Dashboards

### 1. Cache Health Dashboard (operational, always-on)

Panels:
- Cache hit rate by namespace (last 1 hour, 1 day, 7 days)
- Cache eviction rate (last 1 hour) with memory utilization overlay
- P99 GET latency by tier (L1 and L2 separate panels)
- Connection count vs. connection limit
- Top 10 most-missed key prefixes (helps identify warming opportunities)

### 2. Cache Miss Analysis Dashboard (incident response, post-deploy)

Panels:
- Hit rate before vs. after each deploy (auto-annotated with deploy events)
- Miss rate breakdown by namespace and key prefix
- Deserialization error rate (leading indicator of schema migration issues)
- Miss latency distribution (origin fetch times — identifies database pressure caused by cache misses)

### 3. Stampede Detection Dashboard (performance engineering)

Panels:
- Concurrent miss count per key prefix (> 5 concurrent misses on the same key = potential stampede)
- Distributed lock acquisition rate and wait time
- Lock timeout rate (indicates lock holders that died)
- Cache write rate vs. hit rate (sudden write rate increase after a period of high hit rate = TTL mass expiry)

---

## Chaos Engineering Scenarios

Run these quarterly in staging, and once before any major traffic event (product launch, sale):

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Redis node failure** | Terminate primary Redis node | Automated failover to replica within 30 seconds; requests during failover fall back to database | Zero 5xx errors; latency spike < 60 seconds; hit rate recovers to >80% within 5 minutes of failover |
| **Cache flush (FLUSHDB)** | Execute FLUSHDB on production-equivalent staging cache | Thundering herd: all requests miss cache and hit database simultaneously | Database connection pool does not exhaust; circuit breaker activates before database falls over; cache warms back to >80% hit rate within 10 minutes |
| **Memory pressure causing evictions** | Set `maxmemory` to 50% of current used; observe evictions | Eviction rate increases; hit rate drops; LRU policy evicts least-recently-used keys | Hit rate drop < 20 percentage points; most-frequently-accessed keys remain in cache; alert fires on memory utilization > 75% |
| **TTL mass expiry** | Seed 10,000 keys with identical TTL; wait for expiry | Simultaneous expiry causes spike in miss rate and database load | Stampede protection distributes origin fetch load; database query rate does not spike > 3× baseline |
| **Deploy with schema change** | Deploy a version that changes key serialization format without migration | Old cached values cannot be deserialized by new code; miss rate spikes | `cache.deserialization.errors.rate` alert fires within 2 minutes; fallback to database occurs; no 5xx errors to users |
| **Network partition (Redis unreachable)** | Block traffic to Redis from application layer | Cache client activates circuit breaker; all requests fall back to database | Circuit breaker fires within 5 seconds; database handles fallback load within headroom; Redis reconnection is automatic when partition heals |

---

## Alerting Philosophy

**Page on (wake someone up):**
- `cache.memory.used_bytes / cache.memory.max_bytes > 85%` for 5 minutes: eviction storm is imminent or in progress; TTL mass expiry will follow
- `cache.connection.errors.rate > 1%` for 2 minutes: Redis is unreachable; falling back to database at scale is a database reliability incident

**Notify (Slack/email, no page):**
- `cache.hit.rate < 60%` from a baseline > 80% for 1 hour: significant regression, but system is stable; investigate during business hours unless traffic is actively spiking
- `cache.deserialization.errors.rate > 0.1%` for 5 minutes: schema migration issue after a deploy; usually self-resolves as keys expire but may indicate an urgent schema rollback
- `cache.get.latency.p99 > 5ms` for 10 minutes: Redis is slower than expected; may indicate CPU pressure, memory fragmentation, or network congestion
- `cache.replication.lag > 500ms` for 5 minutes: replica is falling behind; read-from-replica workloads may see stale data

**Do not alert on:**
- Individual cache misses (expected and normal behavior)
- Hit rate below 80% during the first 30 minutes after a deployment (warm-up period)
- Occasional evictions (expected under any `maxmemory` configuration)
- Redis connection establishment (alert only on sustained connection error rate, not on reconnect events)

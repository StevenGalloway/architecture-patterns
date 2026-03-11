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
- “hot keys” cause thundering herds and stampedes
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

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-cache-aside-and-swr-sequence.mmd`
- `diagrams/03-tiered-cache-and-invalidation.mmd`

## ADRs
- `adrs/ADR-001-adopt-cache-aside.md`
- `adrs/ADR-002-swr-and-stampede-protection.md`
- `adrs/ADR-003-key-design-and-ttl-policy.md`
- `adrs/ADR-004-invalidation-via-events.md`
- `adrs/ADR-005-observability-and-slos.md`

---

## Example (Different Tech)
**Python + FastAPI + Redis + Postgres**:
- cache-aside for `GET /products/{id}`
- negative caching for missing items
- SWR + distributed lock (SETNX + TTL) to avoid stampedes

See `examples/python-fastapi-redis-postgres/`.

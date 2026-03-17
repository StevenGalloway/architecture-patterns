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
- Systems where “eventual consistency within seconds” is acceptable

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

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-invalidation-sequence.mmd`
- `diagrams/03-l1-l2-ttl-and-versioning.mmd`

---

## ADRs
- `adrs/ADR-001-pubsub-for-invalidation.md`
- `adrs/ADR-002-key-scheme-and-tenant-safety.md`
- `adrs/ADR-003-evict-on-write-policy.md`
- `adrs/ADR-004-ttl-and-versioned-keys.md`
- `adrs/ADR-005-observability-and-runbooks.md`

---

## Example (Different Tech)
This example uses **Node.js 20 + Express + Redis + NATS + Postgres**:
- Two API instances (`api-a`, `api-b`) with:
  - L1 in-memory cache (per instance)
  - L2 Redis cache (shared)
- Writes publish invalidation events over **NATS**
- All instances subscribe and evict L1+L2 consistently

See `examples/node-express-redis-nats-postgres/`.

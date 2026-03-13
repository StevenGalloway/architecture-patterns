# ADR-001: Use Pub/Sub for distributed cache invalidation

## Status
Accepted

## Date
2026-01-11

## Context
Multiple API instances maintain local (L1) caches and shared (L2) cache entries. Without coordination, writes lead to stale reads.

## Decision
Use **Pub/Sub** to broadcast invalidation events containing the affected cache keys. All instances subscribe and evict L1 and L2 accordingly.

## Consequences
- low-latency propagation of cache coherency actions
- requires messaging availability; may need durability for stricter freshness guarantees

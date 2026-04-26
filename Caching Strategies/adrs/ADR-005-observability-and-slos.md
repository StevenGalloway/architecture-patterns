# ADR-005: Instrument cache metrics and define SLOs

## Status
Accepted

## Date
2025-12-17

## Context
Three months after the caching layer was deployed across Catalog, Pricing, and Inventory services, we had no systematic visibility into whether the cache was working as intended. An on-call incident was triggered by high database CPU, and during triage it became clear that the Catalog service's cache hit rate had dropped from an expected 85% to under 40% -- caused by a key naming change in a deployment that inadvertently incremented the schema version without migrating existing keys. The cache was effectively cold, and the database was absorbing the full request load.

The incident took 45 minutes to diagnose because cache hit rate was not instrumented as a monitored metric. The database CPU alert had fired, but the root cause (cold cache) was identified only by manually querying Redis keyspace statistics.

A second, less critical issue: nobody knew the actual latency distribution for cache reads. Anecdotal evidence suggested Redis reads were consistently under 5ms, but there were no measurements to confirm this or catch a regression.

## Decision
The following metrics are instrumented for each service that uses the cache layer:

**Hit/miss:** `cache.hit` and `cache.miss` counters by `entity_type` and `endpoint`. Hit ratio calculated as a derived metric. Alert if hit ratio falls below 70% for a 5-minute window for any entity_type where the expected hit ratio is 80%+.

**Read latency:** `cache.read.latency_ms` histogram by `entity_type`. p95 and p99 aggregations. Alert if p99 exceeds 10ms over a 5-minute window.

**Write latency:** `cache.write.latency_ms` histogram. Alert if p99 exceeds 20ms.

**Evictions:** `cache.evictions.count` from Redis info stats, tracked as a rate. Sudden eviction rate increases indicate memory pressure and potential cache thrashing.

**Stale-serve rate:** `cache.stale_served.count` from the SWR path. Rate should be low and predictable; a spike indicates the origin is slower than expected or background revalidation is failing.

**Redis errors:** `cache.redis_error.count` by error type (connection timeout, command timeout, authentication). Any Redis error triggers an immediate alert.

**SLO definition per entity type:**
- Product catalog reads: p99 < 8ms (cache hit path), hit ratio > 80%
- Inventory reads: p99 < 6ms, hit ratio > 75%
- User profile reads: p99 < 10ms, hit ratio > 85%

Cache layer SLOs are tracked in the same dashboard as service-level SLOs and included in the monthly SLO review.

## Alternatives Considered

**Redis server-side metrics only (INFO stats, Redis Insights):** Rely on Redis-native monitoring rather than application-side instrumentation. Rejected because Redis server-side metrics aggregate across all keys and all consumers; they do not distinguish which service or entity type is causing a metric change. Application-side instrumentation provides the per-entity-type attribution needed for triage.

**Sampling-based tracing instead of counters:** Use distributed tracing (OpenTelemetry) to capture a sample of cache operations rather than counting all of them. Rejected for hit ratio and error rate: these need to be counted, not sampled, because a low-frequency error that affects only 0.1% of requests would not appear reliably in a 1% sample.

**Manual cache diagnostics tooling (CLI scripts):** On-call engineers run Redis keyspace queries manually when they suspect cache issues. This was the pre-instrument approach and it failed during the incident that motivated this ADR. Proactive monitoring is required; reactive manual investigation is insufficient.

## Consequences

### Positive
- A cold cache caused by a deployment key-naming change now produces an alert within 5 minutes rather than manifesting as a database CPU incident after 45 minutes
- Per-entity-type hit ratio visibility allows targeted investigation (which entity type is missing, which recent deployment correlated with the change)
- The error budget from cache SLOs provides a quantitative basis for evaluating whether a proposed TTL reduction is acceptable

### Negative
- Every cache read and write increments counters and records a histogram sample, adding a small overhead to each operation. In load testing this overhead measured at under 0.2ms per operation.
- Alert thresholds require calibration for each entity type; a single threshold for all entity types would generate false positives for entity types with naturally lower hit ratios

### Risks
- **Alert fatigue from threshold miscalibration during traffic pattern changes.** A new product launch that adds many new products to the catalog may temporarily lower the hit ratio as new keys are warmed. Mitigation: alert thresholds can be temporarily adjusted during planned traffic events, and the runbook includes guidance for distinguishing "cold cache during expected traffic change" from "cache regression."

## Review Trigger
Revisit if the team migrates from Redis to a different cache backend (Memcached, DragonflyDB), which may require updated client-side metric instrumentation. Revisit SLO thresholds quarterly using the previous quarter's p-value data to ensure thresholds reflect current performance baselines.

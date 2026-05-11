# ADR-005: Observability, alerts, and runbooks for invalidation

## Status
Accepted

## Date
2026-01-21

## Context
The distributed cache invalidation system has multiple components that can fail independently: the write service's invalidation event publishing, the NATS JetStream delivery, each API instance's subscription and L1 eviction, and the direct L2 Redis deletion. A failure in any one component can cause stale data to be served without any immediately visible signal in existing monitoring.

During a NATS configuration change that inadvertently dropped the `cache.invalidation` subscriber group, the API instances stopped receiving invalidation events. The NATS connection remained healthy from the application's perspective (the subscriber was connected but in a broken consumer group state). The cache continued serving increasingly stale data for promotional pricing for approximately 55 minutes before a customer support escalation revealed the problem.

The failure was not visible in any existing dashboard. The API instances' error rates were zero (cache hits are not errors). The NATS connection health metric showed healthy. The specific metric that would have detected the problem -- that invalidation events were being published but not being consumed -- did not exist.

## Decision
The following metrics and alerts are instrumented for the cache invalidation system:

**Publish-side metrics (emitted by write services):**
- `cache.invalidation.published.count` per entity_type: events successfully published to NATS
- `cache.invalidation.publish_failures.count` per entity_type: events that failed to publish after retries

**Consume-side metrics (emitted by API instances):**
- `cache.invalidation.received.count` per instance: events received from NATS subscription
- `cache.invalidation.processed.count` per instance: events processed (keys evicted)
- `cache.invalidation.subscriber_errors.count` per instance: NATS subscriber reconnection or consumer group errors

**Cache health metrics:**
- `cache.hit_ratio` per entity_type and tier (L1/L2): hit rate over 5-minute windows
- `cache.stale_serve.count` per entity_type: serves from the stale TTL window (SWR path)
- `cache.eviction.count` per entity_type: keys evicted due to pub/sub events vs. TTL expiry

**Alert thresholds:**
- Alert if `cache.invalidation.received.count` drops below 50% of `cache.invalidation.published.count` over any 5-minute window (indicating subscribers are not receiving events)
- Alert if `cache.invalidation.subscriber_errors.count` exceeds 0 for any instance (NATS subscription health issue)
- Alert if `cache.hit_ratio` for pricing data drops below 60% for more than 3 minutes (potential cold cache or excessive invalidation)
- Page if `cache.invalidation.publish_failures.count` exceeds 10 in any 5-minute window for pricing data (write service cannot invalidate the cache after writes)

**Runbooks maintained:**
1. How to flush a cache namespace safely (by key pattern) without causing a database overload
2. How to diagnose NATS subscriber group failures (the failure mode from the 55-minute incident)
3. How to verify invalidation propagation across all API instances (test procedure)
4. How to perform an emergency full cache flush (last resort for widespread stale data)

## Alternatives Considered

**Log-based monitoring (parse application logs for invalidation events):** Detect issues by parsing structured application logs rather than dedicated metrics. Rejected because log shipping and aggregation adds 1-3 minutes of delay before anomalies appear in dashboards, and the 55-minute incident demonstrated that even a 10-minute detection window is unacceptable for pricing data staleness.

**Synthetic cache coherency tests:** A scheduled synthetic test writes a known value to the database, waits for the cache to update via invalidation, and verifies the cache reflects the new value. Provides an end-to-end test of the invalidation chain. Adopted as a complement: a synthetic test runs every 5 minutes for pricing data. Not used as a replacement for metric-based monitoring because synthetic tests fire at low frequency and may miss brief invalidation gaps between tests.

**Application-level staleness detection (read-your-writes):** After a write, the write service reads the cached value and alerts if it still returns the old value after the expected propagation delay. Rejected as a primary monitoring mechanism because it requires the write service to know the exact cache key for the data it just wrote, which is not always straightforward for derived or aggregated cache entries.

## Consequences

### Positive
- The specific failure mode from the 55-minute incident (subscriber not receiving events) is now detected within 5 minutes by the publish-vs-receive count comparison alert
- NATS subscriber errors generate immediate alerts, alerting on connection health issues before they affect cache coherency
- The synthetic coherency test provides an end-to-end validation that complements metric-based monitoring

### Negative
- The publish-vs-receive count comparison requires that publish-side and consume-side metrics are aggregated and compared in the same alerting system; cross-service metric correlation adds dashboard complexity
- The emergency full cache flush runbook requires careful execution to avoid a database overload from simultaneous cache misses across all instances; it is a last-resort procedure, not a standard operational tool

### Risks
- **Metrics emission failure during cache invalidation failure.** If the same infrastructure issue that causes cache invalidation failures also affects metrics emission (e.g., a network partition that affects both NATS and the metrics pipeline), the alerts may not fire even though the invalidation system is failing. Mitigation: the synthetic coherency test uses a separate HTTP polling mechanism, not the same transport as the metrics pipeline.

## Review Trigger
Revisit alert thresholds after any change to the NATS infrastructure or after a scaling event that changes the number of API instances (which affects the expected publish-to-receive multiplier).

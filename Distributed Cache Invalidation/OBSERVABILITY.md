# Observability — Distributed Cache Invalidation

## Why Observability Is Uniquely Important Here

Cache invalidation failures are silent by design. A missed invalidation event does not produce an error — it produces a stale cache hit that looks exactly like a fresh cache hit in every standard metric. Requests succeed. Response times are fast. Error rates are zero. A standard monitoring dashboard shows a healthy system while customers see wrong prices.

Without specific instrumentation for invalidation health, the discovery path for a missed invalidation is:

1. A user or business analyst reports data inconsistency
2. Engineering investigates whether the issue is a data bug, a caching bug, or an invalidation bug
3. Without invalidation-specific logs and metrics, this investigation spans multiple services, log formats, and time ranges
4. Average time to diagnosis: 2–4 hours

With the instrumentation described in this document, the discovery path is:

1. Consumer lag alert fires within seconds of a consumer falling behind
2. On-call identifies which instance or consumer group is affected
3. Runbook points to the correct remediation (reconnect, replay, or TTL-bound wait)
4. Average time to diagnosis: under 10 minutes

The investment in invalidation observability has a higher return per dollar than almost any other observability work in the caching stack.

---

## Golden Signals Applied to Cache Invalidation

### 1. Latency

| Metric | Description | Alert threshold |
|---|---|---|
| `invalidation.event.publish_to_consume_latency_ms` | Time from event publish timestamp to each consumer completing L1 and L2 eviction. Tracked as a histogram per entity type. | p99 > 500ms |
| `invalidation.eviction.l1.duration_ms` | Time to complete L1 eviction on a received event, per instance. Should be <1ms — high values indicate L1 eviction lock contention. | p99 > 5ms |
| `invalidation.eviction.l2.duration_ms` | Time to complete Redis DEL on a received event, per instance. Reflects Redis cluster health. | p99 > 20ms |
| `invalidation.event.age_at_consume_ms` | Age of event when first consumed, from JetStream message timestamp. Reveals consumer backlog even when lag count is low. | p99 > 200ms |

The `publish_to_consume_latency_ms` metric requires clock synchronization across instances (NTP with <10ms drift) and structured logging of both the publish timestamp (from the write service) and the consume timestamp (from the cache consumer). Both timestamps are included in the structured log schema below.

### 2. Traffic

| Metric | Description |
|---|---|
| `invalidation.events.published.rate` | Events published per second, by entity type (product, user, pricing). Baselines by entity type during business hours. Unexpected spikes indicate bulk writes or runaway publish loops. |
| `invalidation.events.consumed.rate` | Events consumed per second, per instance. Should match published rate × number of consumer instances. Divergence indicates consumer lag or dropped events. |
| `invalidation.keys.evicted.l1.rate` | L1 cache key evictions per second, by entity type. Distinguishes TTL expiry evictions from invalidation-triggered evictions (via `eviction_reason` label). |
| `invalidation.keys.evicted.l2.rate` | Redis DEL operations per second issued by invalidation consumers. Compare against Redis keyspace notifications to verify completeness. |
| `invalidation.events.batch_size` | Distribution of keys per invalidation event. A batch size of 1 for every event from a bulk write operation indicates missing event batching (see COST-ANALYSIS.md anti-patterns). |

### 3. Errors

| Metric | Description | Alert threshold |
|---|---|---|
| `invalidation.consumer.lag` | Pending messages in the NATS JetStream consumer group, per instance. The most important single metric for invalidation health. | Alert: > 1,000 events. Page: > 5,000 events. |
| `invalidation.publish.failures.rate` | Rate of failed NATS publish attempts. A write service that cannot publish means invalidation events are silently dropped. | Page: > 0.1% for 5 consecutive minutes |
| `invalidation.deserialization.errors.rate` | Rate of events received that fail JSON deserialization or schema validation. Spikes after deploys indicate event schema mismatch between producer and consumer versions. | Alert: any sustained rate > 0 |
| `invalidation.l2.delete.failures.rate` | Rate of Redis DEL failures during invalidation processing. A high rate means L1 is evicted but L2 retains the stale key. | Alert: > 0.01% |
| `cache.stale_serve.estimated.rate` | Estimated rate of stale cache serves — detected when the same key is requested within the TTL window after a confirmed successful invalidation of that key. This is an imperfect signal (not all re-hits are stale) but identifies patterns. | Notify: sustained > 0 for same key pattern |

### 4. Saturation

| Metric | Description | Alert threshold |
|---|---|---|
| `nats.jetstream.storage.utilization_percent` | JetStream file storage used vs. capacity. If NATS runs out of storage, new messages are dropped or oldest messages are evicted before consumers have processed them. | Alert: > 70% |
| `nats.consumer.pending_messages` | Messages pending acknowledgment across all consumer groups. A growing count indicates consumers are not keeping up with the publish rate. | Alert: > 10,000 |
| `redis.eviction.rate` | Keys being evicted from Redis due to memory pressure (`maxmemory-policy`). If Redis is evicting keys due to memory pressure, invalidation events arrive for keys that no longer exist — not an error, but a signal that the L2 cache is undersized relative to working set. | Alert: > 0 sustained (Redis should not be evicting for cache-allocated memory) |
| `l1.cache.size_entries` | Current L1 entry count per instance. Approaching `max_entries` (10,000) means LRU is actively evicting entries; invalidation events for recently-evicted keys are no-ops. | Notify: > 9,000 per instance |

---

## SLI / SLO Definitions

### Invalidation Propagation SLO

**SLI:** The 99th percentile of invalidation events propagates to all active consumer instances within 500ms of publication, measured from the JetStream message publish timestamp to the last instance's eviction completion timestamp.

**SLO:** 99.5% of invalidation events meet the 500ms propagation target over a rolling 28-day window.

**Error budget:** 0.5% error budget = approximately 3.6 hours of degraded propagation per month. A NATS brownout or rolling deploy that increases consumer lag for 30 minutes consumes 14% of the monthly error budget.

### Cache Coherence SLO

**SLI:** The percentage of cache reads for a given key that occur after a confirmed successful invalidation of that key and return stale data. Measured via a synthetic probe that writes a sentinel value, publishes an invalidation event, and immediately reads the key from each instance.

**SLO:** 0% stale reads after confirmed invalidation, measured by synthetic probe on a 30-second polling interval.

**Measurement methodology:** the synthetic probe is the only reliable way to measure this SLO because application-layer traffic cannot distinguish between a fresh cache hit and a stale one without knowing the ground truth value. The probe knows the ground truth because it wrote the value.

---

## Structured Log Schema

Every invalidation event produces a structured log entry at each consumer instance:

```json
{
  "timestamp": "2025-11-26T14:23:01.482Z",
  "log_type": "invalidation.processed",
  "event_id": "evt_01HX8Z4K...",
  "entity_type": "product",
  "entity_id": "456",
  "tenant_id": "tenant_123",
  "keys_invalidated_count": 3,
  "keys": ["prod:tenant_123:v2:product:456"],
  "publish_timestamp": "2025-11-26T14:23:01.101Z",
  "consume_timestamp": "2025-11-26T14:23:01.482Z",
  "propagation_latency_ms": 381,
  "instance_id": "api-instance-7",
  "l1_eviction_result": "success",
  "l1_keys_found": 1,
  "l2_delete_result": "success",
  "l2_keys_deleted": 1,
  "nats_sequence": 12847,
  "consumer_group": "product-api-invalidation"
}
```

**Key fields for incident investigation:**
- `propagation_latency_ms`: immediately shows if this event was slow to propagate
- `l1_keys_found`: if 0, the key was not in L1 (TTL had already expired or key was never loaded on this instance — not an error)
- `l2_delete_result`: if `key_not_found`, the key was already expired from Redis before invalidation arrived (TTL safety net worked correctly)
- `nats_sequence`: use to correlate with NATS server logs and identify gaps in sequence numbers (indicates dropped messages)

---

## Key Dashboards

### 1. Invalidation Pipeline Health (operational, always-on)

- Publish rate vs. consume rate by entity type (last 1 hour)
- Consumer lag per instance (last 1 hour; alert threshold lines at 1,000 and 5,000)
- Propagation latency p50 / p95 / p99 over time
- Publish failure rate
- Deserialization error rate (spikes reveal deploy-order issues)

### 2. Cache Coherence Monitor (data integrity)

- Synthetic probe results: pass/fail per instance over time
- Estimated stale serve rate by entity type
- Time since last successful invalidation per entity type (detects write service outage where no invalidation events are published)
- L1 vs. L2 eviction rate ratio (L1 rate should equal L2 rate within a small delta)

### 3. NATS Infrastructure Health (platform)

- JetStream storage utilization over time
- Pending message count per consumer group
- Message delivery rate vs. acknowledgment rate
- Consumer group list with last active timestamp (identifies abandoned consumer groups)

---

## Chaos Scenarios

Run these in staging on a quarterly cadence. Each scenario validates a specific aspect of the invalidation safety model:

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **NATS partition (2 of 3 nodes reachable)** | Network policy to isolate one NATS node | Consumers on affected instances fall back to TTL; JetStream durable consumer replays missed events on reconnect | Consumer lag alert fires within 60 seconds; stale data is bounded by TTL (max 60s L1, 5 min L2); no permanent data loss |
| **Single instance consumer failure** | Kill the NATS consumer goroutine/process on one API instance | Instance reconnects via JetStream durable consumer; missed events are replayed | Instance reconnects within 30 seconds; all missed invalidation events processed; no stale data after replay |
| **Bulk invalidation event (1,000 keys)** | Trigger a bulk product catalog update affecting 1,000 products | All instances process the batched event within SLO (< 500ms p99) | No instance timeout; all 1,000 keys evicted from L1 and L2 within 500ms; Redis pipeline used for L2 DEL batch |
| **Redis unavailable during invalidation** | Stop Redis while NATS delivers an invalidation event | L1 eviction completes; L2 DEL fails with error; error is logged and metriced; L2 TTL bounds staleness | `invalidation.l2.delete.failures.rate` metric fires; L1 eviction succeeds; stale data in L2 expires within TTL window (max 5 min) |
| **Write service publish failure** | Block the write service's NATS connection for 5 minutes | No invalidation events published; stale data bounded by TTL; publish failure alert fires | `invalidation.publish.failures.rate` alert fires within 60 seconds of first failure; stale data is bounded by L2 TTL |
| **Schema version mismatch** | Deploy a new invalidation event schema to the write service before updating consumers | Consumers receive events they cannot deserialize | `invalidation.deserialization.errors.rate` alert fires; events are NACK'd to NATS; message replays after consumer is updated; no permanent data loss |

---

## Alerting

**Page on-call when:**
- `invalidation.consumer.lag` exceeds 5,000 events on any instance (backlog growing faster than it's consumed; manual intervention may be required)
- `invalidation.publish.failures.rate` exceeds 0.1% for 5 consecutive minutes (write service cannot reach NATS; new data changes are not triggering invalidation)
- Synthetic coherence probe fails on 2 or more consecutive checks on the same instance (confirmed stale data being served)

**Notify (Slack alert, no page) when:**
- `invalidation.consumer.lag` exceeds 1,000 events on any instance (approaching page threshold; investigate proactively)
- Propagation latency p99 exceeds 200ms (approaching SLO boundary; not yet in violation)
- `invalidation.deserialization.errors.rate` is non-zero (indicates producer/consumer schema drift; likely a deploy-ordering issue)
- NATS JetStream storage utilization exceeds 70% (capacity planning signal)

**Do not alert on:**
- Individual `l1_keys_found: 0` events (expected when TTL expires before invalidation arrives — the key was already gone)
- `l2_delete_result: key_not_found` events (same — Redis TTL expired the key before the DEL command arrived)
- Consumer lag between 0 and 100 events (normal processing buffer during brief traffic spikes)
- Instance restart events (the durable consumer handles reconnect automatically; alert only if reconnect does not complete within 60 seconds)

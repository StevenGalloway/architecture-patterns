# Observability — CQRS Read Model Projection

## Why Projection-Specific Observability Is Required

In a single-database architecture, the consistency of your data is an assumption, not a signal. In CQRS, the consistency of your read models relative to the write side is a measured operational property — **projection lag** — and it is the primary metric that determines whether the system is functioning correctly.

A projector that is processing events correctly but is 60 seconds behind the write side is serving stale data to every consumer that depends on it. This is a correctness failure, not just a performance failure. Without lag monitoring, this situation is invisible until a user files a support ticket.

The golden signals for CQRS require adding a fifth dimension beyond the standard four: **consistency lag**, which is specific to this pattern and has no equivalent in single-database architectures.

---

## Golden Signals

### 1. Latency

| Metric | Description | Alert threshold |
|---|---|---|
| `projector.event_processing_latency_ms` by projector | Time from event timestamp (when the write occurred) to read model updated. This is the end-to-end consistency lag for a single event. | p99 > 5,000ms |
| `projector.lag_ms` by consumer group and read model | Difference between the timestamp of the latest event in the event bus and the timestamp of the last event processed by this consumer group. The primary operational health metric. | > 5,000ms for >60s |
| `projector.event_bus_consume_latency_ms` | Time from event availability on the bus to the projector beginning to process it. Isolates projector consumer throughput from write-side emission rate. | p99 > 500ms |
| `projector.read_model_write_latency_ms` by store type | Time to write the projection update to the read model store. Redis should be <2ms; PostgreSQL <10ms; Redshift <500ms. | Per-store baseline × 5 |
| `query_service.response_latency_ms` by consumer | End-to-end response latency on the query service. A sudden increase here, without a corresponding increase in projector lag, indicates a read model store problem rather than a projection problem. | Per-consumer SLO |

### 2. Traffic

| Metric | Description |
|---|---|
| `event_bus.publish_rate` | Events published per second by the command side. Spike in publish rate is a leading indicator of upcoming projector lag if projector throughput is near its limit. |
| `projector.consume_rate` by consumer group | Events consumed and processed per second by each projector. Should track closely with `event_bus.publish_rate` under steady state. Gap between publish rate and consume rate is lag growing in real time. |
| `query_service.request_rate` by consumer and read model | Read model query rate by consumer type (customer history, fulfillment, analytics). Sudden drops may indicate consumer-side availability issue or consumer routing away from the read model. |
| `projector.replay_event_rate` | Events per second during a replay operation. Used to monitor replay progress and detect if replay is contending with live projection. |
| `projector.idempotency_hit_rate` | Rate at which the idempotency store rejects duplicate events. A sustained high rate indicates the event bus is redelivering events at abnormal frequency (consumer group rebalance loop, DLQ replay in progress). |

### 3. Errors

| Metric | Description |
|---|---|
| `projector.processing_errors_total` by error_type | Total errors by category: `schema_mismatch` (event schema not matching registered version), `store_write_failure` (read model store unavailable or write rejected), `idempotency_conflict` (duplicate detection working as expected vs. genuine conflict), `signature_verification_failure` (event signing violation — see SECURITY.md). |
| `projector.dead_letter_queue_depth` by consumer group | Events that have failed all retry attempts. DLQ depth growing indicates a systematic processing failure, not transient errors. A DLQ depth > 100 is an alert condition. |
| `projector.dlq_event_types` | Distribution of event types in the DLQ. If 100% of DLQ events are `OrderStatusUpdated`, the problem is likely a schema change or a projection function bug specific to that event type. |
| `projector.replay_completion_rate` | Did the most recent replay complete successfully? Failed replays leave the read model in an inconsistent state. Alert on any replay failure. |
| `event_bus.publish_failure_rate` | Rate at which the command side fails to publish events. Events that fail to publish will never reach the projector. This is a silent data loss event — the write succeeds but the read model will not reflect it. Alert immediately. |

### 4. Saturation

| Metric | Description | Alert threshold |
|---|---|---|
| `projector.consumer_lag_offset` by topic partition | Kafka offset lag (or SQS approximate receive count). The raw event backlog count. Complements `projector.lag_ms` with a count-based view. | > 10,000 events backlog |
| `read_model_store.redis_memory_pct` | Redis memory utilization for fulfillment cache. Redis does not gracefully degrade at 100% — it evicts keys based on policy. Key eviction in the read model store means incomplete data served to consumers. | > 80% |
| `read_model_store.postgres_connection_pool_pct` | Connection pool utilization for history read model. The query service competes with the projector for connections. | > 75% |
| `projector.cpu_utilization` | CPU across projector instances. Sustained high CPU indicates the projector is approaching throughput limits. Scale out before lag grows. | > 70% for 10 min |
| `event_bus.publish_rate` vs `projector.consume_rate` | The ratio of these two metrics over a 5-minute window. Ratio > 1.2 (publish rate 20% higher than consume rate) means lag is growing. | Ratio > 1.2 for >5 min |

---

## SLI / SLO Definitions

### Projection Lag SLO (Primary)

**SLI:** Percentage of minutes in which p99 projection lag across all active read models is below 5 seconds.

```
SLI = minutes_with_p99_lag_under_5s / total_minutes
```

**SLO:** 99.5% over a rolling 28-day window (approximately 3.6 hours of budget per month).

**Rationale:** 5 seconds is the threshold defined in ADR-001, chosen based on the fulfillment dashboard's 30-second refresh interval (5 seconds of lag is imperceptible in a 30-second refresh cycle) and the customer history use case (a 5-second lag on order history is within user tolerance). The SLO is measured per read model — a single read model exceeding the threshold burns the budget for that read model's consumer.

### Read Model Availability SLO (Per Consumer)

| Consumer | SLO | Notes |
|---|---|---|
| Customer order history | 99.9% | Customer-facing; availability SLO matches the API availability SLO |
| Fulfillment dashboard | 99.5% | Internal tool; slight degradation acceptable |
| Analytics | 99.0% | Batch consumption; 1-hour outage acceptable with DLQ catch-up |

**SLI for availability:** Percentage of query service requests that return a non-5xx response within the per-consumer latency SLO.

### DLQ Depth SLO

**SLI:** DLQ depth remains below 100 events across all projector consumer groups.

**SLO:** DLQ depth < 100 at all times during business hours. During off-hours, alert if depth > 100 for more than 30 minutes (gives time for automated retries to resolve transient failures before paging).

---

## Structured Log Schema

Every event processed by the projector produces one structured log entry:

```json
{
  "timestamp": "2026-06-15T14:23:01.482Z",
  "log_type": "projection_event",
  "projector_name": "fulfillment-dashboard-v2",
  "consumer_group": "fulfillment-team.fulfillment-dashboard.v2",
  "event_id": "evt_01jx4k9m2n3p4q5r",
  "event_type": "OrderStatusUpdated",
  "event_schema_version": "2.1",
  "event_timestamp": "2026-06-15T14:23:01.124Z",
  "processing_latency_ms": 358,
  "lag_ms": 358,
  "read_model_write_latency_ms": 2,
  "idempotent_skip": false,
  "store_type": "redis",
  "status": "success",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

For errors, add:

```json
{
  "status": "error",
  "error_type": "store_write_failure",
  "error_message": "Redis connection timeout after 1000ms",
  "retry_count": 2,
  "will_retry": true,
  "dlq_routed": false
}
```

**Explicitly excluded from logs:** event payload content (may contain PII), customer identifiers in plaintext, order amounts.

---

## Key Dashboards

### 1. Projection Lag Dashboard (operational, always-on)

The single most important dashboard in a CQRS deployment.

- Lag heatmap by read model and time (5-minute resolution, last 24 hours): shows when and which read models fell behind
- p50/p95/p99 lag by projector (last 1 hour): current lag distribution
- Lag vs. event publish rate overlay: reveals whether lag spikes are driven by write-side volume increases or projector throughput problems
- Consumer group offset lag by Kafka partition: identifies partition-level skew (one partition falling behind others)

### 2. DLQ and Error Dashboard (operational, reviewed on each alert)

- DLQ depth trend by consumer group (last 7 days): reveals systematic issues vs. one-time incidents
- DLQ event type breakdown: identifies which event types are failing
- Error rate by error type: schema_mismatch vs. store_write_failure vs. signature_failure
- MTTR for DLQ: how long from DLQ event first arriving to resolution (replay or discard)

### 3. Event Rate vs. Consumption Rate (engineering, weekly)

- Event publish rate by event type (trend last 30 days): growth rate visibility
- Projector consume rate by consumer group (same period): capacity planning signal
- Ratio of publish rate to consume rate: headroom before lag becomes a problem
- Projector CPU and memory trend: when to scale out

### 4. Read Model Store Health (per store, always-on)

- Redis memory utilization and eviction rate (if any evictions occur, this is a DRI-level incident)
- PostgreSQL history DB connection pool and query latency
- Redshift analytics query queue depth and execution time

---

## Chaos Engineering Scenarios

Run these quarterly in staging and annually in production (during off-peak hours against a shadow read model):

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Projector goes down** | Kill all projector instances | Events accumulate in event bus; no consumer error at query service (read model serves from last good state) | Lag alert fires within 2 minutes; lag reaches 5s within the alert window; query service continues serving stale data without errors |
| **Projector restarts mid-batch** | SIGKILL projector during event processing | Projector restarts; idempotency store prevents double-processing of events from interrupted batch; read model is consistent | No duplicate writes to read model store; idempotency hit log shows caught duplicates on restart |
| **Read model store full** | Fill Redis to 95% memory | Projector write fails; projector retries; after max retries, event routes to DLQ; lag alert fires | Events route to DLQ without projector crash; DLQ depth alert fires; query service continues serving (possibly stale) data |
| **Replay while live projector is running** | Start a replay against the same read model | Framework routes replay events to shadow store; live projector continues on primary consumer group; no interleaving | Shadow store receives all replay events; live store is not modified during replay; cutover is a discrete step |
| **Schema version mismatch** | Deploy a new event schema version before updating projector | Projector receives new schema event; schema mismatch error; event routes to DLQ | No projector crash; DLQ accumulates new schema events; old schema events continue processing; alert fires on DLQ depth |
| **Write-side event loss** | Simulate failed event publish from command side | Event published to failure log; projector never receives the event; read model diverges from write model for that record | Publish failure alert fires immediately; monitoring shows no lag (projector is caught up — it simply never received the event); write-side publish health metric captures the failure |

The last scenario — event loss — is the hardest to detect because the projector reports zero lag (it has processed everything it received), but the read model is missing data. This is why the command side must emit a publish success/failure metric: it is the only place where unreceived events are visible.

---

## Alerting Philosophy

**Page immediately (SRE on-call):**
- Projection lag p99 > 5 seconds for any read model for more than 60 consecutive seconds
- DLQ depth > 100 events on any consumer group (systematic failure, not transient)
- Event publish failure rate > 0% (any event that fails to publish is a potential read model divergence)
- Redis memory > 90% (evictions imminent; read model data loss risk)
- Any replay fails to complete (leaves read model in uncertain state)

**Notify (no page, Slack channel):**
- Projection lag p99 > 2 seconds for more than 5 minutes (approaching SLO boundary)
- DLQ depth > 10 events (early warning before systematic threshold)
- Projector CPU > 70% sustained (capacity action may be needed)
- Event bus publish rate increases > 50% above 7-day baseline (volume growth requiring attention)
- Schema mismatch error first occurrence (early detection before it causes DLQ accumulation)

**Do not alert on:**
- Individual idempotency hits (expected behavior; alert only if rate is anomalously high, indicating a consumer rebalance loop)
- Projector restarts (alert only if restart rate exceeds 2 per hour — indicates crash loop)
- Lag spikes that resolve within 30 seconds (transient; acceptable under the SLO)
- DLQ events during known deployments of schema version migrations (expected; suppress during deployment window)

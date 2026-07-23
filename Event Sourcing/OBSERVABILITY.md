# Observability — Event Sourcing Pattern

## Why Event Sourcing Observability Is Different

Event Sourcing introduces observability concerns that do not exist in traditional CRUD systems. The most important: **projection lag is the primary health signal, not request latency**. In a CRUD system, a slow write is directly observable (the API call takes longer). In an event-sourced system, a slow or failed projector is invisible to the command API — commands succeed, events are appended, and only the read model is stale or wrong.

A system where commands succeed but projections are hours behind looks healthy to conventional monitoring. It is not healthy: queries return stale data, reports are incorrect, and downstream consumers are operating on outdated state.

A second concern unique to Event Sourcing: **the event log grows forever**. Storage saturation is a reliability risk that CRUD systems do not face in the same form. An event store that runs out of disk space stops accepting new events — a write-path failure that is irreversible until disk space is freed.

---

## Four Golden Signals

### 1. Latency

| Metric | Description | Alert Threshold |
|---|---|---|
| `eventsource.write.latency.p95` | Time from command handler receiving a command to event appended and `200 OK` returned. Includes optimistic concurrency check and schema validation. | > 50ms p95 |
| `eventsource.write.latency.p99` | Tail latency for event appends. Elevated p99 with normal p95 indicates OCC contention on hot aggregates. | > 200ms p99 |
| `eventsource.rehydrate.latency.p95` | Time to load an aggregate from its events (or snapshot + events since snapshot). Includes event store read + event application. | > 200ms p95 |
| `eventsource.rehydrate.latency.p99` | Tail rehydration latency. P99 significantly above p95 indicates aggregates with no snapshot or expired snapshots. | > 1000ms p99 |
| `eventsource.projection.lag.seconds` | How far behind the projector is, measured in seconds. This is the primary health signal for the read path. | > 30 seconds |
| `eventsource.snapshot.age.seconds` | How old the most recent snapshot is for a given aggregate type. Old snapshots → slow rehydration. | > 3600 seconds for hot aggregates |
| `eventsource.query.latency.p95` | Time from query API receiving a request to response returned. Served from read model, so latency reflects read model health. | > 100ms p95 |

**Interpretation note:** A spike in `eventsource.rehydrate.latency.p99` that coincides with a spike in `eventsource.snapshot.age.seconds` indicates the snapshot job has fallen behind. The fix is snapshot job remediation, not infrastructure scaling.

---

### 2. Traffic

| Metric | Description | Dimensional Labels |
|---|---|---|
| `eventsource.events.appended.rate` | Events appended per second, by `event_type`. Normal baseline establishes the expected event rate per type. Anomaly detection on this metric catches business process anomalies (e.g., unusual spike in `AccountClosed` events). | `event_type`, `aggregate_type` |
| `eventsource.projection.events.consumed.rate` | Events consumed per second by each projector. Should track `appended.rate` with a lag ≤ SLO. | `projector_name`, `aggregate_type` |
| `eventsource.replay.events.replayed.total` | Cumulative events replayed. A sudden increase indicates a backfill or replay operation in progress. Use this to correlate infrastructure load spikes with planned replay operations. | `replay_job_id`, `aggregate_type` |
| `eventsource.snapshot.created.rate` | Snapshots created per minute, by aggregate type. If this drops to zero for a hot aggregate type, rehydration latency will grow until it is restored. | `aggregate_type` |
| `eventsource.commands.received.rate` | Commands received by the command handler per second. Provides the input rate for the write path. | `command_type`, `aggregate_type` |
| `eventsource.occ.retries.rate` | Optimistic concurrency conflict retries per second. Provides visibility into how often commands are being retried due to version conflicts. | `command_type`, `aggregate_type` |

---

### 3. Errors

| Metric | Description | Alert Threshold |
|---|---|---|
| `eventsource.write.optimistic_concurrency_failures.rate` | OCC conflicts per second that exhaust retries and return an error to the caller. Distinguish from retried OCC conflicts. A sustained rate > 0 indicates contention on a hot aggregate. | > 1/second sustained |
| `eventsource.projection.errors.rate` | Projection failures per second, by error type. A spike in schema-related errors indicates a schema version mismatch between the event store and the projector. | > 0 (alert on any) |
| `eventsource.projection.dead_letter.count` | Events moved to dead-letter queue after exhausting projection retry attempts. Each DLQ entry represents a read model that is missing data. | > 0 (alert on any) |
| `eventsource.replay.errors.total` | Errors during replay operations. A replay that errors partway through leaves the read model in a partially-replayed state — this is a data integrity issue, not just an operational issue. | > 0 (alert on any) |
| `eventsource.schema.validation.failures.rate` | Events rejected by schema validation at the append boundary. Should be zero in a correctly functioning system. Any rate > 0 indicates a schema mismatch in the producing service. | > 0 (alert on any) |
| `eventsource.snapshot.failures.rate` | Failed snapshot creation attempts. Persistent failures → snapshot staleness → rehydration latency growth. | > 0 (alert on any) |
| `eventsource.integrity_check.gaps.count` | Number of gaps detected in event sequence during the periodic integrity check. A non-zero value is a critical alert — the audit trail is incomplete. | > 0 (page on-call immediately) |

---

### 4. Saturation

| Metric | Description | Alert Threshold |
|---|---|---|
| `eventsource.store.disk.utilization.percent` | Event store disk utilization. Events grow without bound — this metric requires a trend alert, not just a threshold alert. Trend: > 5% growth/day. | > 80% (warn), > 90% (critical) |
| `eventsource.projection.consumer_lag.events` | Number of events in the queue waiting to be processed by the projector. Different from lag in seconds — this measures the backlog volume. | > 10,000 events |
| `eventsource.store.connection_pool.utilization` | Event store connection pool usage. Saturation causes write queueing, which increases write latency. | > 80% |
| `eventsource.snapshot.storage.utilization.percent` | Snapshot store utilization. Less critical than event store (snapshots can be regenerated), but snapshot storage exhaustion causes snapshot creation to fail. | > 80% |
| `eventsource.replay.queue.depth` | Number of pending replay jobs. If replay jobs queue up, ops teams are blocked from completing projection migrations. | > 3 queued |

---

## SLOs

| SLO | Target | Measurement Window |
|---|---|---|
| Event append success rate | 99.9% | Rolling 30 days |
| Event append p99 latency | < 100ms | Rolling 7 days |
| Projection lag p95 | < 60 seconds | Rolling 7 days |
| Projection lag p99 | < 5 minutes | Rolling 7 days |
| Replay API availability | 99.9% | Rolling 30 days |
| Event log integrity (no gaps) | 100% | Continuous |
| Snapshot freshness (hot aggregates) | p95 < 1 hour | Rolling 7 days |

---

## Structured Log Schema

Every event store operation produces a structured log entry. Log schema:

```json
{
  "timestamp": "2025-11-14T09:23:45.123Z",
  "service": "command-handler",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "operation": "append_event",
  "aggregate_type": "Account",
  "aggregate_id": "acc-88421",
  "aggregate_version_before": 14,
  "aggregate_version_after": 15,
  "event_type": "MoneyDeposited",
  "event_id": "evt-7f3a8b2c-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  "event_version": 1,
  "duration_ms": 12,
  "result": "success",
  "occ_attempt": 1,
  "schema_validation": "passed",
  "actor_id": "user-456",
  "correlation_id": "req-abc123",
  "causation_id": "cmd-xyz789"
}
```

Projection operations:

```json
{
  "timestamp": "2025-11-14T09:23:45.456Z",
  "service": "account-projector",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "operation": "project_event",
  "projector_name": "account_balance_v3",
  "event_id": "evt-7f3a8b2c-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  "event_type": "MoneyDeposited",
  "event_position": 1847293,
  "checkpoint_position": 1847292,
  "duration_ms": 3,
  "result": "success",
  "idempotency_check": "not_duplicate",
  "read_model_write_latency_ms": 2
}
```

---

## Dashboards

### Dashboard 1: Write Path Health
- Event append rate by event_type (time series)
- Write latency p50/p95/p99 (time series)
- OCC conflict rate (time series)
- Schema validation failure rate (time series)
- Write error rate (time series)

### Dashboard 2: Read Path Health (Projection Health)
- Projection lag by projector (time series) — **primary health signal**
- Events consumed rate by projector vs. events appended rate
- Projection error rate by projector and error type
- Dead-letter queue depth by projector
- Query API latency p95 (time series)

### Dashboard 3: Storage and Saturation
- Event store disk utilization (trend over 30 days)
- Projected disk exhaustion date (based on 7-day growth rate)
- Snapshot storage utilization
- Snapshot freshness by aggregate type
- Connection pool utilization

### Dashboard 4: Operational (Replay Monitoring)
- Active replay jobs (gauge)
- Replay progress (events replayed / total events)
- Replay throughput (events/second)
- Replay errors
- Event log integrity check results (last run, gap count)

---

## Alerting Runbook

### Alert: Projection Lag > 60 seconds

**Likely causes:**
1. Projector process crashed or restarted — check projector pod/container status
2. Event store read slowdown — check event store metrics, connection pool utilization
3. Read model write bottleneck — check read model database write latency
4. Schema version mismatch — check projection error logs for parse errors

**Response:** Check `eventsource.projection.errors.rate` first. If non-zero, the projector is likely encountering an unhandled event version — this requires a code fix, not a restart. If errors are zero, restart the projector process and monitor recovery.

### Alert: OCC Failures > 1/second sustained

**Likely cause:** Multiple concurrent command handlers are competing to write to the same aggregate. This indicates either a hot aggregate (one account receiving many commands simultaneously) or a bug causing command fan-out.

**Response:** Identify the `aggregate_id` generating conflicts from the logs. If it is a single aggregate, this is an architectural concern — the aggregate may need to be split. If it is many aggregates, the command handler may have a retry bug causing command fan-out.

### Alert: Event Log Integrity Gap Detected

**This is a P0 incident.** The audit trail is incomplete.

**Response:** Immediately page the on-call. Identify the affected aggregate type and time range. Do not attempt manual repair without a documented runbook. Preserve all database logs. Engage the event store platform team immediately.

### Alert: Event Store Disk > 80%

**Response:** Verify that the archival job is running (events older than 90 days should be moving to object storage). If the archival job is healthy, evaluate whether the hot storage tier needs expansion. Calculate projected exhaustion date. This alert requires a response within 24 hours.

---

## Chaos Engineering Scenarios

These scenarios should be run in a staging environment with production-equivalent event volume before go-live, and quarterly thereafter:

### Scenario 1: Projector Killed Mid-Replay

**Setup:** Trigger a full historical replay for a projection. Kill the projector process after 20% completion.

**Expected behavior:** Projector resumes from its last checkpoint when restarted. No events are double-applied to the read model (idempotency is preserved). The read model reaches the correct final state.

**Failure signal:** Duplicate records in the read model, or a read model that restarts from event zero rather than the checkpoint.

### Scenario 2: Schema Version Mismatch

**Setup:** Deploy a projector that knows about event schema v1 only. Append a v2 event.

**Expected behavior:** Projector routes the v2 event to its version handler (or a no-op handler if v2 is unknown). It does not crash. It logs the unhandled version. The event is moved to DLQ or skipped with a metric increment.

**Failure signal:** Projector crashes, loses its checkpoint, and restarts from zero — causing a replay that overwrites correctly-projected data.

### Scenario 3: Snapshot Deleted for Hot Aggregate

**Setup:** Delete the most recent snapshot for an aggregate with 10,000 events.

**Expected behavior:** Next rehydration of that aggregate reads all 10,000 events from the event log. Latency is higher than SLO but the result is correct. A new snapshot is created after rehydration.

**Failure signal:** Rehydration returns incorrect state, or the command handler fails to load the aggregate and returns an error.

### Scenario 4: OCC Conflict Flood

**Setup:** Send 100 concurrent commands targeting the same aggregate_id.

**Expected behavior:** Commands are processed serially via OCC retries. All valid commands succeed eventually. The event sequence for the aggregate is correct. No events are lost or duplicated.

**Failure signal:** Starvation (some commands never succeed), duplicate events, or incorrect aggregate state after all commands complete.

### Scenario 5: Event Store Write Unavailability

**Setup:** Block write access to the event store for 30 seconds.

**Expected behavior:** Command handler returns `503` for the duration. Projectors continue processing existing events. When write access is restored, new commands succeed. Projectors catch up with no intervention.

**Failure signal:** Data loss, incorrect aggregate state after recovery, or projector checkpoint corruption.

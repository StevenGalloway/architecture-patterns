# ADR-005: Define retention, replay, and observability requirements

## Status
Accepted

## Date
2026-03-19

## Context
The Transactional Outbox CDC pipeline has multiple components that can fail or degrade independently: the PostgreSQL WAL capture, the Debezium connector, the Kafka broker, and the consumer group. Silent failures in any of these components can cause downstream services to operate on stale or incomplete event data without any immediately visible alert.

Two operational gaps were identified after the pipeline was in production:

**CDC lag went undetected for 6 hours.** A network partition between the Debezium host and the PostgreSQL database caused Debezium to fall behind by approximately 12,000 events. Debezium was running (no crash), but it was reading WAL at a slower rate than events were being written. Downstream consumers continued processing normally -- they were consuming the lagged events in order -- but they were processing events from 6 hours ago while order creation was generating new events in real-time. The Fulfillment service's order age metrics showed an unusual increase in order processing time, which was the first visible signal. The root cause was not identified for 2 hours after the metric anomaly was noticed.

**Outbox table unbounded growth.** Six weeks after deployment, the `outbox_events` table had grown to 28 million rows. The table had a `status` column but no cleanup job had been scheduled. The PostgreSQL autovacuum was running but was not keeping up with the table size. Query performance on the outbox table degraded, which increased the latency of order creation transactions (which write to the outbox table) by 40ms.

Both problems required operational infrastructure that was not deployed alongside the CDC pipeline.

## Decision
**Outbox table retention:** Published outbox rows are deleted by a scheduled cleanup job (`DELETE FROM outbox_events WHERE status = 'published' AND published_at < NOW() - INTERVAL '30 days'`) that runs daily during off-peak hours. Pending rows (not yet published by Debezium) are never deleted by the cleanup job; a separate alert fires if a row remains in `pending` status for more than 30 minutes (indicating Debezium has fallen behind or stalled).

**Kafka retention:** All outbox event topics are configured with a retention period of 14 days (hot storage). Events older than 14 days are archived to S3 via a Kafka Connect S3 Sink connector. The S3 archive is retained for 2 years. This enables replay of historical events for consumer backfills and error recovery.

**Metrics and alerts:**
- `cdc.debezium.lag.events`: number of events between Debezium's current WAL position and the database's current WAL position. Alert if lag exceeds 1,000 events for more than 5 minutes; page if lag exceeds 10,000 events.
- `cdc.kafka.consumer_lag.events`: consumer group lag per topic/partition. Alert if any consumer group lag exceeds 5,000 events.
- `outbox.pending.count`: count of rows in `pending` status. Alert if count has not decreased for 10 consecutive minutes (Debezium stalled).
- `cdc.dlq.event_count.rate`: rate of events routed to DLQ per minute. Alert if DLQ rate exceeds 1 event per minute (persistent consumer failures).
- `outbox.table.size_gb`: total table size. Alert if size exceeds 10GB (cleanup job may not be keeping up).

**Runbooks:**
1. How to restart the Debezium connector after a failure (includes WAL slot verification steps)
2. How to replay events from a specific Kafka offset (consumer group offset reset procedure)
3. How to replay events from the S3 archive (for events older than 14 days)
4. How to manually clean the outbox table without disrupting active CDC
5. How to inspect and remediate DLQ events

## Alternatives Considered

**No outbox retention; retain all rows forever:** Keep all outbox rows in the database as an event log. Provides a complete audit trail without a separate archive. Rejected because the 28-million-row table growth demonstrated that unbounded retention is operationally unsustainable; the table degrades write performance for a table that is in the critical path of order creation.

**Row-level log archival instead of Kafka archival:** Archive outbox rows to S3 directly from PostgreSQL (via `pg_dump` or table partitioning) instead of relying on Kafka for the long-term event archive. Rejected because the replay use case (re-ingesting events from the archive into a consumer's processing pipeline) is easier when the archive is in Kafka format; a consumer can reset its offset to an archived topic and process as if the events were live.

**Consolidate all metrics into existing application dashboards:** Add CDC metrics to the Orders service dashboard alongside application metrics. Rejected because CDC is infrastructure (not application) and its metrics are relevant to multiple consumers (Fulfillment, Notification, Analytics). A dedicated CDC pipeline dashboard is shared across all teams that consume the pipeline.

## Consequences

### Positive
- The Debezium lag alert (fire at 1,000 events, page at 10,000 events) would have detected the 6-hour CDC lag incident within 5 minutes of the lag starting to grow
- The outbox cleanup job prevents the 28-million-row table growth issue; row count is bounded by the 30-day retention window
- The S3 archive enables consumer backfills from historical events without relying on the live Kafka topic, which has a 14-day retention limit

### Negative
- The outbox cleanup job runs daily during off-peak hours; the 30-day window means the table can still grow to approximately 3-4 million rows before cleanup (at 100,000 events per day), which requires periodic monitoring to ensure autovacuum keeps up
- The S3 archive replay procedure is manual and requires consumer group offset manipulation; it is a last-resort tool, not a self-service operation

### Risks
- **Debezium WAL slot retained during extended downtime.** If Debezium is stopped for more than a few hours during a maintenance window, the WAL slot accumulates unreleased WAL segments. If PostgreSQL disk fills due to WAL accumulation, all PostgreSQL operations fail. Mitigation: the `outbox.pending.count` alert fires if rows are not being cleared, and the WAL segment size is monitored separately.

## Review Trigger
Revisit the 14-day Kafka retention and 30-day outbox retention if regulatory or consumer requirements change. Revisit the S3 archive replay procedure if it is invoked more than once per quarter, which would indicate that the 14-day retention window is insufficient for the team's replay needs.

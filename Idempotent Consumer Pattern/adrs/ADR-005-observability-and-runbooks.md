# ADR-005: Instrument idempotency metrics and maintain runbooks

## Status
Accepted

## Date
2026-02-04

## Context
After the idempotent consumer pattern was deployed across the Notification and Payment Confirmation services, visibility into its behavior was limited to application error logs. The on-call team had no way to answer basic operational questions:

- Is the duplicate detection rate normal, or are we seeing an unusual number of redeliveries that suggests a broker issue?
- Is the DLQ growing, and if so, for which consumer?
- Is consumer lag increasing, indicating that processing is slower than message production?
- How long does a typical message take to process, and is it within SLA?

During a RabbitMQ network partition event, the consumer fell behind (consumer lag grew from near-zero to approximately 12,000 messages) without any alert firing. By the time the partition resolved and messages were being processed again, the backlog had created a 40-minute delay in order confirmation emails. Customers received their order confirmation emails more than 40 minutes after placing their order. The SLA for order confirmation was 2 minutes.

The delay was operationally invisible until customers started calling support. Had consumer lag been monitored, an alert would have fired within minutes of the lag growing beyond a normal threshold.

## Decision
The following metrics are emitted per consumer and reported to the metrics platform:

**Processing metrics:**
- `consumer.messages.processed`: count of messages successfully processed (side effects applied and acked)
- `consumer.messages.duplicate`: count of messages skipped as duplicates (message_id already in dedup store)
- `consumer.messages.failed.transient`: count of messages that failed with a transient error and were requeued
- `consumer.messages.failed.permanent`: count of messages routed to DLQ
- `consumer.processing.latency_ms`: histogram of end-to-end message processing time (queue receipt to ack)

**Infrastructure metrics:**
- `consumer.queue.depth`: current depth of the primary queue (consumer lag indicator)
- `consumer.dlq.depth`: current depth of the DLQ
- `consumer.dedup_store.latency_ms`: Redis lookup latency per check

**Alert thresholds:**
- Alert if `consumer.queue.depth` exceeds 500 for more than 3 minutes for any consumer
- Alert if `consumer.dlq.depth` increases by more than 10 in any 5-minute window
- Alert if `consumer.messages.failed.transient` rate exceeds 5% for more than 5 minutes (indicating persistent downstream degradation)
- Alert if `consumer.dedup_store.latency_ms` p99 exceeds 50ms (Redis performance issue)
- Page if `consumer.queue.depth` exceeds 5,000 for any consumer (significant lag requiring immediate attention)

**Runbooks maintained:**
1. How to safely replay messages from a specific time range (resending failed notifications)
2. How to inspect and triage DLQ entries (manual remediation of permanent failures)
3. How to handle a Redis dedup store outage (fail-safe processing decisions)
4. How to temporarily pause a consumer without losing messages (maintenance windows)

## Alternatives Considered

**Rely on broker-level monitoring only (RabbitMQ management UI, CloudWatch):** Use the broker's built-in monitoring for queue depth and message rates. Rejected because broker-level metrics cannot distinguish between processed messages and skipped duplicates (both result in ack from the broker's perspective). Application-level metrics are required to observe the idempotency behavior specifically.

**Log-based metrics (parse application logs for metric values):** Emit structured log lines and derive metrics from log aggregation. Rejected as the primary mechanism because log-based metric derivation adds latency (logs must be shipped, parsed, and aggregated before alerts fire) that is unacceptable for consumer lag detection. Metrics emitted directly to the metrics platform are available within seconds.

**Centralized consumer monitoring service:** A shared monitoring service aggregates metrics from all consumers and provides a unified dashboard. Rejected as a separate service; consumer metrics are emitted through the same application metrics pipeline as all other service metrics. Centralized aggregation is handled by the metrics platform (Prometheus + Grafana), not by a dedicated service.

## Consequences

### Positive
- Consumer lag is now an alerted metric; the 40-minute order confirmation delay scenario would trigger a page within 3 minutes of the lag threshold being exceeded
- The duplicate rate metric allows the team to distinguish normal redelivery (a small percentage of traffic) from abnormal broker behavior (high redelivery rate suggesting broker configuration issues)
- DLQ depth alerts ensure permanent failures are triaged promptly rather than accumulating silently

### Negative
- Each consumer must emit its own metric set; adding the idempotent consumer pattern to a new service requires instrumenting all five metric categories, not just the processing logic
- Runbooks require ongoing maintenance; the "how to replay messages" runbook is particularly sensitive to changes in the broker or consumer configuration

### Risks
- **Metric pipeline failure masks consumer issues.** If the metrics pipeline is unhealthy, consumer lag and DLQ growth go undetected until a customer reports the problem. Mitigation: the metrics pipeline itself has an availability SLO and its own monitoring; a pipeline gap triggers an alert that precedes any consumer-specific alert firing.

## Review Trigger
Revisit alert thresholds after any significant change to expected message volume or processing throughput. Revisit the runbook for message replay if the broker is upgraded or replaced, as replay procedures are broker-specific.

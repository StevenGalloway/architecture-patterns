# ADR-001: Adopt Transactional Outbox + CDC for integration event publication

## Status
Accepted

## Date
2025-07-03

## Context
The Orders service must publish an `OrderCreated` integration event to a Kafka topic whenever an order is created, so that downstream services (Fulfillment, Notification, Analytics) can react to the new order. The naive implementation publishes to Kafka in the same code path as the database write:

```
BEGIN TRANSACTION
  INSERT INTO orders (...)
COMMIT
PUBLISH to kafka: OrderCreated
```

This dual-write pattern has a critical failure mode: if the service crashes or the Kafka broker is unavailable after the database `COMMIT` but before the Kafka publish completes, the order is created in the database but no event is published. Downstream services never learn about the order. Fulfillment never starts. The customer never receives a confirmation email.

The reverse failure mode also exists: if the Kafka publish succeeds but then the database transaction rolls back (due to a constraint violation discovered after the publish), an event is published for an order that does not exist. Fulfillment attempts to fulfill an order that cannot be found.

Both failure modes occurred in production:

The first (commit without publish) happened three times in the first month after launch, each time when the Kafka broker was briefly unavailable for certificate rotation. Approximately 40 orders were created without downstream processing; they were discovered when customers contacted support about missing confirmations.

The second (publish without commit) occurred once during a deployment that introduced a database constraint violation. Fulfillment received an event for an order that did not exist and spent 4 minutes in an error loop trying to look it up before the DLQ caught it.

## Decision
Use the **Transactional Outbox** pattern with **Debezium CDC** for all integration event publication from the Orders service:

1. The database transaction writes the order record AND an outbox row (`outbox_events` table) atomically. Both succeed or both fail -- there is no window between a committed order and an unpublished event.
2. Debezium monitors the PostgreSQL Write-Ahead Log (WAL) for changes to the `outbox_events` table.
3. When Debezium detects a new outbox row, it publishes it to the appropriate Kafka topic.
4. Once Kafka acknowledges the message, Debezium marks the WAL position as processed (this is implicit in Debezium's offset management).

The outbox row is never "sent to Kafka" by application code. Application code writes to the database only. The CDC pipeline handles the relay from database to Kafka. This decouples the write path from the message broker: a Kafka outage does not affect order creation, only the delay before events are published after Kafka recovers.

## Alternatives Considered

**Direct Kafka publish in the write path (dual-write):** Application code writes to the database and publishes to Kafka in the same transaction. Rejected because this was the approach in production before this ADR, and both failure modes described in the Context occurred. There is no way to make two different storage systems (PostgreSQL and Kafka) participate in the same atomic transaction without distributed transaction coordination.

**Saga pattern with explicit event sourcing:** Model order creation as an event-sourced saga where the event itself is the source of truth; downstream services subscribe to the event stream. Rejected for this use case because the Orders domain already has a relational write model with established SLOs; event sourcing the entire domain to solve the dual-write problem is disproportionate to the problem scope.

**Polling-based outbox relay (no CDC):** Application code or a scheduled job polls the `outbox_events` table for unprocessed rows and publishes them to Kafka. Simpler than Debezium (no CDC infrastructure). Rejected because polling-based relay introduces a delay between the database write and the event publication proportional to the polling interval. A 5-second polling interval means events are delayed 0-5 seconds, which is unacceptable for real-time downstream processing.

## Consequences

### Positive
- A Kafka outage no longer affects order creation; orders are written to the database successfully, and events are published when Kafka recovers. The maximum delay in event publication equals the duration of the Kafka outage.
- The "commit without publish" and "publish without commit" failure modes are eliminated: the database transaction is atomic, and Debezium only publishes rows from the WAL (which means the database commit has already happened).
- The outbox table provides an auditable record of all integration events: queries against `outbox_events` show every event that was ever published, with its exact payload.

### Negative
- Debezium CDC is new infrastructure that requires setup, monitoring, and operational expertise. It is not a trivial addition to the platform.
- Consumers receive events with at-least-once delivery semantics (Debezium may re-publish an event after a restart); all consumers must implement idempotency (see ADR-004).

### Risks
- **PostgreSQL WAL position slot accumulation.** Debezium uses a PostgreSQL replication slot to track its WAL read position. If Debezium falls behind (or is stopped) and the replication slot is retained, PostgreSQL cannot clean up WAL segments, causing WAL disk usage to grow unbounded. Mitigation: WAL disk usage is monitored; an alert fires at 75% disk utilization, and the Debezium lag metric fires an alert if CDC lag exceeds 10,000 events.

## Review Trigger
Revisit if the team moves away from PostgreSQL as the primary database, which would require evaluating a different CDC connector (Debezium supports multiple databases but the configuration and behavior differ). Revisit if event publication latency requirements change to sub-100ms, at which point the WAL-to-Kafka propagation delay may need measurement and optimization.

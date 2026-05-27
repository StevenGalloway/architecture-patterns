# ADR-003: Use Debezium Postgres connector and partition by aggregate_id

## Status
Accepted

## Date
2025-12-11

## Context
The CDC layer is responsible for reading committed outbox rows from the PostgreSQL WAL and publishing them to Kafka topics. The two key design decisions were: which CDC connector to use, and how to partition events within Kafka topics.

**Connector selection:** Debezium is the most widely deployed open-source CDC framework and supports PostgreSQL via the `pgoutput` logical replication plugin (available in PostgreSQL 10+). Maxwell, another CDC option, was evaluated but is primarily MySQL-focused. AWS DMS (Database Migration Service) was considered but rejected because the platform does not run on AWS, and a cloud-specific CDC tool would introduce vendor dependency.

**Partition key design:** Kafka partitioning determines the ordering guarantee. Events within the same partition are delivered in the order they were produced. Events across different partitions may be delivered in any order.

The partitioning question for order events is: should `OrderCreated`, `OrderUpdated`, and `OrderCancelled` events for the same order be delivered in order to consumers? The answer is yes for most consumers: a Fulfillment service that receives `OrderCancelled` before `OrderCreated` for the same order cannot correctly process the cancellation (the order does not exist in its local view yet).

If all order events are in the same partition (e.g., all events → partition 0), ordering is guaranteed for all events but throughput is limited to one partition's capacity. If events are randomly partitioned (round-robin), ordering is not guaranteed but throughput scales with partition count.

The solution is to partition by `aggregate_id` (the order ID): all events for the same order go to the same partition, providing per-aggregate ordering while distributing load across partitions for different orders.

## Decision
The Debezium PostgreSQL connector is configured with:

**Connector settings:**
- Plugin: `pgoutput` (native PostgreSQL logical replication)
- Table filter: monitors only `outbox_events` table (not the entire orders schema)
- Snapshot mode: `never` (do not snapshot existing rows on startup; only publish new rows committed after the connector starts)
- Heartbeat interval: 10 seconds (publishes a heartbeat to prevent WAL slot accumulation during periods of no activity)

**Kafka producer settings from Debezium:**
- Message key: the `aggregate_id` value from the outbox row. This ensures Kafka partitions all events for the same aggregate to the same partition.
- Topic naming: `{database}.{schema}.{event_type}` → simplified to `orders.{event_type}` via a Debezium SMT (Single Message Transform) that extracts the `event_type` column as the topic name.

**Partition count:** Each topic is created with 12 partitions. This allows distributing load across 12 consumer instances per topic while maintaining per-aggregate ordering.

**Message format:** The Kafka message value is the outbox row's `payload` JSONB column, extracted by a Debezium SMT (`ExtractNewRecordState` with `add.fields` including `event_id`, `event_type`, `event_version`, `aggregate_id`, `occurred_at`, `trace_id`). The full row-level change event (with before/after state from Debezium's raw format) is not published; only the meaningful event data is forwarded to Kafka.

## Alternatives Considered

**Maxwell CDC connector:** Maxwell is a MySQL-focused CDC tool that also supports PostgreSQL. Rejected because its PostgreSQL support is secondary to its MySQL support and its community maintenance activity is lower than Debezium for PostgreSQL-specific features. Debezium has a larger community and more active PostgreSQL-specific development.

**Custom application-level polling relay (no CDC):** A scheduled job polls the `outbox_events` table every second for `status = 'pending'` rows and publishes them to Kafka, then marks them as `published`. No Debezium dependency. Rejected because 1-second polling introduces up to 1 second of event publication latency for every event. Debezium's WAL-based approach publishes events within milliseconds of the database commit with no polling interval.

**Single Kafka topic for all event types (no per-type topics):** All outbox events go to a single `orders.events` topic. Consumers filter on `event_type` in the message body. Rejected because it requires every consumer to receive and inspect every event type even if they only care about one. Per-type topics allow consumers to subscribe precisely to the events they need, reducing consumer-side processing overhead.

## Consequences

### Positive
- WAL-based capture provides sub-second event publication latency with no polling interval; events are published within the Debezium-to-Kafka round-trip time after the database commit
- Partitioning by `aggregate_id` guarantees that all events for a given order are delivered to the same Kafka partition, preserving per-order causal ordering for consumers
- The Debezium SMT that extracts the payload and adds metadata fields means consumers receive a clean, structured message without Debezium's internal row-change envelope

### Negative
- Debezium requires a PostgreSQL logical replication slot, which must be monitored carefully; a stalled Debezium connector that holds its replication slot prevents PostgreSQL WAL cleanup (see ADR-001 risks)
- The `snapshot mode: never` setting means that existing outbox rows (from before the connector started) are not published. If the connector is started on an outbox table that already has unprocessed rows, those rows are silently skipped.

### Risks
- **Partition hot spot for a single high-volume aggregate.** If one order generates an unusually high number of events (e.g., an order that is updated hundreds of times due to a bug), all those events go to the same partition, creating a processing hot spot for consumers of that partition. Mitigation: the partition count of 12 distributes load across orders normally; a hot-spot order affects one partition's consumers but not others.

## Review Trigger
Revisit the partition count (12) if topic throughput requirements increase such that 12 parallel consumer instances per topic are insufficient. Revisit the `aggregate_id` partitioning strategy if use cases emerge that require global event ordering across aggregates (not currently needed).

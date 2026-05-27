# ADR-004: Consumers implement idempotency under at-least-once delivery

## Status
Accepted

## Date
2026-02-12

## Context
Debezium with Kafka provides at-least-once event delivery semantics. Under normal operation, each event is delivered once. Under two specific failure conditions, events may be delivered more than once:

**Debezium restart:** When Debezium restarts after a failure, it reads from its last committed WAL offset. If Debezium had published some events from a WAL segment but crashed before committing the offset for those events, it will re-publish them after restart.

**Kafka consumer restart:** When a Kafka consumer restarts, it resumes from its last committed offset. If the consumer had processed some messages and committed side effects but crashed before committing the Kafka offset (or if the commit was lost due to a consumer group rebalance), those messages will be redelivered.

Both failure modes are documented Kafka behaviors. The at-least-once delivery contract is a fundamental property of the CDC+Kafka pipeline, not a deficiency.

The Fulfillment service's first version did not account for this. When Debezium was restarted during a connector upgrade, 23 `OrderCreated` events were re-published. The Fulfillment service processed all 23 twice, creating 23 duplicate fulfillment records. The duplicates were discovered during a daily reconciliation job, but by that time some fulfillment tasks had already been assigned to workers.

## Decision
All consumers of the outbox CDC pipeline must implement idempotency. The standard approach is:

**Processed event tracking:** Before applying side effects for any event, the consumer checks a `processed_events` table using the `event_id` as the lookup key. If the `event_id` is already present, the event is acknowledged and skipped without applying side effects. If the `event_id` is not present, the consumer applies side effects and then inserts the `event_id` into `processed_events`.

The check and the side effects must be atomic. For consumers that write to a database, this is achieved by including the `processed_events` insert in the same database transaction as the side effect writes. For consumers that call external APIs, the external API must accept an idempotency key (the `event_id`), and the side effect is only applied if the API indicates the key has not been seen before.

**Ordering enforcement via aggregate sequence:** Outbox events for the same aggregate arrive in order (guaranteed by Kafka partitioning on `aggregate_id`). Consumers that maintain per-aggregate state must track the last processed `event_id` per aggregate. If a consumer falls behind and events arrive out of order (which can occur if the consumer processes events from multiple partitions concurrently), the `processed_events` check prevents double-processing.

**Retry and DLQ:** A consumer that fails to process an event (application error, database unavailable) nacks the message and relies on Kafka's delivery retry. After 3 retry attempts with exponential backoff (2 seconds, 8 seconds, 32 seconds), the event is published to a DLQ topic for manual triage. The consumer acknowledges the original event after routing to the DLQ.

## Alternatives Considered

**Exactly-once semantics via Kafka transactions:** Configure the consumer to use Kafka transactional consumer groups, which provide exactly-once delivery by coordinating offset commits with downstream Kafka topic writes. Applicable only when the consumer's output is another Kafka topic. Rejected for consumers that write to databases or call external APIs, where the transactional coordination cannot be extended across system boundaries.

**Content-based deduplication (check whether the effect already exists):** Instead of tracking event IDs, check whether the side effect has already been applied. For fulfillment: "does a fulfillment record already exist for this order ID?" If yes, skip. Adopted as a secondary layer but rejected as the primary mechanism because content-based deduplication requires business logic to determine whether an effect was previously applied, which is not always straightforward for complex side effects.

**Event store deduplication (outbox tracks consumer state):** Add a consumer acknowledgment column to the outbox table. The consumer updates `outbox_events` to record that it has processed a specific event. The next delivery checks this column before applying side effects. Rejected because it creates a read dependency on the Orders service's database for every consumer, coupling all consumers to the Orders service's database availability.

## Consequences

### Positive
- The Debezium restart that caused 23 duplicate fulfillment records would have been a no-op with idempotent processing; the `processed_events` check would have found the event IDs already recorded and skipped them
- All consumers share the same idempotency pattern; the implementation is standardized and reviewable
- The DLQ prevents infinite retry loops for poison messages (malformed events, events referencing nonexistent aggregates)

### Negative
- The `processed_events` table requires a per-consumer storage decision (which database, what retention policy). For consumers with high event volume, the table grows and must be periodically pruned.
- The atomicity requirement (side effect write + `processed_events` insert in the same transaction) is straightforward for database-backed consumers but requires careful implementation for consumers that call external APIs

### Risks
- **Processed_events table growth without pruning.** If the processed events table is not pruned, it grows indefinitely. For consumers that process 10,000 events per hour, the table accumulates 240,000 rows per day. Mitigation: a retention policy of 30 days (matching the outbox retention) is enforced via a daily cleanup job; rows older than 30 days are deleted.

## Review Trigger
Revisit the retry schedule (2s, 8s, 32s) if downstream dependencies have different recovery windows. Revisit the 30-day processed_events retention if Kafka's event retention window changes.

# ADR-003: Projector must be idempotent and tolerate out-of-order delivery

## Status
Accepted

## Date
2025-09-17

## Context
The event bus delivers events with at-least-once semantics: under normal conditions each event is delivered once, but during network partitions, consumer restarts, or broker failovers, an event may be redelivered after the consumer has already processed it. If the projector applies an event twice (increments a counter twice, inserts a row twice), the read model becomes incorrect.

Out-of-order delivery is a separate concern. Events for the same aggregate can arrive in a different order than they were emitted, particularly when the event bus partitions by a different key than aggregate ID or when a consumer lag causes batch reprocessing to interleave events from multiple time windows.

Both scenarios occurred in production. The first non-idempotent projection bug was in the fulfillment order count read model: when the projector restarted after a crash, it replayed 3 minutes of events from the last committed offset. Events that had already been applied were applied again, doubling the order counts in the fulfillment dashboard for approximately 8 minutes until the operator noticed the anomaly and manually corrected the read model.

The out-of-order bug was more subtle: `OrderStatusUpdated` events for the same order arrived in the sequence `PAYMENT_OK → SHIPPED → PAYMENT_OK` (the first `PAYMENT_OK` was redelivered after the `SHIPPED` event was already processed). The projector applied the `PAYMENT_OK` event and overwrote the `SHIPPED` status, displaying the order as in-payment state in the customer history view.

## Decision
All projection handlers are implemented with two properties:

**Idempotency via processed-event deduplication:** Before applying any event, the projector checks a `processed_events` table using the `event_id` as the lookup key. If the event_id has already been recorded, the event is acknowledged and skipped without applying the projection logic. The `event_id` is inserted into `processed_events` atomically with the read model update (same database transaction where possible, or a two-phase check where not).

**Ordering enforcement via aggregate sequence numbers:** Each event for a given aggregate includes a `sequence_number` that is monotonically increasing per aggregate. The projector tracks the last processed sequence number per aggregate. If an event arrives with a sequence number equal to or less than the recorded last sequence, it is treated as a duplicate or out-of-order event and skipped. If it arrives with a sequence number greater than `last + 1`, it is deferred to a pending queue until the gap is resolved (or until a 30-second timeout triggers processing with a gap warning metric).

Processed event records are retained for 72 hours (matching the event bus's redelivery window) and then expired. Long-term deduplication relies on replay being idempotent by construction (upsert rather than insert semantics on all read model tables).

## Alternatives Considered

**At-exactly-once delivery semantics at the broker level (Kafka transactions):** Configure the event bus for transactional exactly-once delivery so that each event is guaranteed to be delivered once. Rejected because exactly-once delivery requires both the producer and consumer to opt into Kafka transactions, which increases broker complexity and per-message latency. At-least-once with idempotent consumers achieves the same effective result with simpler broker configuration.

**Optimistic concurrency with version fields on read model rows:** Each read model row has a `version` field. On update, the projector checks that the current row version matches the version at read time (compare-and-swap). If another process updated the row between read and write, the update is retried. Rejected as the primary idempotency mechanism because it prevents duplicate applications of the same event (same version field) but does not handle the case where an event is redelivered with a different version field value.

**Stateless idempotency (pure upsert without dedupe store):** Design all projection handlers as pure upserts (insert or update) without tracking processed event IDs. If the same event is applied twice, the result is the same. Adopted as a secondary safeguard but rejected as the sole mechanism because pure upserts are only safe for state-replacement projections (setting a field to a value). Accumulating projections (incrementing a count, appending to a list) are not idempotent under pure upsert semantics.

## Consequences

### Positive
- Projector restarts, redeliveries, and replays all produce correct read model state because each event is applied at most once
- Out-of-order delivery is handled deterministically: events that arrive out of order are either skipped (sequence already processed) or deferred (sequence gap detected)
- The processed_events table provides an audit trail for projection debugging: given any read model discrepancy, the event IDs that were applied can be traced

### Negative
- The processed_events table grows continuously and requires the 72-hour TTL expiry to prevent unbounded growth; the expiry job must run reliably
- Sequence gap detection requires a deferred processing queue that adds complexity to the projector's event loop

### Risks
- **Processed-events table unavailability.** If the processed_events store is unavailable (database down), the projector cannot safely process events -- it risks applying duplicates. The current behavior on store unavailability is to stop consuming events and alert, rather than proceeding without deduplication. This is the safe failure mode.

## Review Trigger
Revisit the processed_events TTL if the event bus redelivery window changes. Revisit the sequence gap handling if aggregate event ordering becomes less critical (e.g., if the product moves to a model where order status changes are independent events rather than a sequential state machine).

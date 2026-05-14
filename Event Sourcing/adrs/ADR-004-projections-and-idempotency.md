# ADR-004: Projections are idempotent and track processed events

## Status
Accepted

## Date
2025-12-03

## Context
The Account domain projector maintains read models for account summaries, transaction histories, and fee reports. The projector subscribes to the event store's change feed and applies events to these read models as they arrive. The event store's change feed delivers events with at-least-once semantics: under normal conditions each event is delivered once, but consumer restarts and change feed reprocessing can cause events to be delivered multiple times.

A projection restart incident demonstrated the problem: the projector was restarted after a code deployment, and the change feed resumed from the last committed offset. However, the last committed offset was 3 minutes before the restart, meaning the projector reprocessed 3 minutes of events that had already been applied. The account summary read model received duplicate balance adjustments, resulting in incorrect balances for accounts that had received transactions during those 3 minutes. The incorrect balances were served to users until the discrepancy was detected and the read model was rebuilt.

The issue was not in the offset management (which was correct) but in the projection handlers, which were not idempotent. Applying the same `DepositReceived` event twice added the deposit amount to the balance twice.

## Decision
All projection handlers meet two requirements:

**Idempotency via event ID tracking:** Before applying any event to the read model, the projector checks a `processed_events` table using `event_id` as the primary key. If the event_id is already present, the event is acknowledged and skipped. The check and the read model update are performed within the same database transaction to prevent a race condition where the event is applied but the event_id is not recorded (or vice versa) due to a crash between the two operations.

**Ordering enforcement via aggregate version:** The projector tracks the last processed `aggregate_version` per aggregate ID in an `aggregate_watermarks` table. If an event arrives with an `aggregate_version` less than or equal to the recorded watermark, it is treated as a duplicate and skipped. If an event arrives with an `aggregate_version` greater than `watermark + 1` (a gap), it is placed in a deferred queue with a 30-second maximum hold time before being processed anyway with a gap warning logged.

**Upsert semantics on read model tables:** All read model updates use upsert (insert-or-replace) semantics rather than insert-only. This provides a second layer of idempotency for projection handlers that do not have a state-accumulation requirement (account summary balance is the result of all events, so pure upsert does not apply -- the event ID tracking is required for those cases).

## Alternatives Considered

**At-exactly-once delivery from the event store:** Configure the event store change feed for exactly-once delivery so that duplicate events never occur. Rejected because exactly-once delivery requires distributed transaction coordination between the event store and the projection target, which adds latency and complexity to every event delivery. At-least-once delivery with idempotent consumers achieves the same effective outcome with simpler infrastructure.

**Idempotency via event content hashing:** Instead of tracking event IDs, hash the event content and check if a duplicate hash has been processed. Rejected because content hashing does not uniquely identify events: two different events with identical content (two deposits of exactly $100.00) would produce the same hash but must both be applied. Event ID is the correct idempotency key because it is unique per event, not per event content.

**Per-aggregate mutex locking in the projector:** Acquire a mutex per aggregate before applying events for that aggregate, ensuring serial processing. Provides ordering guarantees but does not provide idempotency: if the mutex is acquired, the event is applied, and then the projector crashes before recording the watermark, the same event will be applied again on restart. Locking and idempotency are orthogonal concerns; both are needed.

## Consequences

### Positive
- Projector restarts and change feed reprocessing do not produce incorrect read model state; duplicates are silently absorbed
- The `processed_events` table provides a complete processing audit trail for debugging: given a read model discrepancy, the event IDs that were applied can be traced back to the original events
- Replay safety: running a full replay (resetting the change feed offset to 0) produces the same read model result as the original processing, making replay a reliable recovery mechanism

### Negative
- The `processed_events` table grows indefinitely without an expiry policy; for high-event-volume accounts, this table can be large. The current retention policy is 30 days, which exceeds the change feed's maximum redelivery window of 7 days.
- The database transaction that combines the event ID insert and the read model update requires both operations to succeed atomically; if the read model is in a different database than the processed_events store, a distributed transaction or alternative approach is required

### Risks
- **Processed_events store unavailability.** If the processed_events database is unavailable, the projector cannot safely process events without risking duplicates. The safe failure mode is to pause event consumption and alert, rather than proceeding with potentially non-idempotent processing.

## Review Trigger
Revisit the processed_events retention period if the change feed's redelivery window changes. Revisit the in-transaction idempotency check if the projector migrates to a read model store that is not in the same database, which would require a different approach to atomic idempotency recording.

# ADR-004: Define ack, retry, and DLQ behavior for failures

## Status
Accepted

## Date
2025-12-10

## Context
The idempotent consumer pattern handles duplicate delivery correctly, but it does not handle the failure cases that occur when a non-duplicate message fails to process. Two failure categories require different handling:

**Transient failures:** The email API returns a 503 because its servers are temporarily overloaded. The correct response is to retry after a delay; the email will likely succeed if tried again shortly.

**Permanent failures:** The message payload has a malformed email address that will never be a valid delivery target. Retrying this message will always fail. If the broker redelivers it indefinitely, it consumes consumer processing capacity without any chance of success.

Before a defined retry and DLQ policy existed, both failure types were handled the same way: the message was nacked (negative acknowledged) and requeued immediately. Transient failures were retried too aggressively (causing thundering herd effects during API outages), and permanent failures cycled through the queue indefinitely until an operator noticed the consumer error rate and manually intervened.

A specific incident: a malformed payment confirmation message (the order ID field contained a non-UUID string that the payment API rejected as invalid) was requeued and reprocessed approximately 12,000 times over 6 hours before the consumer error rate triggered a monitoring alert. Each processing attempt consumed resources, added error log entries, and triggered alerts that masked other issues.

## Decision
The consumer acknowledges messages in three states: success, permanent failure (DLQ), and transient failure (requeue with backoff).

**Success path:** Side effects are applied successfully, `message_id` is recorded in the deduplication store, message is acknowledged to the broker.

**Transient failure:** If the side effect fails with a transient error (network timeout, downstream 503, database connection failure), the message is nacked with `requeue=true`. The broker redelivers the message after a delay. Retry backoff is implemented at the consumer level: the consumer tracks retry count in the message headers and waits before nacking. Retry schedule: 5 seconds, 30 seconds, 2 minutes, 10 minutes. After 4 retries, the message is treated as a permanent failure and routed to the DLQ.

**Permanent failure:** If the message payload fails validation, the downstream API returns a 4xx (indicating the request itself is invalid, not temporarily unavailable), or the retry limit is reached, the message is acknowledged and simultaneously written to a dead-letter queue (DLQ). The DLQ entry includes: original message, failure reason, retry count, and timestamp.

**Deduplication key cleanup on failure:** If the consumer recorded the `message_id` in the deduplication store before attempting side effects (early recording for safety) and the side effects subsequently fail permanently, the `message_id` record must be deleted from the deduplication store. Otherwise, a future attempt to replay or manually reprocess the message would be incorrectly identified as a duplicate and skipped.

## Alternatives Considered

**Immediate requeue on any failure:** Any processing failure results in immediate requeue. Simple to implement. Rejected because it produces exponential load on failing downstream dependencies during outages (each consumer instance retries immediately, creating a storm of requests to an already-degraded service) and creates infinite retry loops for permanent failures.

**Consumer-managed retry queue (separate retry topic):** On transient failure, publish the message to a consumer-owned retry queue with a delayed delivery time. The main consumer only processes messages from the primary queue; the retry consumer handles the retry queue with the backoff timing enforced by the delayed delivery. More complex but provides cleaner separation between primary processing and retry processing. Deferred: this approach is more scalable for high-volume consumers and is the migration target, but requires delayed delivery queue support (RabbitMQ TTL + dead-letter routing) to implement correctly.

**Discard on failure after N retries without DLQ:** After the retry limit is reached, simply discard the message. Rejected because unrecoverable messages may contain business-critical events (payment confirmations, order notifications) that require human review. Discarding without a DLQ means these events are silently lost.

## Consequences

### Positive
- Permanent failures (malformed messages) are sent to the DLQ on the first processing cycle rather than cycling through the queue indefinitely
- Transient failures are retried with backoff, reducing pressure on degraded downstream services
- DLQ entries capture enough context for human triage: the original message, the failure reason, and the retry history

### Negative
- Retry backoff is implemented in the consumer rather than at the broker level; if a consumer crashes between retry attempts, the backoff timer is lost and the message will be redelivered immediately by the broker
- The deduplication key cleanup on permanent failure adds a Redis write to the failure path that must not itself fail; if the cleanup fails, the message may be incorrectly deduplicated on future replay attempts

### Risks
- **DLQ grows without active monitoring.** If the DLQ is not monitored and regularly triaged, it accumulates messages indefinitely, and business-critical events are lost in the noise. Mitigation: a DLQ depth alert fires when depth exceeds 10 messages for more than 5 minutes; see ADR-005 for observability requirements.

## Review Trigger
Revisit the retry schedule if downstream API SLAs change and the current backoff intervals are too long or too short for the typical recovery window. Revisit the DLQ architecture if message volume grows to the point where DLQ entries need automated triage rather than manual review.

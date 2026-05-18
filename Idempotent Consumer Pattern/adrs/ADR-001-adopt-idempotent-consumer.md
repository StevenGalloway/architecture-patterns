# ADR-001: Adopt Idempotent Consumer for asynchronous processing

## Status
Accepted

## Date
2025-06-11

## Context
The Notification service consumes messages from a RabbitMQ queue to send transactional emails: order confirmation, shipping notification, password reset, and promotional alerts. RabbitMQ delivers messages with at-least-once semantics: if the consumer acknowledges a message late, the broker may redeliver it to another consumer instance. If the consumer crashes after processing a message but before acknowledging it, the message is redelivered to the next available consumer.

The first production incident from this behavior was a customer reporting receipt of three identical order confirmation emails within 30 seconds. Investigation showed that the consumer had processed the message (sent the email via the third-party email API) but had not acknowledged it before a network partition caused the broker to redeliver the message twice more. All three consumer instances processed the same message successfully, each sending an identical email.

The email API used for delivery was idempotent -- calling it multiple times with the same idempotency key would not result in multiple sends. But we had not configured the consumer to use an idempotency key. Each call to the email API was treated as a new independent request.

A second incident involved a payment confirmation email sent 4 times to a different customer. The consumer had been processing the message successfully but experiencing intermittent timeouts connecting to the email API. The retry logic retried the entire message processing (including the email send) rather than retrying just the failed API call, and each retry succeeded -- sending a new email each time.

Both incidents caused customer complaints and eroded trust. Fixing the email API calls to use idempotency keys addressed the symptom for email sending, but the pattern problem was broader: any consumer that performs side effects (database writes, API calls, payment charges) must be designed to handle duplicate message delivery without duplicate side effects.

## Decision
Implement the **Idempotent Consumer** pattern for all message consumers that perform non-trivially-reversible side effects:

1. Every message includes a stable `message_id` that does not change on redelivery
2. Before performing side effects, the consumer checks a deduplication store using `message_id` as the key
3. If the `message_id` is already present in the deduplication store, the message is acknowledged and skipped without performing side effects
4. If the `message_id` is not present, the consumer performs its side effects, then records the `message_id` in the deduplication store, then acknowledges the message

Steps 3 and 4 must be designed carefully for failure cases: if the consumer crashes after performing side effects but before recording the `message_id`, the message will be redelivered and processed again. This is handled by designing side effects to be themselves idempotent where possible (using API idempotency keys, using database upserts rather than inserts).

## Alternatives Considered

**At-exactly-once delivery at the broker level:** Configure RabbitMQ for exactly-once delivery using quorum queues with publisher confirms and consumer transactions. Rejected because RabbitMQ's exactly-once delivery guarantees apply to the in-broker delivery path, not to the end-to-end "message delivered and side effects applied" guarantee. The consumer can still crash after processing and before acking, causing redelivery.

**Accept duplicate processing as a business risk:** Document that duplicate message delivery is possible and rely on downstream systems (email providers, payment APIs) to deduplicate. Rejected because we cannot control all downstream systems' idempotency guarantees. A new integration with any API that does not support idempotency keys would require revisiting this decision, and the customer complaints from duplicate emails made the business cost concrete.

**Transactional messaging with exactly-once semantics (Kafka transactions):** Replace RabbitMQ with Kafka and use Kafka's transactional producer/consumer model for exactly-once semantics. Rejected as a near-term solution because migrating from RabbitMQ to Kafka is a significant infrastructure change. The idempotent consumer pattern can be implemented on top of the existing RabbitMQ infrastructure without replacement.

## Consequences

### Positive
- Duplicate message delivery no longer causes duplicate side effects; customers no longer receive multiple copies of the same notification
- The pattern is applicable to any consumer regardless of the specific side effect (email, database write, API call, payment charge)
- Adding the deduplication check before any new consumer's side effects is a standard, reviewable pattern that code review can verify

### Negative
- Every consumer requires access to a deduplication store, which adds an infrastructure dependency and a point of failure
- The deduplication store must be consulted before every message is processed, adding a network round-trip to each processing cycle

### Risks
- **Side effects applied, dedup record not written.** If the consumer crashes after sending an email but before recording the `message_id`, the message will be redelivered and the email will be sent again. Mitigation: use the email API's idempotency key as a second layer of protection; the deduplication store handles the common case, and the API idempotency key handles the crash-window case.

## Review Trigger
Revisit if the message broker is replaced with a system that provides stronger delivery guarantees (e.g., Kafka with transactional semantics), which may reduce the need for application-level deduplication in some consumer scenarios.

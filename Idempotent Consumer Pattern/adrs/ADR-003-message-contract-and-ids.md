# ADR-003: Standardize message contracts with stable message identifiers

## Status
Accepted

## Date
2025-10-15

## Context
The idempotent consumer pattern depends on a stable `message_id` that remains constant across all redeliveries of the same message. If the `message_id` changes on redelivery -- or if producers generate a new ID on each publish attempt -- the deduplication check cannot identify the message as a duplicate.

Two problems were discovered with the initial implementation:

The first: the Email Notification producer generated a new UUID for each publish attempt. When a publish failed due to a transient RabbitMQ connection issue and was retried, the retry used a new UUID. From the consumer's perspective, these were two distinct messages, and both were processed. The email was sent twice.

The second: a different producer included `message_id` only when explicitly requested by the consumer team. Other producers did not include any identifier. The consumer could not deduplicate messages that had no `message_id` because there was no stable key to check. Those consumers had to implement workarounds (deduplicating on payload hash, which breaks when identical business events have identical payloads, such as two separate $100 deposits to the same account).

Both problems were consequences of message contract inconsistency: different producers used different conventions for message identification, and the idempotent consumer had to handle whichever convention its specific producer happened to use.

## Decision
All messages produced by internal services must conform to the following standard envelope:

```json
{
  "message_id": "<UUID v4>",
  "message_type": "<namespaced type string, e.g., notifications.order_confirmed>",
  "message_version": <integer>,
  "occurred_at": "<ISO 8601 UTC timestamp>",
  "correlation_id": "<UUID, propagated from inbound request if present>",
  "payload": { ... }
}
```

**Stability requirement:** `message_id` is generated once, at the time the business event occurs, before any publish attempt. If the publish fails and is retried, the same `message_id` is used. The `message_id` is derived from the business event, not from the publish attempt.

For events that originate from a database write (e.g., order created), the `message_id` is generated and stored in the database row at write time, so that retries of the same business operation use the same `message_id` rather than generating a new one.

**Validation:** Consumer initialization validates that incoming messages include a non-null, valid-format `message_id`. Messages without a valid `message_id` are routed to the DLQ immediately with an error code `MISSING_MESSAGE_ID` rather than being processed or silently dropped.

## Alternatives Considered

**Use RabbitMQ's message delivery tag as the deduplication key:** Use the broker-assigned delivery tag (a sequential integer per delivery) as the deduplication identifier. Rejected because delivery tags change on redelivery -- they are assigned per delivery, not per message. A redelivered message has a different delivery tag than its original delivery, making it useless for deduplication.

**Derive message_id from content hash:** Generate the `message_id` by hashing the message payload. Guarantees that two messages with identical content have the same ID. Rejected because it also guarantees that two genuinely distinct messages with identical content (e.g., two separate deposits of exactly $100 to the same account from the same source) are incorrectly deduplicated. The `message_id` must identify the specific business event, not the content.

**Allow producers to opt out of the message envelope standard:** Require the standard envelope for new producers but allow legacy producers to continue using their existing format, with consumer-specific workarounds for deduplication. Rejected because it means each consumer must implement its own deduplication strategy rather than relying on a shared pattern. The cost of migrating legacy producers to the standard envelope is lower than the cost of maintaining multiple deduplication strategies.

## Consequences

### Positive
- The deduplication store's logic is uniform across all consumers: check `message_id`, no special cases for different producer conventions
- The `correlation_id` field enables distributed tracing: a notification sent as a result of an order creation can be traced back to the original order creation request
- The `message_version` field allows consumers to handle schema evolution in the payload (similar to the event versioning decisions in the Event Sourcing ADRs)

### Negative
- Requires coordinating a migration of all existing producers to the standard envelope format; producers that are not yet migrated cannot use the idempotent consumer pattern safely
- Storing `message_id` in the originating database row (to ensure stability across publish retries) requires a schema change for each producer service

### Risks
- **Producer generates a new `message_id` on retry despite the standard.** If a producer implementation has a bug where the `message_id` is generated from `uuid.new()` on each publish attempt rather than stored from the initial event, duplicates will still occur. Mitigation: consumer-side telemetry tracks duplicate `message_id` detection rate; a significant drop in duplicate detection while duplicate side effects continue would indicate a producer generating new IDs on retry.

## Review Trigger
Revisit the envelope standard if the team adopts a schema registry (Avro, Protobuf) for message contracts, which would provide automated schema validation at publish time rather than consumer-side validation.

# ADR-002: Define event contracts and support versioning

## Status
Accepted

## Date
2025-07-23

## Context
Domain events in a CQRS system are a fundamentally different kind of contract than API endpoints. An API endpoint can be versioned and the old version retired once all callers have migrated. An event, once emitted, may be replayed from the beginning of the event log months or years later to rebuild a read model from scratch. The projector must be able to process every event that was ever emitted, including events emitted under schema versions that predate the current projector code.

This constraint was not considered when the initial event schema was designed. The first event schema for `OrderCreated` included a `shipping_address` field as a flat string. Three months later, a product requirement needed per-field address parsing, so the field was changed to a nested object (`{ street, city, state, postal_code }`). The event type name was kept the same.

When a replay was triggered to rebuild the customer history read model (to support a new filtering feature), the projector failed on the first 47,000 events because they contained the old flat-string `shipping_address` format. The projector code had been updated for the new format and had no logic to handle the old format. The replay required an emergency hotfix to add backward compatibility for the old event format.

## Decision
Events are **immutable records** with a defined schema contract. Every event includes:
- `event_id`: UUID v4, globally unique, used as idempotency key
- `event_type`: dotted namespace string (e.g., `orders.order_created`)
- `event_version`: integer, incremented on every breaking schema change
- `occurred_at`: ISO 8601 timestamp with millisecond precision
- `aggregate_id`: the identifier of the aggregate that produced the event
- `payload`: the event-specific data

**Schema evolution rules:**
- Adding a new optional field to `payload` is non-breaking and does not increment `event_version`
- Removing a field, renaming a field, or changing a field's type increments `event_version`
- When `event_version` increments, the projector must handle both the old and new version in a dedicated version dispatch block

**Deprecation policy:** Old event versions are supported for replay for a minimum of 12 months after the new version is introduced. The deprecation timeline is announced in the event schema changelog, not silently removed.

## Alternatives Considered

**Schema registry with compiled schemas (Avro, Protobuf):** Use a schema registry (Confluent Schema Registry or similar) to enforce schema compatibility before events are published. Rejected for initial implementation because the team does not have a schema registry in the current infrastructure, and the investment required to adopt one is not proportionate to the problem at current event volume (under 10 events/second). Revisit when event volume exceeds 1,000 events/second or when more than three services consume the same event stream.

**Event upcasting at read time:** Store events in their original format and apply upcasting transformations when the projector reads them (transform old event version to new version before processing). Rejected as the primary approach because upcasting logic becomes a permanent fixture in the projector codebase, complicating replay paths when multiple upcasters must be applied in sequence.

**Separate event types for each schema version (`OrderCreatedV1`, `OrderCreatedV2`):** Use distinct event type names for each schema version. Rejected because it fragments the event stream: a projector that wants to process "all order creation events" must subscribe to both `OrderCreatedV1` and `OrderCreatedV2`, and any future version adds another subscription. The `event_version` field within a single `event_type` is cleaner.

## Consequences

### Positive
- Replays work correctly against the full event history because the projector handles all known event versions
- The 12-month deprecation policy provides enough runway for all known projectors and consumers to migrate before old event version support is removed
- The `event_version` field makes the projector's version dispatch logic explicit and testable

### Negative
- Projector code grows as event versions accumulate; each version increment adds a new code path that must be tested and maintained
- The deprecation timeline (12 months) means old event handling code stays in the codebase long after most production traffic uses the new version

### Risks
- **Missing deprecation announcement.** If a schema change is made without updating the event schema changelog and notifying downstream consumers, consumers may not be aware that old version support has a sunset date. Mitigation: the schema changelog is a required artifact for any event version increment; the CI pipeline checks for its presence.

## Review Trigger
Revisit if event volume grows to a scale where schema registry tooling (Confluent Schema Registry, AWS Glue) provides meaningful value through automated compatibility enforcement. Revisit if the 12-month deprecation window proves too long to maintain old event handling code in active projectors.

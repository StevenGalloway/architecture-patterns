# ADR-004: Enforce schema evolution and compatibility rules

## Status
Accepted

## Date
2025-12-17

## Context
Kafka topics are the durable record of all business events. Unlike an API endpoint that can be versioned and retired, a Kafka topic's messages may be consumed years after they were produced -- during a replay or historical analysis. A schema change that is backward-incompatible with old messages causes the consumer (the Flink streaming job) to fail or produce incorrect output when it encounters old-format messages during a replay.

A production incident demonstrated this: a producer team added a required field `customer_segment` to the `order_completed` topic schema without incrementing the topic version. Old messages on the topic (from before the schema change) did not have this field. When the Flink job was updated to use `customer_segment` for a new segmentation metric and a replay was triggered to backfill the segmentation metric historically, the job failed on every message from before the schema change with a null pointer exception on the missing field.

Repairing the replay required writing a custom deserialization function that handled the missing field case, which was not tested and introduced its own bugs. The repair took 2 days and the replay took an additional day. The 3-day delay in producing the segmentation metric was caused entirely by an undiscovered schema incompatibility.

## Decision
Schema contracts for Kafka topics are enforced via a Confluent Schema Registry (self-hosted). All producers must register their schema with the registry before publishing; all consumers deserialize messages using the schema registry client, which resolves the schema version from the message header.

**Compatibility rules per topic:**
- `order_completed` and other operational event topics: **BACKWARD_TRANSITIVE** compatibility. New schemas must be readable by all previous consumer versions. New required fields are not allowed; only optional fields with defaults. This enables consumers to read old messages without schema-aware workarounds.
- Analytics output topics (from Flink to downstream consumers): **FULL** compatibility. Both backward and forward compatible. Consumers and producers can be deployed in any order.

**Breaking change handling:** If a schema change is genuinely incompatible with backward compatibility rules, a new topic is created (`order_completed_v2`). Producers are updated to dual-publish to both the old and new topics during a migration window. Consumers are migrated to the new topic. The old topic is retired after all consumers have migrated.

**CI enforcement:** A schema compatibility check runs in CI for any producer service that modifies an event schema. The check calls the Schema Registry compatibility API before the schema change can be merged.

## Alternatives Considered

**JSON Schema without a registry:** Use JSON Schema for schema documentation but not for automated compatibility enforcement. Schemas are defined in a shared documentation repository. Rejected because documentation-only schemas do not prevent incompatible changes from being deployed; the operational incident was caused by a change that would have failed a compatibility check but was not checked.

**Avro with a registry vs. Protobuf:** Both Avro and Protobuf are supported by Confluent Schema Registry. Avro was chosen because it has better null-safety semantics (all fields are either required or explicitly optional with a default; no ambiguous nullable types), and the existing team has more Avro experience. Protobuf would also be acceptable and may be revisited if gRPC adoption increases (Protobuf is native to gRPC).

**Schema versioning via topic naming only (no registry):** New topic versions are created for each schema change (e.g., `order_completed`, `order_completed_v2`). No registry needed. Rejected because topic-per-version proliferates topics rapidly, complicates consumer subscription management, and does not prevent incompatible changes within a version.

## Consequences

### Positive
- The schema compatibility check in CI prevents the category of incident that triggered this ADR: incompatible schema changes are rejected before they are deployed
- Schema Registry's schema resolution in the consumer means that old and new message formats coexist on the same topic; a consumer reading messages from a replay receives the correct schema for each message's format version
- BACKWARD_TRANSITIVE compatibility ensures that replay always works: any message on the topic can be read by any version of the consumer that deployed after the registry enforcement was implemented

### Negative
- Required fields can never be added to existing topics under BACKWARD_TRANSITIVE rules; new required information must either be added as optional with a default (which may be semantically incorrect) or trigger a new topic version with a migration window
- Schema Registry is a new dependency for all producers and consumers; a Schema Registry outage prevents new producers from registering schemas and consumers from resolving new schema IDs

### Risks
- **Schema Registry outage blocks consumer startup.** If the Schema Registry is unavailable when a new consumer instance starts, it cannot resolve schema IDs for incoming messages. The consumer will fail to start or fail to deserialize messages. Mitigation: the Confluent Schema Registry client caches schema IDs locally; a brief Registry outage does not affect running consumers that have already cached their schemas. New instances starting during an outage will fail until the Registry recovers.

## Review Trigger
Revisit the BACKWARD_TRANSITIVE compatibility rule if the operational overhead of maintaining dual-publish migration windows for every schema change becomes excessive. Also revisit if the team adopts Protobuf more broadly, at which point migrating from Avro to Protobuf for Kafka schemas may be worthwhile.

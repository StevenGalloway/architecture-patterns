# ADR-002: Event contracts are versioned and backward-compatible

## Status
Accepted

## Date
2025-08-13

## Context
Unlike database schema migrations, which can be applied once and then forgotten, event schema changes have an indefinite backward compatibility requirement. An event stored in the event log today must be readable by projectors running years from now when replaying the full account history. This is not a theoretical concern: the regulatory audit requirement specifies 7 years of account history retention. Any event schema change must remain processable across the entire retention window.

A secondary concern is the projection deployment gap. During a rolling deployment of the projector, some instances may be running the old projection code while new events (in the new schema version) are arriving. If the old projector code cannot parse the new event schema, it will fail or produce incorrect read model updates during the deployment window.

Both constraints were violated by the first schema change: the initial `FeeCharged` event had a flat `amount` field. A requirement to support fee waivers required changing `amount` to a structure with `gross_amount` and `waived_amount` fields. The change was deployed to the event producer and projector simultaneously (same deployment). The deployment caused a 12-minute window where old projector instances were receiving new `FeeCharged` events they could not parse, causing projection errors and stale fee data in account summaries.

## Decision
All events include the following standard envelope fields:
- `event_id`: UUID v4, globally unique across all events and all aggregates
- `event_type`: namespaced string (e.g., `accounts.fee_charged`)
- `event_version`: integer, starting at 1, incremented on breaking schema changes
- `occurred_at`: ISO 8601 with millisecond precision and UTC timezone
- `aggregate_id`: the account identifier the event belongs to
- `aggregate_version`: monotonically increasing sequence number per aggregate (used for concurrency control and ordering)

**Evolution rules, in priority order:**
1. Adding an optional field with a defined default is non-breaking: `event_version` is not incremented
2. Removing a field, renaming a field, or changing a field's required/optional status increments `event_version`
3. Changing the semantic meaning of a field (same name, different interpretation) increments `event_version` -- do not reuse field names with different semantics
4. When `event_version` is incremented, the projector must handle both the old and new version using version dispatch (`if event.version == 1: ... else if event.version == 2: ...`)

Old event versions are supported for replay for a minimum of the full regulatory retention period (7 years). There is no deprecation mechanism that removes support for an old version within the retention window.

## Alternatives Considered

**Schema registry (Confluent Schema Registry with Avro):** Use a schema registry to enforce compatibility rules at publish time and store schema definitions centrally. The producer registers the schema before publishing; the schema registry rejects incompatible changes. Rejected because the team's event store is PostgreSQL, not Kafka, and a schema registry that works with arbitrary event stores requires either a custom implementation or an API-based schema registry that adds a runtime dependency to the write path. The investment is not justified at current event volume.

**Upcasting at read time:** Store events in their original format forever. When a projector reads an old event, it applies an upcasting function to transform the old version to the current version before processing. This allows projectors to be written against a single "current" event schema. Rejected as the primary approach because upcasting functions accumulate with each version change, and a full replay from version 1 to version N requires applying N upcasters in sequence, which adds significant complexity and makes the upcasting path harder to test.

**Single event version (always backward compatible):** Commit to a schema design that never requires breaking changes -- all fields are optional with explicit defaults, and fields are only added, never removed or renamed. Aspirationally attractive but rejected as an enforceable rule because it is not always achievable in practice. The fee waiver requirement genuinely needed a structural change to accurately represent waived amounts. A strict no-breaking-changes rule would have forced an awkward workaround.

## Consequences

### Positive
- Rolling deployments are safe: old projector instances handle old event versions; new instances handle both old and new event versions
- The 7-year replay requirement is met because no event version is ever removed from the processing logic within the retention window
- The `aggregate_version` field enables optimistic concurrency enforcement (see ADR-003) and ordering guarantees in projections

### Negative
- Projector codebase grows with each version increment; version dispatch logic for `FeeCharged` must handle v1, v2, etc. for the full retention window
- Schema evolution discipline must be maintained across multiple teams and deployment pipelines; a developer who adds a breaking field change without incrementing `event_version` will not be caught by automated tooling in the current setup

### Risks
- **Undetected breaking changes.** A developer adds a required field to an event and deploys without incrementing `event_version`. Old projector instances fail to parse the new event because the required field is absent in their schema. Mitigation: the event schema changelog is reviewed as part of the deployment checklist; a CI job validates that `event_version` was incremented if the event payload schema changed (detected by comparing against the registered schema snapshot).

## Review Trigger
Revisit if event volume grows to the point where a schema registry (providing automated compatibility enforcement) is cost-effective. Revisit the 7-year backward compatibility commitment if the regulatory retention requirement changes.

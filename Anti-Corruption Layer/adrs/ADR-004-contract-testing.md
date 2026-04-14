# ADR-004: Add contract tests for vendor payloads and mappings

## Status
Accepted

## Date
2025-10-01

## Context
Three months after the ACL was deployed, the vendor silently changed the format of the `account_status` enum. The values `"active"` and `"suspended"` were joined by a new value `"pending_verification"` that the vendor introduced for accounts created through a new self-service signup flow. Our mapping function had a switch statement that treated any unrecognized status as `AccountStatus.UNKNOWN`. The silent failure meant that new self-signup customers appeared as unknown-status accounts in our system, which caused their first orders to be routed to a manual review queue instead of the automated path.

The issue was not caught in CI because our mapping tests used hardcoded fixture payloads from a snapshot taken at initial integration time, and those fixtures did not include the new enum value. Production traffic revealed the problem two weeks after the vendor change; by then roughly 800 orders had been misrouted.

We needed tests that would fail when the vendor's payload structure or enum values changed, not just when our mapping logic changed.

## Decision
Two layers of testing are added for the ACL:

**Schema validation tests:** Recorded samples of real vendor API responses (anonymized and stored as test fixtures) are validated against the current mapping logic on every CI run. If a new field appears in vendor responses that the canonical model does not address, the test flags it as an unhandled field warning. If a required field disappears, the test fails.

**Mapping unit tests:** Explicit round-trip tests for every known vendor response variant to canonical model mapping. Each mapping test covers at least one valid case, one nullable field case, and one unrecognized enum value case. The unrecognized enum test must assert that the mapping returns a specific fallback value (not panics or silently drops data).

**Production telemetry:** The ACL logs unknown fields and unrecognized enum values as structured metric events (`acl.unknown_field`, `acl.unknown_enum_value`) with field name and vendor API version. An alert fires if either metric exceeds 0 events in a 5-minute window, triggering review of vendor release notes.

Fixture updates are required as part of any ACL change that handles a new vendor field. Updating fixtures without a corresponding mapping test change is a code review failure.

## Alternatives Considered

**Consumer-driven contract testing with Pact:** The ACL publishes its expectations of the vendor API as a Pact contract. Rejected because consumer-driven contract testing requires the vendor to run a Pact verification step in their CI pipeline. Our vendor does not support this workflow, and we cannot contractually require it.

**API diff tooling against vendor's OpenAPI spec:** Download the vendor's OpenAPI document on each CI run and diff it against the version pinned at last release. Rejected because the vendor does not publish a machine-readable OpenAPI spec and their documentation changes lag actual behavior by days to weeks.

**Manual review of vendor release notes before each update:** A developer reviews vendor changelog entries and manually updates mappings before any vendor-side release. Rejected because the vendor does not provide advance notice of API changes on our contract tier, and the `account_status` incident was caused by a change that appeared in release notes only after deployment.

## Consequences

### Positive
- Vendor enum additions and field renames are caught in CI before they cause production misrouting
- Production unknown-field telemetry catches changes that slip past fixture-based tests (e.g., when the vendor changes behavior in a response variant not covered by existing fixtures)
- Mapping test coverage makes refactoring the ACL safer; regressions show immediately

### Negative
- Fixtures must be updated when the vendor adds legitimate new response variants, which adds friction to vendor upgrade paths
- The alert on any unknown field will fire on vendor A/B tests or staged rollouts, requiring the on-call engineer to investigate and determine whether the unknown field is benign or requires a mapping update

### Risks
- **Fixture staleness.** If fixtures are not kept in sync with actual vendor responses, the tests provide false confidence. Mitigation: automated weekly comparison of stored fixtures against live vendor API responses in a sandbox environment, with a Slack notification if divergence is detected.

## Review Trigger
Revisit if the vendor publishes an OpenAPI spec or adds webhook-based schema change notifications, which would enable a more reliable automated contract validation approach.

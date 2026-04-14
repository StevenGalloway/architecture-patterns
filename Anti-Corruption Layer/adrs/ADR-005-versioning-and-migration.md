# ADR-005: Support versioned mappings and safe migration

## Status
Accepted

## Date
2025-11-19

## Context
The vendor announced a major API version transition: v2 would be deprecated in six months, and v3 introduced breaking changes to the customer address model, the order history structure, and the authentication header format. Unlike smaller changes that could be absorbed by updating a mapping function, v3 required a fundamentally different mapping path for several response types.

The complicating factor was that the vendor's migration timeline overlapped with two internal product launches. We could not coordinate a hard cutover of all traffic to v3 on a single date. We needed to run v2 and v3 mappings in parallel for at least eight weeks so that different integration points (some updated, some not) could migrate independently.

The alternative -- updating all ACL mappings to v3 in a single deployment -- would require every consumer service that relies on canonical model fields affected by v3 to be deployed simultaneously. With nine services in scope, a synchronized cutover had too much risk and would have required a production freeze.

## Decision
The ACL implements mapping versioning using a strategy-pattern approach. Each vendor API version has a dedicated mapper class (`VendorV2CustomerMapper`, `VendorV3CustomerMapper`) that implements a common `VendorCustomerMapper` interface. The active mapper is selected at request time using the following priority:

1. Explicit vendor version header (`X-Vendor-API-Version: 3`) if present in the vendor response
2. Response field presence detection: if the `billing_address` object is nested (v3 shape) vs. flat string (v2 shape), v3 mapper is selected
3. Feature flag (`vendor_api_v3_enabled`) as a per-tenant rollout gate for cases where field detection is ambiguous

The canonical model remains stable across the migration. Both mappers produce identical `CanonicalCustomer` output. If a v3-only field needs to be surfaced (fields that exist only in v3 and have no v2 equivalent), it is added as an optional field on the canonical model with explicit documentation that it will be null for v2-sourced records.

Once all traffic has migrated to v3 and the v2 mapper has processed zero requests for 30 consecutive days, the v2 mapper and its tests are deleted in a cleanup PR. The feature flag is then removed.

## Alternatives Considered

**Hard cutover: update all mappings to v3 in a single deployment:** All ACL mapping logic switches to v3 on a chosen date. Consumers must be ready by that date. Rejected because coordinating nine services plus the ACL in a single deployment window introduces too much blast radius. A failure in any one service would require rolling back the entire cutover.

**Maintain v2 and v3 as separate ACL service instances with a routing layer in front:** Deploy a v2 ACL service and a v3 ACL service; a lightweight proxy routes vendor responses to the appropriate service. Rejected because operating two instances of the ACL doubles the deployment surface and creates divergence risk if resilience or caching configuration changes are applied to one instance but not the other.

**Rely on backward compatibility in the vendor's v3 schema:** The vendor stated that v3 is "mostly backward compatible." Accept the risk that most fields will map the same and only fix the ones that break. Rejected because the v3 address model change affected the fields most heavily used in routing logic, and the vendor's backward-compatibility guarantee only applied to the authentication layer, not the response schema.

## Consequences

### Positive
- Individual consumer services can migrate to v3-specific canonical fields on their own schedule without blocking on other teams
- The feature flag provides an emergency rollback path if v3 mapping produces unexpected results in production
- Versioned mapper classes make the differences between v2 and v3 behavior explicit and reviewable side by side

### Negative
- The canonical model acquires optional fields during the migration period that will be null for some consumers but non-null for others, requiring consumer code to handle both cases
- The cleanup step (removing v2 mapper code and the feature flag) must be actively scheduled; without a committed cleanup date, old mapping code accumulates indefinitely

### Risks
- **Feature flag cleanup neglected.** If the v2 mapper is kept in place after all traffic has migrated, it becomes dead code that is still tested and still contributes to cognitive overhead. Mitigation: the cleanup PR date is recorded as a ticket in the sprint backlog at the time the v3 rollout completes, not left as a future decision.

## Review Trigger
Revisit if the vendor announces v4 before v2 cleanup is complete, at which point the three-version parallel operation may exceed the complexity budget of the versioning approach and a more formal adapter registry may be warranted.

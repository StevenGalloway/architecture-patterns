# ADR-005: Version BFF endpoints and use contract tests

## Status
Accepted

## Date
2025-12-03

## Context
The Mobile BFF and the iOS app have independent release cycles. The iOS app release process involves App Store review and typically takes 5-7 business days from submission to availability. Once a version is in production, it may remain the active version for a subset of users for weeks or months -- users who have automatic updates disabled or are on older OS versions that cannot run the latest app.

In the BFF's third month, the mobile team made a breaking change to the home screen endpoint: the `orders` array was restructured from a flat list of order objects to a nested structure grouped by status. The change was deployed to the BFF before the corresponding iOS update was available in the App Store. Users running the previous app version received a response their client code could not parse, causing a blank home screen for approximately 18% of the active user base over a 3-day window.

The immediate fix was to roll back the BFF change. The delayed fix was to run both response shapes simultaneously until the old app version fell below 2% of active sessions. Without versioning infrastructure, this required deploying if/else branching in the BFF keyed on the app version string -- fragile and untestable.

## Decision
BFF endpoints are versioned in the URL path: `/mobile/v1/home`, `/mobile/v2/home`. When a breaking change is required, a new version is introduced and the old version is kept operational until its traffic drops below 1% of endpoint requests or a sunset date is reached, whichever comes first.

Each BFF endpoint version has a corresponding consumer-driven contract test. The mobile and web apps each maintain a contract file (in Pact format) that specifies the exact response structure their client code depends on. These contracts are run against the BFF in CI on every BFF deployment. A deployment that would break a published contract is blocked at CI.

Sunset dates are set when a new version is introduced. The old version's sunset date is communicated to the client teams at introduction time, not negotiated later. The default deprecation window is 90 days.

Non-breaking additions (new optional fields, new optional response sections) are made to existing versions without incrementing the version number. The contract tests define the minimum required structure; additional fields that the client does not reference do not break the contract.

## Alternatives Considered

**Header-based versioning instead of URL path versioning:** Clients specify the desired API version in an `Accept` or custom header. Rejected because URL path versioning is more explicit, easier to route in the API gateway, and requires no special client logic to include the right header on every request. Mobile apps operating in environments where headers can be stripped or rewritten are better served by version-in-path.

**One version at a time; force clients to upgrade before deploying breaking changes:** A new BFF version is only deployed after all supported client versions have adopted the previous version. Rejected because this couples BFF deployments to App Store review cycles. An iOS update waiting for App Store approval cannot be accelerated, and blocking BFF deployments on App Store timelines is operationally unworkable.

**Backward-compatible changes only; never make breaking changes:** Design the BFF API so that it only ever adds optional fields and never restructures existing responses. Rejected as an absolute rule because some product evolutions require structural changes to the response (the orders grouping was one). A policy of no breaking changes is achievable for stable APIs but creates unsustainable technical debt in a product that iterates quickly.

## Consequences

### Positive
- Old app versions continue to function during the deprecation window without requiring the BFF team to maintain if/else branching keyed on client version strings
- Contract tests provide a safety net that catches breaking changes before they reach production, eliminating the category of incident that triggered this decision
- Sunset dates established at version introduction create clear pressure to retire old versions rather than letting them accumulate indefinitely

### Negative
- Multiple active endpoint versions require the BFF team to maintain response handlers for each version, increasing code complexity during deprecation windows
- Contract test files must be updated by client teams when they change their data requirements, creating a coordination dependency between the app and BFF codebases

### Risks
- **Deprecation deadline enforcement.** If the sunset date is treated as a guideline rather than a hard cutoff, old versions accumulate and the maintenance burden grows. Mitigation: old version traffic is tracked as a dashboard metric; the on-call rotation includes a weekly review of version traffic distribution, and versions below 1% are removed on a scheduled deployment regardless of remaining sunset time.

## Review Trigger
Revisit if the team adopts GraphQL, which provides a different mechanism (field-level deprecation and schema versioning) that may eliminate the need for URL path versioning for composition endpoints.

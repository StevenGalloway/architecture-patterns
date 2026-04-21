# ADR-004: BFF provides partial responses with strict timeouts

## Status
Accepted

## Date
2025-10-15

## Context
The mobile home screen aggregates five upstream services: User Profile, Recent Orders, Recommendations, Promotional Banners, and Loyalty Points. In load testing, we observed that when any single upstream service exceeded its response time, the entire home screen response was delayed. The Recommendations service, hosted by a third-party provider, had a p99 latency of 450ms and occasionally spiked to over 2 seconds.

A 2-second Recommendations response held up the entire home screen composition, blocking the user from seeing their order history and profile information -- data that was available and ready. The dependency was being treated as all-or-nothing: either all five services responded in time and the full page loaded, or any one failure caused the entire screen to fail.

From the user experience perspective, this was the wrong tradeoff. A home screen with recommendations missing but everything else present was significantly better than a blank screen or a loading spinner held open by a third-party service.

We needed a composition strategy where the BFF assembled what was available within a defined time budget and returned a coherent partial response rather than waiting for all dependencies to complete.

## Decision
The Mobile BFF and Web BFF apply strict per-upstream timeout budgets for all aggregated calls:

- User Profile: 300ms timeout
- Recent Orders: 400ms timeout
- Recommendations (third-party): 500ms timeout
- Promotional Banners: 200ms timeout
- Loyalty Points: 300ms timeout

All five calls are issued in parallel. The overall response is assembled from whichever calls completed within their budget. Each aggregated section of the response includes a `status` field (`"ok"`, `"partial"`, `"unavailable"`) so the client can render the section conditionally or show a graceful placeholder.

Unavailable sections return their zero/empty state: `recommendations: []`, `loyalty_points: null`. The client is responsible for rendering the missing state gracefully; it must not fail if any optional section is absent.

BFF emits per-upstream timeout rate metrics (`bff.upstream.timeout.rate` by service name) and a `bff.partial_response.rate` metric for the overall endpoint. Alerts fire if the partial response rate exceeds 5% over a 5-minute window.

## Alternatives Considered

**Return a full response or a 503, no partial states:** If any required upstream fails, fail the entire request. Clients receive either a complete response or an error. Rejected because from the mobile user's perspective, a blank screen is worse than a screen with some content missing. The partial response model is appropriate when the missing sections are non-critical.

**Allow upstream services to define their own timeout budgets:** Each service provides a `max_response_time` hint in its API contract, and the BFF uses that value as the timeout. Rejected because it gives upstream services control over the BFF's response time, which should be a client-facing product decision, not a service-level implementation detail.

**Cache last-known responses for failed upstreams:** If an upstream call fails, return the most recently cached successful response. Accepted as a future enhancement but not implemented in the initial version, because stale cached data (e.g., old order history) could be misleading. Caching is more appropriate for reference data (banners, feature flags) than for user-specific transactional data.

## Consequences

### Positive
- Home screen load time is bounded at approximately 500ms (the longest upstream timeout) rather than unbounded by the slowest service
- Recommendations service degradation no longer affects the user's ability to see their order history and account status
- Per-upstream timeout metrics provide clear attribution when the partial response rate increases

### Negative
- Clients must implement conditional rendering for all optional sections, which adds UI complexity and requires coordinated handling for each new section added to the aggregated response
- Partial response metrics require threshold calibration; a threshold that is too strict will generate alert noise during normal upstream variability

### Risks
- **"Unavailable" used as a cover for persistent failures.** If a service is consistently unavailable but the partial response masks the failure, the problem may go undetected until a user explicitly reports missing content. Mitigation: the `bff.upstream.timeout.rate` metric with alerting at 5% ensures that persistent upstream failures are visible even when the overall endpoint appears healthy.

## Review Trigger
Revisit per-upstream timeout values after each major change to upstream service SLAs. Revisit the partial response model if the client teams report that the current zero/empty fallback states are causing user confusion (e.g., loyalty points showing as null when the user has a non-zero balance).

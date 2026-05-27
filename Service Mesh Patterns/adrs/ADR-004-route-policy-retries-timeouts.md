# ADR-004: Define retries and timeouts at the mesh layer (with safeguards)

## Status
Accepted

## Date
2026-01-28

## Context
After the mesh was deployed with mTLS (ADR-003), the platform team evaluated whether to configure retry and timeout policies at the mesh layer. This was a deliberate decision rather than an automatic follow-on from mesh adoption.

The argument for mesh-layer retry and timeout policy: application services were inconsistently implementing these policies. Some services used Resilience4j (Java); some used their own retry logic; some had no timeout enforcement at all. A mesh-layer policy would provide a consistent safety net regardless of application implementation.

The argument against: mesh-layer retries and timeouts are coarser than application-layer policies. An application knows whether an operation is idempotent and can retry accordingly; a mesh proxy sees only HTTP status codes, not business semantics. A mesh that retries a POST request to a payment endpoint because it received a 503 could cause double charges if the server processed the request before failing.

A specific incident motivated the safeguards: an early implementation of mesh-layer retries (deployed to one namespace as a test) was configured with `retryOn: 5xx` for all routes. A billing service's `/invoices` POST (create a new invoice) received a 500 due to a transient database write error. The mesh retried the request, the second attempt succeeded, and the invoice was created twice. The billing team was unaware the mesh was retrying their route because the application logs showed only one incoming request (the mesh retried before the request reached the application).

## Decision
Mesh-layer route policies are deployed with the following constraints:

**Timeouts are always configured per route:** Every service's Linkerd ServiceProfile includes timeout values for each route. Timeouts default to 5 seconds if not explicitly specified. This is a conservative default that prevents infinite waits without requiring detailed per-route analysis.

**Retries are disabled by default:** No route is configured for mesh-layer retries unless explicitly opted in. To opt in, the ServiceProfile must include a comment indicating that the route is idempotent and the application team has reviewed the retry configuration.

**Approved retry candidates:** Only routes where the HTTP method is GET (inherently idempotent) or routes where the application team has confirmed idempotency (via `x-idempotent: true` annotation in the ServiceProfile) are configured for automatic retries. Maximum 1 retry on 503 or 504.

**Timeout budget inheritance:** The per-route timeout is set at a value less than the overall request deadline propagated by the caller. If an upstream caller has a 2-second total budget, the callee's mesh timeout should be set to 1.5 seconds to leave headroom for the caller's own processing.

**No mesh-layer circuit breaker:** Linkerd does not have a native circuit breaker in its current version. Circuit breaking remains the responsibility of application-layer Resilience4j configuration. This is a deliberate scope limit, not a gap.

## Alternatives Considered

**Mesh-layer retries for all routes (retryOn: 5xx):** Apply retries uniformly to all routes that return 5xx, as Envoy's default configuration enables. Rejected after the double-invoice incident demonstrated that mesh-layer retries for non-idempotent routes (POST, PUT, DELETE) cause exactly the duplicate side effect problem that idempotency patterns are designed to prevent.

**No timeouts at the mesh layer; rely on application-layer timeouts:** Each application service is responsible for setting its own timeouts. The mesh does not add any timeout configuration. Rejected because the inconsistency in application-layer timeout implementation was one of the motivating problems for mesh adoption. A mesh-layer default timeout provides a safety net for services that have not implemented application-layer timeouts.

**Full traffic management with Istio VirtualService:** Use Istio's richer traffic management (retries with backoff, fault injection, traffic mirroring) instead of Linkerd's simpler ServiceProfile. This is the alternative that would require switching from Linkerd to Istio (see ADR-002). The more advanced capabilities are not justified by current requirements.

## Consequences

### Positive
- The default 5-second timeout prevents unbounded blocking for services that have not implemented application-layer timeouts; even services that do not configure their own timeouts have a mesh-level safety net
- Retries are disabled by default for non-idempotent routes, preventing the double-invoice class of incident
- Service-level timeout configuration is visible in the ServiceProfile YAML, making timeout policy reviewable in code review

### Negative
- Mesh-layer policy configuration (ServiceProfile) is an additional artifact that service teams must maintain alongside their Helm charts and Kubernetes manifests; there is a risk that ServiceProfiles are not updated when routes change
- The opt-in model for retries means teams that would benefit from mesh-layer retries for their read endpoints may not be aware of the option

### Risks
- **ServiceProfile drift from actual routes.** If a service adds a new route but does not add it to the ServiceProfile, the route inherits the default timeout (5 seconds) and no retry policy. For most routes, this is acceptable. For routes with SLO requirements that need a different timeout, the default may be wrong. Mitigation: a CI check validates that the number of routes in the ServiceProfile is consistent with the number of routes in the service's OpenAPI spec.

## Review Trigger
Revisit when Linkerd adds native circuit breaker support, at which point the application-layer Resilience4j circuit breakers can be evaluated for potential replacement or complementation with mesh-layer circuit breakers.

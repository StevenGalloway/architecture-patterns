# ADR-001: Adopt an API Gateway as the external entry point

## Status
Accepted

## Date
2025-04-09

## Context
As the product grew from two services to nine, clients started integrating directly with individual service endpoints. Authentication was implemented differently in every service -- some validated JWTs correctly, one checked only an API key header, and one had no auth at all for internal-looking routes. Rate limiting existed in three services. There was no consistent way to attach a correlation ID to a request so that logs could be connected across a call chain.

The immediate trigger was a mobile client incident where an expired JWT was accepted by one service (missing the `exp` check) but rejected by another on the same request path, producing a confusing 401 that took two days to trace. We needed a single enforcement point for the concerns that must be consistent across all services regardless of implementation language or team.

## Decision
We introduce an API Gateway as the single external entry point for all client traffic -- web, mobile, and partner API consumers. The gateway handles JWT validation, rate limiting, request routing, request ID injection, and structured access logging. It does not handle fine-grained authorization, domain logic, or complex response aggregation.

The gateway runs as a dedicated Express service behind a load balancer. The architectural rule is "thin gateway": any logic that references domain concepts belongs in a service or a BFF, not in gateway configuration.

## Alternatives Considered

**Each service manages its own cross-cutting concerns:** The status quo. Rejected because inconsistency had already caused a production incident. Maintaining auth, rate limiting, and observability in nine services means nine independent implementations that can drift.

**Service mesh as the sole edge layer:** A mesh (Linkerd, Istio) handles mTLS and some observability. Rejected as the external client edge because meshes are designed for service-to-service traffic. JWT validation and tenant-level rate limiting are application-layer concerns that belong in a gateway, not in a proxy sidecar.

**Cloud-managed gateway (AWS API Gateway, Kong Cloud):** Would reduce operational overhead. Rejected initially because we wanted to understand our traffic patterns and configuration requirements before committing to vendor pricing and DSL. This remains a viable option for a future migration once the routing model stabilizes.

## Consequences

### Positive
- Auth, rate limiting, request IDs, and access logging are enforced consistently for every route and client type
- Services can be refactored or replaced without changing client integration points
- Onboarding a new service requires adding a route rule, not writing an auth library
- A single structured access log captures full request volume for SLO measurement and incident triage

### Negative
- The gateway is now a critical path component; an outage or misconfiguration affects all clients simultaneously
- Gateway configuration requires careful versioning and deployment; a bad rate limit rule can block legitimate traffic at scale
- Adds approximately 3-8ms per external request at current traffic levels

### Risks
- **"Fat gateway" accumulation over time.** Mitigation: establish a review gate for any gateway change that touches request or response body content rather than headers and routing rules alone.

## Review Trigger
Revisit if gateway throughput becomes a bottleneck at scale, or if the team's cloud provider offers a managed gateway that would reduce operational burden without adding unacceptable vendor lock-in.

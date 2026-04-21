# ADR-003: Authenticate at edge; authorize in domain services

## Status
Accepted

## Date
2025-08-20

## Context
When the BFFs were introduced, there was a natural question about where JWT validation should occur. The API Gateway already performed structural JWT validation for all external requests (see the API Gateway ADR-002). The question was whether BFFs should additionally validate tokens themselves or trust the identity headers forwarded by the gateway.

The concern driving the question was that BFFs aggregate data from multiple domain services on behalf of users. If a BFF issued downstream calls to domain services and those services performed their own authorization checks, the BFF was not the security boundary -- it was just a proxy. But if the BFF was the authorization boundary, domain services would be reachable via the BFF with no additional protection, making the BFF a high-value target.

A secondary concern arose from the demo environment, which runs without a full API Gateway in front. In that configuration, the BFF is the first point where a JWT can be validated.

## Decision
JWT authentication is validated at the API Gateway for all production traffic. BFFs receive a request with the identity headers already injected by the gateway (`X-User-Id`, `X-User-Roles`, `X-Tenant-Id`) and do not re-validate the JWT signature or claims.

BFFs propagate the identity headers to every downstream domain service call they make. Domain services are responsible for fine-grained authorization: whether this specific user may read this specific resource is decided by the domain service, not the BFF.

In the demo and development environment (no API Gateway), the BFF validates the JWT directly using the same shared JWKS endpoint. This validation path is enabled via an environment flag and is disabled in production.

The internal network topology is a prerequisite for this trust model: domain services must only be reachable from within the private subnet. A domain service that can receive requests from the public internet cannot safely trust BFF-forwarded identity headers.

## Alternatives Considered

**BFF validates JWT independently and does not rely on gateway headers:** Each BFF performs full JWT validation on every request, regardless of whether the gateway already validated it. Rejected because double-validation adds latency without security benefit when the gateway is the authoritative trust boundary. It also requires each BFF to implement and maintain JWKS key rotation logic.

**BFF handles fine-grained authorization for all downstream calls:** The BFF checks whether the user has permission to request each aggregated resource and only makes downstream calls for resources the user is authorized to see. Rejected because it requires the BFF to understand and implement domain-specific permission models. As the number of domain services grows, the BFF would need to know the authorization rules of every service it aggregates, coupling the BFF tightly to domain logic.

**No authentication at the BFF layer; each domain service validates independently:** Every domain service validates the JWT itself; the BFF passes the raw Bearer token through without inspecting it. Rejected because it requires every domain service to implement JWKS fetching, caching, and key rotation -- infrastructure that is expensive to duplicate and easy to implement incorrectly in one service.

## Consequences

### Positive
- Authentication logic exists in exactly one place per environment (gateway in production, BFF in demo)
- BFFs are not responsible for key rotation or JWKS caching, reducing the surface area for auth implementation bugs
- Domain services receive consistent identity context regardless of which BFF (mobile or web) made the request

### Negative
- The security model depends on the gateway being the sole external entry point. If the network perimeter is misconfigured and a domain service is accidentally exposed externally, the trust model breaks without any application-layer safety net in the domain service itself
- BFFs in the demo environment carry auth validation logic that is not exercised in production, creating a gap between the two configurations

### Risks
- **Identity header spoofing in development.** Developers running services locally may not have the full trust chain configured, making it possible to forge identity headers. Mitigation: document the development trust model explicitly and ensure local development uses the same JWKS validation the demo environment uses.

## Review Trigger
Revisit if the team deploys a service mesh with mTLS, at which point domain services can cryptographically verify that requests originate from an authenticated BFF rather than relying on network topology alone.

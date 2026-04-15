# ADR-002: Validate JWT at the gateway; keep fine-grained authorization in services

## Status
Accepted

## Date
2025-06-18

## Context
After adopting the API Gateway, we needed to decide how much of the auth stack to move to the edge. There are two distinct problems. Authentication -- validating that a JWT is genuine and unexpired -- is the same operation regardless of which service a request targets. Authorization -- deciding whether this user may perform this action on this resource -- depends on domain rules that differ per service.

The temptation was to centralize everything: validate the token, check permissions, and forward only pre-authorized requests. This would eliminate duplicate authorization code across services, but it would also couple the gateway to every service's permission model. A permission schema change in any service would require a gateway deployment.

## Decision
The gateway performs structural JWT validation: signature verification, `iss` check, `aud` check, and `exp` check. Any failure results in a 401 before the request reaches an upstream service. On success, the gateway extracts `sub`, `roles`, and `tenant_id` from the token and forwards them as signed headers to the upstream.

Services remain responsible for fine-grained authorization. They trust the identity headers because the gateway is the only entry point and the internal network blocks direct external access to services. Services do not re-validate the JWT signature; they consume the extracted claims.

## Alternatives Considered

**Centralized authorization at the gateway with OPA:** The gateway calls an OPA policy engine for every request. Rejected because this couples all service-specific permission policies to the gateway. A bad policy deployment would affect all services simultaneously, and the gateway team would become a bottleneck for every authorization schema change.

**No gateway auth -- services validate JWTs independently:** Rejected because it reintroduces the inconsistency we were trying to eliminate. One service with a missing `exp` check is all it takes for a security gap, which is exactly how our previous incident occurred.

**Pass the raw Bearer token to services for self-validation:** Services receive the JWT and validate it themselves using a shared JWKS endpoint. Rejected because it requires every service to implement key rotation logic and JWKS caching, duplicating infrastructure code we can centralize at the gateway.

## Consequences

### Positive
- All external requests are authenticated at a single point; no service can accidentally skip JWT validation
- Services are freed from JWT plumbing and focus on domain authorization logic
- Consistent 401 response format for all expired or invalid tokens, regardless of which service was the target

### Negative
- Services must trust gateway-injected identity headers, which requires the internal network to be hardened against external access. This is an infrastructure prerequisite, not just a code change.
- Forwarding claims as headers means any new claim requires a coordinated change between the gateway (to extract it) and the consuming services (to use it)

### Risks
- **Header spoofing if internal network perimeter breaks down.** Mitigation: services run in a private subnet; the gateway is the only internet-facing component. Add network policy enforcement and document it as a hard dependency of this ADR.

## Review Trigger
Revisit if we adopt a service mesh with mTLS, at which point services can cryptographically verify request provenance rather than trusting network topology.

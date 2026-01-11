# ADR-002: Validate JWT at the gateway, authorize in services

## Status
Accepted

## Context
We need a consistent authentication mechanism for external clients. Authorization decisions can be coarse-grained at the edge (route access), but fine-grained authorization (domain rules) must remain in services.

## Decision
- Gateway performs JWT validation (signature, iss/aud/exp) and rejects invalid tokens.
- Gateway adds identity claims to upstream requests (as headers) only after validation.
- Services remain responsible for fine-grained authorization and data access control.

## Consequences
### Positive
- Consistent auth enforcement for all client traffic
- Reduced duplicate JWT validation code across services (optional)

### Negative
- Risk of “trusting headers” if internal network is not secured
- Requires strong internal service auth (mTLS, network policies, or service mesh)

## Mitigations
- Use mTLS / private networking between gateway and services
- Services should treat gateway-added headers as untrusted unless verified by network identity

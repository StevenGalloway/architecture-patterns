# ADR-001: Adopt an API Gateway as the external entry point

## Status
Accepted

## Context
We have multiple backend services with different endpoints and inconsistent cross-cutting implementations (auth, rate limiting, logging). Clients would otherwise need to integrate with many services directly and manage concerns inconsistently.

## Decision
Introduce an API Gateway as the single external entry point for client traffic.

## Consequences
### Positive
- Consistent auth, routing, throttling, and observability
- Simplified client integration and versioning strategy
- Centralized enforcement of edge security policies

### Negative
- Gateway becomes a critical dependency and potential bottleneck
- Configuration mistakes have large blast radius
- Requires operational maturity (HA, alerts, runbooks)

## Notes
Gateway must remain “thin”: policy + routing > business logic.

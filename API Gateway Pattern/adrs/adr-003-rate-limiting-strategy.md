# ADR-003: Implement per-tenant token bucket rate limiting at the gateway

## Status
Accepted

## Context
Traffic spikes and abusive patterns can overwhelm upstream services. We also require fair usage across tenants/clients.

## Decision
Use token-bucket rate limiting at the gateway:
- Limit keys: tenant_id (preferred) + client_id
- Separate limits per route group (e.g., /auth vs /orders)
- Return 429 with Retry-After

## Consequences
### Positive
- Protects upstream services
- Enforces fairness across tenants
- Predictable burst handling

### Negative
- Requires state (in-memory for single node; Redis for distributed)
- Misconfiguration can throttle legitimate traffic

## Notes
Start with conservative defaults and adjust based on observed SLOs.

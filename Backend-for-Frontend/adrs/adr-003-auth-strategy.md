# ADR-003: Authenticate at edge; authorize in domain services

## Status
Accepted

## Context
Clients must authenticate consistently. BFFs should not become a security loophole or concentrate sensitive authorization logic that belongs in domains.

## Decision
- Validate JWT at gateway or BFF (demo example validates at BFF)
- Propagate identity to domain services via headers or token exchange
- Domain services enforce fine-grained authorization on data access

## Consequences
- Consistent identity propagation
- Requires strong internal trust boundary (mTLS / private network / mesh)

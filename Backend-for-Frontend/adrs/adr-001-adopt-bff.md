# ADR-001: Adopt Backend-for-Frontend (BFF) per client experience

## Status
Accepted

## Context
Mobile and web clients require different payload shapes and performance behaviors. Direct calls from clients to many domain services have created chatty traffic, over/under-fetching, and slow product iteration due to cross-team dependencies.

## Decision
Introduce dedicated BFFs:
- Mobile BFF owns mobile-facing contracts and composition
- Web BFF owns web-facing contracts and composition

## Consequences
### Positive
- UI teams own stable contracts and can iterate independently
- Reduced client round trips and smaller payloads
- Domain services remain reusable and less coupled to UI needs

### Negative
- More services to operate and monitor
- Potential duplication across BFFs if governance is weak

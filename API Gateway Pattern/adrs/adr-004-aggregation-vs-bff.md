# ADR-004: Keep aggregation minimal; prefer BFF/composition services for heavy shaping

## Status
Accepted

## Context
Aggregation in the gateway can reduce client round trips but risks turning the gateway into a “fat gateway” with business logic and tight coupling.

## Decision
- Allow only lightweight aggregation in the gateway (simple fan-out with strict timeouts).
- Prefer a dedicated BFF or composition service when:
  - response requires domain logic,
  - multiple dependencies with complex fallback,
  - significant payload reshaping.

## Consequences
### Positive
- Gateway stays thin and maintainable
- Domain logic remains within bounded contexts

### Negative
- More services to operate when BFF is introduced

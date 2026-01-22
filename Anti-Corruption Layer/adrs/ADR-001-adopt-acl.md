# ADR-001: Adopt an Anti-Corruption Layer for vendor integration

## Status
Accepted

## Date
2026-01-11

## Context
We integrate with a vendor system whose data model and API semantics are outside our control. Directly embedding vendor DTOs into the core domain would tightly couple us to vendor churn and reduce our ability to evolve internally.

## Decision
Introduce an **Anti-Corruption Layer (ACL)** as a dedicated adapter that translates vendor DTOs into our internal canonical/domain models.

## Consequences
### Positive
- Vendor changes are localized to the ACL
- Core domain stays stable and internally consistent
- Enables centralized logging, resilience policies, and testing

### Negative
- Adds a component to build/operate
- Requires disciplined scope control to avoid “fat ACL”

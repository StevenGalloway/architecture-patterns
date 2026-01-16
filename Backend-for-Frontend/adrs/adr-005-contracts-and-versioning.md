# ADR-005: Version BFF endpoints and use contract tests

## Status
Accepted

## Context
UI and BFF release cycles are independent. Breaking contract changes can cause production incidents.

## Decision
- Version BFF endpoints (e.g., /mobile/v1/home)
- Maintain a deprecation policy with sunset dates for old versions
- Add consumer-driven contract tests for each client contract

## Consequences
- Safer evolution of contracts
- More endpoints to maintain during deprecation windows

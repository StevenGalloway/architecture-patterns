# ADR-002: BFF is presentation composition only (no domain invariants)

## Status
Accepted

## Context
Without clear boundaries, BFFs can accumulate domain logic (pricing rules, entitlement checks) and become mini-monoliths.

## Decision
Define BFF responsibilities as:
- Data aggregation and view composition
- Presentation shaping
- Client-specific caching and fallbacks
- Contract ownership and versioning

Explicitly exclude:
- System-of-record data ownership
- Domain invariants and business rules
- Cross-domain orchestration that belongs to workflow services

## Consequences
- Keeps domains clean and reusable
- Requires discipline and code review enforcement

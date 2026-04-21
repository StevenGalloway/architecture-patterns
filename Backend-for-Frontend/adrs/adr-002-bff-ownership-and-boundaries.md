# ADR-002: BFF is presentation composition only (no domain invariants)

## Status
Accepted

## Date
2025-06-25

## Context
Two months after the Mobile BFF launched, the mobile team added pricing logic directly into the BFF. The reasoning was pragmatic: the Pricing service returned raw rule objects that required calculation to arrive at the displayed price, and the mobile team needed that calculation available quickly without waiting for the Pricing service team to add a pre-computed endpoint.

The pricing logic worked, but it created a correctness problem: the canonical pricing calculation now existed in two places, the Pricing service and the Mobile BFF, with no mechanism to keep them in sync. Three weeks later, the Pricing team updated a promotional discount rule. The BFF calculation was not updated. Mobile users were shown incorrect prices during a weekend sale.

This was a direct consequence of not having defined what belongs in a BFF at the time of adoption. "Belongs to the UI team" was not a sufficient constraint. We needed an explicit boundary that both product engineers and reviewers could apply consistently during code review.

## Decision
BFF responsibilities are explicitly defined as:

**In scope:**
- Fan-out aggregation of upstream domain service responses into a single client response
- Payload shaping: field selection, renaming, nesting for client convenience
- Client-specific caching policies (response TTLs appropriate for mobile vs. web context)
- Partial response fallback behavior when upstream services are unavailable
- Contract versioning and endpoint lifecycle management for client-facing APIs

**Out of scope (belongs in domain services):**
- Any calculation or rule that determines correctness of business data (prices, entitlements, inventory availability)
- Data ownership: the BFF does not write to any database as a system of record
- Cross-domain orchestration that spans multiple bounded contexts as a workflow (e.g., place order + reserve inventory + notify fulfillment)
- Authorization decisions beyond "is this user authenticated"

The test for scope: if the logic would produce incorrect business outcomes if it were removed from the BFF and the domain service also had the logic, it belongs in the domain service only.

## Alternatives Considered

**BFF as a full service layer with domain logic:** Accept that BFFs may contain business logic and treat them as first-class domain services with full ownership of the rules they implement. Rejected because BFFs are owned by frontend teams whose primary expertise is presentation, not business rule correctness. Correctness incidents like the pricing bug are predictable outcomes of this ownership model.

**No explicit boundary rules; rely on code review judgment:** Trust reviewers to identify when business logic has crossed into a BFF without codifying the boundary. Rejected because without a written rule, there is no consistent basis for rejecting a PR. The pricing logic was reviewed and merged; the reviewer had no clear rule to cite.

**Technical enforcement via linting or service dependency rules:** Add static analysis that prevents BFF code from importing domain rule modules. Partially adopted: the BFF code review checklist includes a specific question about domain rule imports. Full automated enforcement is impractical because the boundary is semantic, not always syntactic.

## Consequences

### Positive
- Domain service teams own all correctness-critical calculations without risk of a BFF maintaining a diverging copy
- The boundary is specific enough to apply during code review without extensive interpretation
- BFF testing is focused on composition correctness and contract shape, not business rule correctness

### Negative
- Enforcing the boundary requires ongoing reviewer discipline; it is not automatically enforced by tooling
- Some presentation computations (display formatting, string interpolation, currency rounding) sit close to the boundary and require judgment calls during review

### Risks
- **"Temporary" domain logic that becomes permanent.** The pricing incident started as a short-term workaround. Without a process to clean up pragmatic boundary violations, they compound. Mitigation: any boundary violation merged as a temporary workaround must have a linked ticket in the domain service team's backlog with a target date, and the BFF code includes a comment referencing that ticket.

## Review Trigger
Revisit if the domain service APIs consistently fail to expose pre-computed fields that BFFs need, causing repeated pressure to duplicate logic. That pattern indicates the domain service APIs need richer response shaping, not that the BFF boundary should be relaxed.

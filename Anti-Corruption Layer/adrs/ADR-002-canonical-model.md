# ADR-002: Define an internal canonical customer model for integration

## Status
Accepted

## Date
2025-06-11

## Context
Once the ACL was introduced as a boundary (ADR-001), we faced a second problem: what exactly should the ACL translate vendor data *into*? Initially, each internal service defined its own local representation of a customer. The Orders service had a `Customer` struct with snake_case fields. The Fulfillment service had a `CustomerRecord` type with PascalCase properties and a separate `AddressInfo` type. Neither matched the other, and both had been shaped by the vendor's original field names.

When we added a third integration that needed to pass customer data from Orders to Fulfillment, there was no shared type to use. Each service had to re-map the other's representation. We were now doing more mapping work than before the ACL existed, just inside the application layer instead of at the vendor boundary.

The absence of a canonical model turned the ACL into a fan-out mapping library instead of a single translation point. Without an owned internal definition of "what a customer is," every new consumer had to answer that question independently.

## Decision
Define a single **CanonicalCustomer** type owned by the domain, not derived from any vendor schema. The canonical model has stable internal field names using consistent casing (`accountId`, `fullName`, `contactEmail`), explicit optional types with no implicit null semantics, and normalized enumerations (`AccountTier.STANDARD` rather than vendor strings like `"tier_1"` or `"basic"`).

The canonical model is defined in a shared internal library versioned independently of vendor integrations. The ACL owns all `VendorDTO → CanonicalCustomer` mapping functions. No service outside the ACL imports or references vendor types.

Field mapping rules are documented in a mapping spec file alongside the ACL code. When a vendor field changes, the mapping spec is updated first; the code change follows from it. This makes the mapping intent explicit and reviewable without tracing function bodies.

## Alternatives Considered

**Use the most recent vendor schema as the de-facto canonical model:** The vendor's v3 schema is reasonably clean and internal teams can adapt to it. Rejected because it re-creates the coupling problem. If the vendor releases v4, we are back to coordinating changes across all consumers.

**Generate the canonical model from an OpenAPI spec:** Use the vendor's published OpenAPI document to auto-generate internal types and regenerate on each vendor release. Rejected because generated types reflect vendor naming and optionality choices, not domain semantics. Automation is useful for detecting changes, not for defining canonical meaning.

**Define a canonical model per bounded context (Orders canonical, Fulfillment canonical):** Each service owns its own internal customer type. Rejected because it makes cross-service data flow impossible without an additional translation step, which is exactly the problem that surfaced when Orders and Fulfillment needed to share customer data.

## Consequences

### Positive
- Internal services share a consistent representation of a customer regardless of which vendor provides the data
- The canonical model can be versioned independently, with a clear migration path when domain semantics evolve
- A single mapping spec makes vendor-to-canonical differences auditable without reading code

### Negative
- The canonical model requires schema governance: changes that affect field names or types must be reviewed for downstream impact across all consumers
- Mapping tests must be updated whenever the canonical model or vendor schema changes, adding maintenance overhead

### Risks
- **Canonical model drift from domain reality.** If the model is not updated when the domain evolves, services start working around the canonical type (adding their own local extensions), which recreates the fragmentation we were solving.

## Review Trigger
Revisit if a second vendor integration is added whose model has meaningfully different semantics for the same concept (e.g., a vendor that uses individual/organization as a top-level discriminator rather than account tier). At that point, determine whether the canonical model needs to be more flexible or whether a separate canonical type is warranted.

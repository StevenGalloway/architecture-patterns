# ADR-001: Adopt an Anti-Corruption Layer for vendor integration

## Status
Accepted

## Date
2025-04-02

## Context
We integrate with a third-party CRM vendor whose data model and API contract are entirely outside our control. When the integration was first built eighteen months ago, vendor DTOs were used directly in the Orders and Fulfillment services. The assumption was that the vendor's model was stable enough to treat as a shared type.

That assumption broke when the vendor released v3 of their customer API. They renamed `customer_type` to `account_classification`, changed the `address` field from a flat string to a nested object, and quietly made `phone` nullable in v3 while it had been required in v2. The breakage cascaded: three services that imported the vendor DTO compiled fine but produced incorrect output because they used `customer_type` as a discriminator for routing logic. Finding every usage took two days. The migration required coordinated deployments across six services.

We needed to ensure that future vendor changes never again required simultaneous changes across multiple bounded contexts. The vendor's model is a foreign dialect; our domain has its own language, and we need a translator at the boundary.

## Decision
Introduce an **Anti-Corruption Layer (ACL)** as a dedicated adapter service that translates vendor DTOs into our internal canonical domain models. The ACL is the only system component that imports or references vendor types directly. All internal services consume the canonical model.

The ACL exposes typed translation functions: `toCanonicalCustomer(VendorCustomerV2 | VendorCustomerV3): CanonicalCustomer`. It owns the detection of which vendor schema version is in use, normalizes fields to canonical names, and handles optional/nullable semantics explicitly. Internal services have no awareness of vendor versioning.

The ACL is not a general-purpose integration gateway. It does not apply business rules. It does not orchestrate multi-step vendor workflows. If logic requires understanding what a vendor response *means* for our business, that logic belongs in a domain service that consumes canonical models.

## Alternatives Considered

**Wrap vendor types in a thin interface layer within each service:** Each service defines its own interface over the vendor DTO and adapts locally. Rejected because this reproduces the coupling problem one layer up -- if the vendor field name changes, every wrapper interface changes. There is no single place to fix the mapping.

**Versioned DTOs shared via a common library:** Publish vendor DTOs as a versioned internal package that all services depend on. Rejected because a library update still requires each consuming service to re-test and redeploy. The coupling is less severe than direct vendor imports but still requires coordinated changes.

**Replace the vendor integration with a vendor-agnostic event stream:** Route all vendor data through an event bus using our own schema. This is the long-term direction but requires the vendor to support webhooks or a streaming interface, which is not available on our current contract tier.

## Consequences

### Positive
- Vendor API changes are absorbed entirely within the ACL; internal services require no changes as long as canonical semantics are preserved
- The ACL provides a single place to add logging, metrics, retry policies, and circuit breaker behavior for all vendor calls
- Onboarding a second vendor integration requires adding a new ACL adapter, not modifying existing domain services

### Negative
- Adds a component to build, deploy, and operate with its own availability and latency budget
- Requires disciplined scope control: there is a recurring temptation to add routing or business logic into the ACL because it is the first point where vendor data is available in a useful form

### Risks
- **"Fat ACL" accumulation.** Without active review gates, the ACL will absorb domain logic over time. Mitigation: any ACL change that references a business concept (customer tier, routing rule, pricing category) triggers a mandatory architecture review before merge.

## Review Trigger
Revisit if the vendor relationship ends or if a replacement vendor's model is sufficiently close to canonical that the ACL translation becomes a pass-through with no meaningful normalization. Also revisit if the team moves to event-sourced vendor ingestion, at which point the ACL role shifts from synchronous adapter to schema-normalizing event consumer.

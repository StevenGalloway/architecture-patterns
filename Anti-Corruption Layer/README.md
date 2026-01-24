# Anti-Corruption Layer (ACL) Pattern

## Summary
An **Anti-Corruption Layer (ACL)** is an integration boundary that **protects your core domain** from the models, semantics, and volatility of external systems (vendors, legacy platforms, ERPs, CRMs).

Instead of importing an external model directly, the ACL:
- translates external contracts into **internal canonical/domain models**,
- isolates “weirdness” (naming, types, status codes, nullability, identifiers),
- provides resilience (retries, fallbacks, circuit breakers),
- enables contract testing and controlled change management.

This pattern is especially common in enterprise modernization, M&A integration, and vendor platforms where external changes are outside your control.

---

## Problem
Directly integrating external systems often causes:
- the external model to “leak” into your core domain,
- widespread refactors when the vendor changes fields or semantics,
- inconsistent mappings scattered across services,
- brittle integrations and production incidents when payloads drift.

---

## Constraints & Forces
- Vendor APIs evolve on their schedule; changes may be undocumented or late-notified
- Data quality issues (missing fields, inconsistent IDs, non-standard enums)
- Performance constraints (vendor latency, throttling, outages)
- Compliance constraints (PII handling, auditability)
- Need for internal stability and domain correctness

---

## Solution
Create an **ACL Adapter** between your core domain and the external system:

**Core Domain → (Canonical Model) → ACL Adapter → Vendor System**

Responsibilities of the ACL:
1. **Translation**
   - map vendor DTOs to internal canonical/domain models
   - normalize types, enums, IDs, dates, optional fields
2. **Policy enforcement**
   - validate required fields
   - enforce internal invariants at the boundary (not business rules deep in domain)
3. **Resilience**
   - timeouts, retries (idempotent reads), circuit breakers
   - caching where appropriate
4. **Contract management**
   - contract tests against vendor schema
   - versioned mappings and migration strategy
5. **Observability**
   - structured logs, metrics, tracing with correlation IDs

---

## When to Use
- Integrating with vendor/legacy systems with unstable or poor domain modeling
- You need to insulate internal systems from external churn
- You have multiple internal consumers and want consistent mapping and governance
- You need compliance controls at integration boundaries

---

## When Not to Use
- You control both systems and they share a bounded context
- The external contract is stable and identical to your domain model (rare)
- Overhead is not justified for a small one-off integration

---

## Tradeoffs
### Benefits
- Domain purity and stability
- Faster internal evolution; external changes localized
- Better testability and observability of integrations
- Centralized governance for vendor mappings

### Costs / Risks
- Extra component and mapping work
- Risk of ACL becoming a “dumping ground” if scope is not controlled
- Need for strong versioning and change management discipline

---

## Failure Modes & Mitigations
1. **Vendor payload drift breaks mapping**
   - Mitigation: schema validation + contract tests + feature flags for mapping versions
2. **Vendor outages / throttling**
   - Mitigation: caching, circuit breaker, fallback paths, bulkheads
3. **Silent semantic changes (field meaning changes)**
   - Mitigation: data quality checks, monitoring for distribution shifts, alerts
4. **Inconsistent mapping implementations across teams**
   - Mitigation: central ACL ownership and shared canonical model definitions
5. **ACL grows business logic**
   - Mitigation: keep ACL limited to translation + boundary validation + resilience

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-translation-sequence.mmd`
- `diagrams/03-versioned-mapping.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-acl.md`
- `adrs/ADR-002-canonical-model.md`
- `adrs/ADR-003-resilience-and-timeouts.md`
- `adrs/ADR-004-contract-testing.md`
- `adrs/ADR-005-versioning-and-migration.md`

---

## Example
See `examples/node-acl/` for a minimal runnable demo:
- `core-domain-service` calls the ACL for customer profile data
- `acl-adapter` calls a vendor API and translates vendor payload → canonical customer model
- `vendor-system-mock` simulates a vendor with “weird” field names/types/enums

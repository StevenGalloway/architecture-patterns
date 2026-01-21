# Strangler Fig Pattern (Modernization)

## Summary
The **Strangler Fig** pattern incrementally replaces a legacy system by **routing slices of functionality** to new components over time. The new system “grows around” the legacy until the legacy can be retired.

This is a practical enterprise modernization pattern because it:
- avoids big-bang rewrites,
- minimizes downtime,
- enables incremental risk reduction,
- supports parallel delivery (legacy + new).

---

## Problem
Legacy systems often:
- are hard to change safely (fragile coupling, minimal tests),
- have slow release cycles,
- lack observability and automated deployment practices,
- constrain new product work.

A full rewrite is risky and often fails due to long timelines, unclear requirements, and operational surprises.

---

## Constraints & Forces
- The business requires **continuous availability**
- The legacy system is **still the system of record**
- There are **hidden dependencies** and undocumented behaviors
- Data is often shared, duplicated, or poorly modeled
- You need safe rollbacks and progressive delivery
- You must manage **data consistency** during transition

---

## Solution
Introduce an **Edge Router** (API Gateway / reverse proxy / routing layer) to direct requests:
- Most traffic continues to the legacy system initially
- New functionality is implemented in new services
- Routing gradually shifts from legacy to new services
- Eventually, the legacy routes are removed and the legacy system is decommissioned

### Common approaches for routing seams
1. **Path-based routing**
   - e.g., `/billing/*` → New Billing Service
2. **Header / tenant-based routing**
   - send specific tenants to the new service first
3. **Percentage-based canary routing**
   - gradually increase traffic to the new service
4. **Feature flags** (especially for UI-level cutover)
5. **Event-driven duplication**
   - new service consumes the same events and becomes authoritative for a slice

---

## Phases (recommended)
1. **Baseline & protect**
   - Add observability at edge
   - Add synthetic checks and dashboards
2. **Create a seam**
   - Introduce router and stable external contract
3. **Carve the first slice**
   - Choose a low-risk domain slice with clear boundaries
4. **Parallel run (shadow)**
   - Shadow reads, compare outputs, log diffs
5. **Progressive cutover**
   - Canary + rollback
6. **Retire legacy components**
   - Remove routes, archive code, decommission infra

---

## Key decisions checklist
- **Seam selection:** where can routing occur with minimal coupling?
- **Data strategy:** shared DB, replicated data, or parallel writes?
- **Consistency model:** strong vs eventual; reconciliation plans
- **Rollback plan:** immediate route rollback; data rollback if needed
- **Verification:** shadow reads, golden datasets, diff tooling
- **Operational readiness:** dashboards, alerts, runbooks

---

## Tradeoffs
### Benefits
- Lower risk than rewrite; incremental value delivery
- Clear migration checkpoints; measurable progress
- Enables modern practices (CI/CD, tracing) alongside legacy

### Costs / Risks
- Temporary complexity: two systems in production
- Data synchronization and correctness challenges
- Requires disciplined governance to avoid “forever hybrid” state

---

## Failure Modes & Mitigations
1. **Data divergence (legacy vs new)**
   - Mitigation: shadow compare; reconciliation jobs; outbox/CDC; idempotency
2. **Hidden legacy dependencies**
   - Mitigation: traffic analysis; contract tests; phased rollout by tenant
3. **Partial cutovers without ownership clarity**
   - Mitigation: define “source of truth” for each slice; migration runbooks
4. **Edge router misconfiguration**
   - Mitigation: config validation; canary route changes; automated smoke tests
5. **Rollback leaves inconsistent data**
   - Mitigation: write fencing; compensations; dual-write only when unavoidable

---

## When Not to Use
- No safe routing seam exists and cannot be introduced
- The legacy system is low value and can be replaced outright
- Data model cannot be split without major redesign and the business won’t accept staged correctness work

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-shadow-compare-sequence.mmd`
- `diagrams/03-canary-routing.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-strangler-fig.md`
- `adrs/ADR-002-seam-and-routing-strategy.md`
- `adrs/ADR-003-data-transition-strategy.md`
- `adrs/ADR-004-shadow-reads-and-verification.md`
- `adrs/ADR-005-cutover-and-decommission.md`

---

## Example
See `examples/node-strangler-fig/` for a minimal runnable demo:
- **edge-router** routes `/billing/*` to the new service and everything else to legacy
- **legacy-monolith** contains a legacy billing endpoint and another legacy endpoint
- **new-billing-service** replaces only the billing slice

# Data Mesh Pattern (Practical + Enterprise-Ready)

## Summary
**Data Mesh** is an organizational and architectural paradigm for scaling analytics by treating data as a product and distributing ownership to **domain teams** while providing shared **platform capabilities** and **federated governance**.

Four pillars (commonly referenced):
1. **Domain-oriented ownership** (teams own data end-to-end)
2. **Data as a product** (discoverable, trustworthy, with SLOs/contracts)
3. **Self-serve data platform** (standard tooling, golden paths)
4. **Federated computational governance** (shared rules enforced via automation)

Data Mesh is not "one tool." It's a set of practices and interfaces that make data product ownership viable at scale.

---

## Problem
Centralized data teams become bottlenecks:
- slow onboarding of new sources/domains
- inconsistent semantics across datasets
- lack of accountability for data quality
- fragile pipelines and unclear ownership
- scaling cost in people and time

---

## Forces & Constraints
- Many domains with unique semantics and cadence
- Need consistent security, lineage, and quality without central bottlenecks
- Discoverability and interoperability across domains
- Regulatory controls (PII, retention, access review)
- Avoid "data swamp" by enforcing product standards

---

## Solution
### Data Mesh Operating Model
- **Domain teams** publish **data products** with clear contracts, quality checks, and documentation.
- A **platform team** provides paved roads:
  - ingestion, transformation, orchestration
  - metadata catalog and lineage
  - policy-as-code (RBAC, PII controls)
  - cost/usage monitoring
- **Federated governance** defines standards and uses automation to enforce them (CI gates, contract validation).

### What a "Data Product" includes
- **Contract**: schema + semantics + freshness + SLOs
- **Ownership**: owner group, on-call/Slack, escalation path
- **Quality**: tests, expectations, anomaly checks
- **Lineage**: upstream/downstream visibility
- **Access**: classification and policy tags
- **Versioning**: semantic versioning for breaking changes

---

## When to Use
- Large orgs with many domains and fast-changing analytics needs
- Multiple pipelines and teams competing for central data engineering capacity
- Need for strong ownership + productization of data
- Regulated environments needing consistent policy enforcement

## When Not to Use (or be careful)
- Very small orgs with few domains (mesh overhead may exceed value)
- No platform ownership (mesh fails without a paved road)
- Teams unwilling/unable to own data products end-to-end

---

## Repo Structure (recommended)
- `governance/` standards, templates, policy-as-code, SLO definitions
- `data-products/` domain-owned product docs and contracts (lightweight examples)
- `examples/` runnable local demo showing domain products, contracts, quality + lineage

---

## Runnable Example (Different Tech)
This repo includes a local "mesh-like" demo using:
- **dbt + DuckDB** for transformations
- **OpenLineage + Marquez** for lineage capture
- **Docker Compose** for a repeatable local stack

See: `examples/local-mesh-dbt-duckdb-openlineage/`.

---

## Security Considerations

Data Mesh distributes data ownership to domain teams — and with it, the attack surface. In a centralized data architecture, a single team is responsible for access controls on all data pipelines. In Data Mesh, every domain team owns pipelines that may process sensitive data. The platform must enforce security controls that domain teams cannot opt out of, because inconsistent enforcement at scale is equivalent to no enforcement.

**Core security controls that must be platform-enforced (not team-optional):**
- PII tagging is mandatory at the data product schema level. A data product cannot deploy without a classification label on every field. The CI gate blocks deployment if any field is missing its `pii_classification` annotation.
- Access control is applied at the data product layer, not at the warehouse table layer. Consumers must request access through the platform's access control layer; direct table queries bypass access governance and must be blocked via warehouse row-level security.
- GDPR right-to-erasure requires lineage tracing to determine which data products contain records about a data subject. The mesh's lineage infrastructure must support `subject_id` → data product traversal. Without lineage, erasure becomes a manual investigation across dozens of domain-owned pipelines.
- No domain team may publish a data product containing data from another domain without explicit cross-domain access authorization logged in the access control layer.

**Compliance relevance:** GDPR Art. 17 (right to erasure requires lineage to trace affected data products), GDPR Art. 30 (every data product is a processing activity requiring documentation), SOC 2 CC6.3 (access to data products must be role-based and reviewed quarterly), PCI DSS (no payment card data in any data product without dedicated security review).

→ See [SECURITY.md](SECURITY.md) for the full threat model, 9-entry attack surface table, PII propagation controls, cross-domain access governance, and the 10-item data product security review checklist.

---

## Observability Considerations

In a Data Mesh, there is no single team responsible for the full data lifecycle. Observability must be federated too: domain teams monitor their own data products, but the platform provides the aggregation layer for cross-domain visibility. A data quality incident in one data product that propagates to 15 downstream consumers requires mesh-level lineage tracing to diagnose and contain — not just product-level monitoring.

**Data Mesh golden signals (adapted from the four golden signals):**
- **Latency (as Freshness):** `data_product.freshness_hours` — time since last successful refresh. Alert when freshness exceeds the product's declared SLO (e.g., a daily product that hasn't refreshed in 25 hours is in SLO breach). This is the most important signal: stale data is the primary failure mode in a mesh.
- **Traffic (as Consumption):** `data_product.query_count` per product per consumer team per day. A product with zero queries for 30 days is a candidate for deprecation. A product with rapidly growing queries has implicit dependents that need to be in the formal consumer registry.
- **Errors (as Quality):** `data_product.quality.completeness_pct`, `data_product.quality.null_rate` per required field, `data_product.schema.contract_violations` (when a consumer's declared query fails against the current schema). Schema contract violations are breaking changes that must be caught before consumers silently receive wrong data.
- **Saturation:** `platform.warehouse.credit_utilization` by domain. A domain team consuming 40% of the shared warehouse credit without a proportional business output is a resource governance issue.

**SLO targets (reference):** Data Product Freshness SLO — each product refreshes within its declared cadence SLO in ≥99% of windows. Data Quality SLO — completeness ≥ declared threshold on every refresh.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference adapted for data products, SLI/SLO definitions, structured event log schema, four dashboard designs, chaos engineering scenarios, and the three-tier alerting philosophy.

---

## Team Topology

Data Mesh is explicitly a team topology solution. The pattern was designed by Zhamak Dehghani specifically to address what Conway's Law predicts: a centralized data team produces centralized, bottlenecked data pipelines. Distributing ownership to domain teams is the architectural move — the technology follows.

**The ownership model:**
- **Data Platform Team** (platform team): owns data infrastructure, transformation tooling, catalog, lineage, governance automation, and CI gates. Does not own any data product.
- **Domain Data Teams** (stream-aligned): own data products for their domain — ingestion, transformation, quality checks, SLOs, on-call. They are accountable for the data product's freshness and correctness.
- **Data Governance Council** (enabling team): defines standards — PII policies, naming conventions, semantic layer conventions — and reviews for compliance. Does not approve individual data products (that would make it a bottleneck).

**Conway's Law implication:** The organizational structure that produces a 6-week data pipeline backlog (centralized team, distributed domain knowledge) is the same structure that makes Data Mesh impossible to implement. Data Mesh succeeds only when domain teams have both the ownership and the capability to build their own data products. A "Data Mesh" where domain teams file tickets to a central team to build their products is centralization with better naming.

**The signal to watch:** If more than 30% of data product creation requests require platform team involvement beyond self-service tooling, the platform hasn't abstracted the right things. Domain teams should be able to ship a new data product without a platform team ticket.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the full team classification, Conway's Law analysis, interaction modes table, cognitive load mitigation strategy, and scaling model from fewer than 5 to 15+ domains.

---

## Cost Analysis

Data Mesh has a higher platform investment cost than centralized data engineering, but a lower marginal cost per new data product at scale. The centralized model scales linearly with data engineers hired; the mesh model scales through domain team capability.

| Scale | Monthly infrastructure | Engineering overhead |
|---|---|---|
| Small (3-5 domains) | ~$750-1,500/mo (dbt Cloud + DW + catalog) | 0.5-1 FTE platform team |
| Medium (8-15 domains) | ~$12,000-33,000/mo | 2-4 FTE platform team |
| Large (20+ domains) | ~$950K-$3.45M/year (enterprise stack) | 5-10 FTE platform team |

**The break-even argument:** The centralized model's cost at scale is: N pipeline requests × average data engineer weeks per pipeline × fully-loaded FTE rate. At 47 pending requests × 3 weeks each × $3,000/week engineer cost = $423,000 in backlogged work, plus the opportunity cost of decisions delayed 6 weeks. The mesh model replaces central pipeline delivery with domain team ownership and platform tooling — a structural cost reduction at the price of platform investment.

**Largest hidden cost:** Domain team skill uplift. Product engineers who are not data engineers now own data pipelines. Expect 2-4 weeks of ramp time per domain team, ongoing support demand, and some data quality incidents during the transition period.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full pricing comparison across tooling options at 3 org scales, break-even analysis comparing centralized vs. distributed model costs, and cost anti-patterns specific to Data Mesh adoption.

---

## AI Integration

Data Mesh is the foundational data architecture for enterprise AI. The same structural problems that Data Mesh solves for analytics (centralized bottleneck, unclear ownership, inconsistent quality) reappear in AI/ML data management if the mesh isn't designed to accommodate AI-specific data products from the start.

**Key AI/Data Mesh intersections:**
- **AI feature stores as data products:** ML features (user embeddings, product vectors, behavioral signals) are data products in the mesh — owned by domain teams, versioned, and consumed via contracts. The Recommendations domain owns item embeddings; the User domain owns behavioral features. Feature freshness SLOs are first-class data product SLOs.
- **Training data as a data product:** Labeled datasets and training corpora are first-class data products with quality SLAs, lineage tracking, and access contracts. The team that understands the domain should own the training data quality, not the ML platform team.
- **Federated model governance:** Just as the mesh federates data governance (central standards, domain enforcement), model governance follows: the platform defines data usage policies for AI training; domain teams enforce them for their own models. This directly mirrors the federated governance pillar.
- **AI lineage:** Tracking which training data produced which model version is an extension of OpenLineage that the mesh's lineage infrastructure supports via custom facets. `TrainingRunFacet` links a model artifact to the training data products it was trained on.
- **Domain-owned model serving:** In a mature mesh, domain teams own their inference endpoints; the platform provides serving infrastructure (deployment pipelines, scaling, monitoring) as a platform service.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full treatment: feature store data product contract schema, training data ownership model, federated model governance design, OpenLineage TrainingRunFacet extension, and domain-owned model serving patterns.

---

## Platform Engineering

Data Mesh is fundamentally a platform engineering problem. Without a capable platform team building the paved road, domain teams will either fail to adopt the mesh or revert to centralized patterns. The platform must absorb enough complexity that owning a data product feels like owning a software service — not like becoming a data engineer.

**The paved road:** A domain team that creates a new data product should receive: warehouse table provisioning, catalog entry creation, lineage registration, access control setup, CI quality gates, and monitoring dashboards — automatically, from a manifest file, without a platform team ticket.

```yaml
data_product:
  name: orders_daily_revenue
  domain: orders
  owner: orders-data@company.com
  classification: internal
  refresh_cadence: daily
  slo:
    freshness_hours: 25
    completeness_pct: 99.5
  schema_path: schemas/orders_daily_revenue.json
  pii_fields: []
```

**Platform contract:** Warehouse compute availability 99.5%, catalog ingestion within 1 hour of deploy, lineage capture for all platform-managed transformations, PII detection scan on every deploy, access control provisioning within 5 minutes of request approval.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the full paved road comparison table, complete data product manifest schema, platform CI automation steps, platform contract SLA table, local DuckDB development workflow, and 6 anti-patterns that indicate the platform is failing.

---

## Business Case

Data Mesh replaces a 6-week pipeline delivery backlog with domain team ownership — turning a structural bottleneck into a capability multiplier, at the cost of platform investment and domain team ramp-up time.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for CPO, CFO, VP Engineering, and Chief Data Officer: the 47-request, 6-week-wait structural problem in plain language, implementation cost in engineer months and monthly infrastructure, four specific business gains, and the risk of inaction at current growth rates.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (domain owners, consumers, governance officer, external systems)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (data product registry, pipeline engine, quality gate, lineage tracker, access control, governance automation, self-service portal)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-data-product-contract.mmd](diagrams/02-data-product-contract.mmd) — Data product contract structure and consumer access flow
- [03-federated-governance-flow.mmd](diagrams/03-federated-governance-flow.mmd) — Federated governance policy enforcement via CI/CD

---

## Architecture Decision Records
- [ADR-001: Adopt Data Mesh operating model for analytics scaling](adrs/ADR-001-adopt-data-mesh.md)
- [ADR-002: Data product contracts and interface standards](adrs/ADR-002-data-product-contracts.md)
- [ADR-003: Federated governance via policy-as-code](adrs/ADR-003-federated-governance-policy-as-code.md)
- [ADR-004: Self-serve platform capabilities](adrs/ADR-004-self-serve-platform-capabilities.md)
- [ADR-005: Interoperability and discoverability standards](adrs/ADR-005-interop-and-discoverability.md)

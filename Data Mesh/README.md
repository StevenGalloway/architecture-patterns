# Data Mesh Pattern (Practical + Enterprise-Ready)

## Summary
**Data Mesh** is an organizational and architectural paradigm for scaling analytics by treating data as a product and distributing ownership to **domain teams** while providing shared **platform capabilities** and **federated governance**.

Four pillars (commonly referenced):
1. **Domain-oriented ownership** (teams own data end-to-end)
2. **Data as a product** (discoverable, trustworthy, with SLOs/contracts)
3. **Self-serve data platform** (standard tooling, golden paths)
4. **Federated computational governance** (shared rules enforced via automation)

Data Mesh is not “one tool.” It’s a set of practices and interfaces that make data product ownership viable at scale.

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
- Avoid “data swamp” by enforcing product standards

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

### What a “Data Product” includes
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

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-data-product-contract.mmd`
- `diagrams/03-federated-governance-flow.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-data-mesh.md`
- `adrs/ADR-002-data-product-contracts.md`
- `adrs/ADR-003-federated-governance-policy-as-code.md`
- `adrs/ADR-004-self-serve-platform-capabilities.md`
- `adrs/ADR-005-interop-and-discoverability.md`

---

## Repo Structure (recommended)
- `governance/` standards, templates, policy-as-code, SLO definitions
- `data-products/` domain-owned product docs and contracts (lightweight examples)
- `examples/` runnable local demo showing domain products, contracts, quality + lineage

---

## Runnable Example (Different Tech)
This repo includes a local “mesh-like” demo using:
- **dbt + DuckDB** for transformations
- **OpenLineage + Marquez** for lineage capture
- **Docker Compose** for a repeatable local stack

See: `examples/local-mesh-dbt-duckdb-openlineage/`.

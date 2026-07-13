# Platform Engineering — Data Mesh Pattern

## The Mesh Is a Platform Engineering Problem

The four pillars of Data Mesh are not organizational aspirations — they are platform engineering deliverables. Domain-oriented ownership only works if domain teams have tooling that makes pipeline ownership tractable. Data as a product only works if the platform makes product definition and publishing mechanical. Federated governance only works if the platform enforces standards automatically without requiring a human reviewer on every data product. Interoperability only works if the platform provides a consistent interface layer that makes data products composable across domains.

If the platform engineering work is not done, Data Mesh degrades to: domain teams writing bespoke pipelines in incompatible frameworks, a data catalog nobody can find things in, governance that is aspirational rather than enforced, and consumers who go back to querying source databases directly because "the data products are too hard to access."

The platform team's north star: a domain engineer with no prior data engineering experience should be able to create, test, and deploy a data product in 2 days using the paved road, without filing a single ticket to the platform team.

---

## The Paved Road: With vs. Without Platform

| Without Platform (Dirt Road) | With Platform (Paved Road) |
|---|---|
| Each domain team picks their own pipeline tool (Spark, pandas, dbt, SQLMesh) | Standard pipeline framework: dbt + the company's warehouse; one framework to learn, one set of docs, one CI integration |
| Each domain defines its own warehouse table structure and naming | Platform-managed schemas with auto-generated table names from the manifest; naming convention enforced at deploy |
| Each domain writes its own documentation format (or skips it) | Documentation auto-generated from schema annotations in `schema.yml`; catalog entry created automatically on deploy |
| Each domain manages its own warehouse access grants | Platform-managed access control; domain teams declare consumers in the manifest; platform provisions grants |
| Each domain decides whether to capture lineage | Lineage capture is automatic for all platform-managed transformations; domain teams cannot opt out |
| Each domain invents its own quality tests | Quality test library with standard tests (not-null, uniqueness, referential integrity, freshness, row count delta); domain teams add domain-specific tests on top |
| Each domain writes its own alerting for pipeline failures | Platform provides standard alerting for freshness SLO breaches and quality failures; domain teams receive alerts for their own products only |

The cost of the dirt road is not just inconsistency — it is cognitive load. A domain team that has to make 15 infrastructure decisions before writing a single transformation is unlikely to adopt data product ownership enthusiastically.

---

## Self-Service Data Product Creation

The creation of a new data product should require no interaction with the platform team. The process:

1. Domain team clones the data product template from the platform's scaffold generator
2. Team fills in `data-product.yaml` (manifest) and adds transformation models and quality tests
3. Team pushes to their repository
4. Platform CI runs governance gates (PII check, schema validation, credential scan)
5. On gate passage, platform automation creates: warehouse schema + tables, catalog entry, lineage registration, access control policy
6. Consumers discover the product in the catalog and submit access requests via the self-service portal

**The data product manifest (`data-product.yaml`):**

```yaml
data_product:
  name: orders_daily_revenue
  domain: orders
  owner: orders-data@company.com
  classification: internal          # restricted | internal | public
  refresh_cadence: daily
  slo:
    freshness_hours: 25             # alert if not refreshed within 25 hours
    completeness_pct: 99.5          # alert if completeness drops below 99.5%
    row_count_min: 100              # alert if fewer than 100 rows (data loss indicator)
  schema_path: schemas/orders_daily_revenue.json
  pii_fields: []                    # explicit empty list required; CI blocks if omitted
  consumers:
    - finance
    - analytics
  tags:
    - revenue
    - orders
    - financial-reporting
  version: "1.0.0"
```

The manifest is the contract between the domain team and the platform. Every field the platform needs to provision infrastructure is derived from this file. Domain teams do not interact with warehouse admin tools, catalog admin UIs, or access control systems directly — the manifest is the interface.

**What platform CI does automatically on push:**

```
Governance Gate
  ├─ Schema validation: all fields present, pii_fields explicit
  ├─ PII detection: scan dbt models for known PII patterns; cross-reference pii_fields
  ├─ Credential scan: no secrets in pipeline code
  └─ Contract format validation: schema_path file exists and is valid JSON Schema

On Pass:
  ├─ Warehouse: CREATE SCHEMA orders; CREATE TABLE orders_daily_revenue (from schema)
  ├─ Catalog: POST /api/v1/data-products {manifest contents + auto-generated description}
  ├─ Lineage: Register data product in lineage service namespace
  ├─ Access control: Create warehouse role dp_orders_daily_revenue_reader; bind to consumer list
  └─ Alerting: Create freshness and quality monitors from SLO fields
```

---

## Platform Contract

The platform team publishes and maintains a formal contract for the data mesh platform capability:

### What the Platform Provides

| Capability | SLA |
|---|---|
| Warehouse compute availability | 99.5% monthly; planned maintenance windows announced 72 hours in advance |
| Catalog ingestion | New data product catalog entry created within 1 hour of successful CI deploy |
| Lineage capture | All platform-managed transformations emit lineage events; events processed within 5 minutes of pipeline completion |
| PII detection | CI gate PII scan completes within 3 minutes; blocks deployment on detection |
| Access control provisioning | Consumer access granted within 5 minutes of data product owner approval |
| Quality alerting | Freshness SLO breach notification delivered within 10 minutes of threshold exceeded |
| Breaking change notice | Minimum 30 days notice for any change to the `data-product.yaml` schema that requires migration |

### What Domain Teams Are Responsible For

| Responsibility | Owner |
|---|---|
| Transformation logic correctness | Domain team (not platform) |
| Quality test coverage for domain-specific business rules | Domain team |
| Responding to freshness SLO breach alerts | Domain team (on-call for their data products) |
| Keeping the manifest's `consumers` list current | Domain team |
| Notifying consumers before breaking schema changes | Domain team |
| PII classification accuracy | Domain team (platform detects obvious cases; domain team validates edge cases) |

---

## Developer Experience

A platform that is hard to develop against creates shadow IT: domain teams build bespoke Airflow DAGs that bypass the standard tooling, export CSVs to personal S3 buckets, or simply query source databases directly and call it done.

### Local Development

Domain teams should be able to develop and test data products locally without consuming warehouse credits:

```bash
# Clone the data product scaffold
platform-cli new data-product --domain orders --name orders_daily_revenue

# Develop locally using DuckDB (no Snowflake credit consumption)
dbt run --profiles-dir .dbt/local --target local
# Executes against DuckDB with seed data; instant feedback, $0 cost

# Validate schema contract before push
platform-cli validate --manifest data-product.yaml
# Checks: schema file exists, PII fields declared, classification set, SLO thresholds reasonable

# Run quality tests locally
dbt test --profiles-dir .dbt/local --target local
# Runs Great Expectations tests against local DuckDB output

# Push to CI for full governance gate
git push origin feature/orders-daily-revenue
```

The local DuckDB runner is the most important developer experience feature. Data engineers habitually develop against the real warehouse, consuming credits for every test run. The DuckDB local runner eliminates this — development is free and instant, with identical dbt model logic.

### Self-Service Access Request Portal

Consumers should not need to email the data product owner or file a Jira ticket to request access:

1. Consumer discovers data product in the catalog (search by domain, tag, or metric name)
2. Consumer clicks "Request Access" and fills in: use case description, expected query frequency, whether they need PII fields (requires additional justification)
3. Data product owner receives a notification; reviews the request in the portal
4. Owner approves or declines; platform provisions warehouse access within 5 minutes of approval
5. Consumer receives connection details and sample query

The entire process should complete in under 24 hours for `internal` data products and under 5 business days for `restricted` data products. If it takes longer, the access request process is the bottleneck, not the data product.

---

## Anti-Patterns That Signal the Platform Has Become a Bottleneck

| Signal | What It Means | Fix |
|---|---|---|
| Domain teams filing tickets to the platform team for routine data product changes | The self-service path is broken or missing | Identify the specific step where teams get stuck; automate or document it |
| More than 20% of data products bypass the standard pipeline template | The template doesn't cover real domain needs | Run discovery sessions; add the missing patterns to the template |
| Data catalog with less than 40% coverage | Domain teams are not publishing products properly, or are abandoning the catalog | Make catalog entry automatic (from manifest) rather than a separate manual step |
| Consumers reading directly from source tables | Data product access is too slow to get, or data product doesn't exist for what they need | Audit access request SLAs; survey consumers for missing data products |
| Quality CI gate being suppressed or bypassed frequently | Gate is generating false positives or blocking valid work | Tune detection thresholds; add an exception process with mandatory security review |
| Platform team on-call for all data product incidents | Domain teams are not taking on-call responsibility | On-call assignment must follow ownership; platform provides tooling, not incident response for domain products |

The platform team should track these signals as metrics, not as anecdotes. A platform health dashboard should show: time-to-first-data-product for new domain teams, ticket volume to the platform team, catalog coverage percentage, access request SLA compliance, and quality gate suppression rate.

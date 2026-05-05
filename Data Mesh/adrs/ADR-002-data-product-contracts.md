# ADR-002: Standardize data product contracts (schema + SLOs)

## Status
Accepted

## Date
2025-07-30

## Context
After the Data Mesh model was adopted and the first two domain teams (Orders and Catalog) began building their own data products, a cross-domain analysis request exposed a fundamental interoperability problem. The Finance team wanted to join the Orders domain's revenue dataset with the Catalog domain's product category dataset to produce a revenue-by-category report.

The Orders dataset's product identifier was a numeric SKU. The Catalog dataset's product identifier was a UUID. There was no documented mapping between the two, and the field names were different (`sku` in Orders, `product_id` in Catalog). Both domain teams were using the "correct" identifier for their domain, but there was no contract documenting what the identifier type was, how it related to other domains' identifiers, or what the join path was.

The report took 3 days to build, most of which was spent discovering the identifier mismatch and building a mapping table from a third source. The Finance team then discovered that the Orders dataset had not been updated in 26 hours (it was scheduled to run daily but had silently failed). The Catalog dataset's SLO was not documented, so the Finance team did not know whether the data was current when they built the report.

Both problems -- undocumented field semantics and undocumented freshness guarantees -- stemmed from the absence of a formal data product contract.

## Decision
Every data product published in the Data Mesh must have a contract file (`data-product.yaml`) committed alongside the pipeline code. The contract is the official specification; if the actual data diverges from the contract, the contract is wrong (not the data).

**Required contract fields:**

```yaml
name: orders.daily_revenue
owner: orders-team@company.com
domain: orders
version: 2
description: |
  Daily revenue aggregated by settlement date, net of returns and refunds.
  Revenue is recognized on settlement date, not order date.

schema:
  - name: settlement_date
    type: DATE
    description: The date the payment settled with the payment processor
  - name: gross_revenue_usd
    type: DECIMAL(18,4)
    description: Total payment amount before returns and refunds
  - name: net_revenue_usd
    type: DECIMAL(18,4)
    description: Gross revenue minus return credits and refund amounts

identifiers:
  - field: settlement_date
    join_to: []  # date field, no cross-domain join

freshness_slo:
  max_lag_hours: 4
  update_schedule: "0 6 * * *"  # 6 AM UTC daily

pii_classification: none
retention_days: 1825  # 5 years (regulatory requirement)
access_policy: finance-team, analytics-team
```

The contract is validated in CI using a schema linter that checks required fields are present, types are valid, and SLO values are within platform-supported ranges.

## Alternatives Considered

**Documentation in a wiki or README:** Contract information is maintained in a Confluence page or README file alongside the pipeline code. Rejected because wiki documentation drifts from code reality; a schema change is deployed without updating the wiki, and consumers discover the change by observing broken queries. Machine-readable contracts committed to the code repository are validated on every merge.

**Schema inference from the data itself:** Automatically derive the contract from the dataset's schema at read time (infer column names, types, and ranges from the actual data). Rejected because inference cannot capture semantic information (what does `net_revenue_usd` mean? what date range is the data current through?) and cannot establish SLOs or ownership that require human declaration.

**Lightweight contract (name, owner, schema only):** A minimal contract without freshness SLOs or PII classification. Rejected because the Finance team's 26-hour stale data incident was caused by missing freshness SLO documentation. PII classification omission creates data governance risk. The contract must be complete enough to enable safe consumption.

## Consequences

### Positive
- Cross-domain joins can be planned before building: the contract's identifier types and join paths make compatibility visible without exploratory data work
- Freshness SLOs give consumers explicit expectations; a consumer that needs data current within 2 hours will reject a data product with a 4-hour max lag SLO before building on it
- PII classification in the contract enables automated access control enforcement

### Negative
- Contract maintenance is ongoing: every schema change, SLO change, or ownership change requires a contract update as part of the pipeline deployment
- Incomplete contracts (especially freshness SLOs and join identifiers) will be submitted; CI enforcement must reject incomplete contracts without being so strict that it prevents iteration

### Risks
- **Contract compliance theater.** If the CI checks are easy to bypass or if the contract schema is too lenient, teams will publish contracts that nominally pass validation but are semantically empty (e.g., all fields described as "see source code"). Mitigation: contract review is part of the data product onboarding process; the platform team reviews new data product contracts before they are published to the catalog.

## Review Trigger
Revisit the contract schema if regulatory requirements introduce new mandatory documentation fields (e.g., data residency requirements, new PII subcategory classifications). Revisit the CI enforcement if contract validation becomes a deployment bottleneck for domain teams.

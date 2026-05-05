# ADR-005: Prioritize interoperability and discoverability via a catalog

## Status
Accepted

## Date
2026-01-14

## Context
After 8 months of Data Mesh operation, 23 data products had been published across 6 domain teams. The Finance team, attempting to build a cross-domain revenue quality dashboard, discovered that finding relevant data products required asking in a Slack channel. There was no searchable index of what data products existed, who owned them, or what they contained.

A search of Slack messages from the previous quarter revealed that "where can I find X data" questions were asked approximately 40 times, and 15 of those questions resulted in a domain team discovering that the data they needed already existed in a published data product -- but they had independently started building a duplicate. Three of those duplicates were completed and deployed before the original was discovered, resulting in two data products with identical content, different schemas, and different owners, with no clear guidance for consumers about which to use.

The catalog problem was not unique to Data Mesh -- it was an amplified version of the data silo problem that existed before. Data Mesh gives domain teams the autonomy to build data products, but without discoverability infrastructure, consumers cannot leverage that autonomy. The mesh becomes a collection of isolated products rather than a discoverable ecosystem.

## Decision
All data products published through the platform are automatically registered in a centralized data catalog. The catalog serves as the single source of truth for what data products exist, who owns them, and what they contain.

**Catalog requirements:**

**Automatic registration:** When a data product is deployed via the platform pipeline (ADR-004), the platform automatically registers or updates the catalog entry using the data product's `data-product.yaml` contract (ADR-002). Domain teams do not manually register; the platform handles it.

**Searchable metadata:** The catalog is searchable by domain, owner, field name, and description text. A search for "revenue" returns all data products that include a field or description containing that term, across all domains.

**Data lineage:** For data products built from other data products (e.g., a cross-domain join), the lineage graph shows upstream dependencies. A consumer can see that `finance.revenue_by_category` is built from `orders.daily_revenue` and `catalog.product_categories`, and the freshness of the derived product is bounded by the freshness of both upstreams.

**Usage metrics:** The catalog tracks which data products have consumers and how frequently they are queried. Products with zero queries for 90+ days are flagged for potential deprecation review with the owner. Products with high query volume are flagged for SLO review to ensure their reliability commitments match their usage importance.

**Semantic layer (shared metric definitions):** Common cross-domain metrics (e.g., "active user," "settled revenue," "conversion rate") are defined in a shared semantic layer with canonical definitions. Data products that contribute to these metrics tag their fields accordingly, enabling consumers to find all datasets that contribute to a given metric.

## Alternatives Considered

**Team-maintained documentation (wiki pages, README files):** Each domain team maintains a wiki page documenting their data products. Rejected because wiki pages drift from code reality, are not searchable in the same index as data product schemas, and require domain teams to maintain documentation as a separate task from pipeline development. Automatic registration from the contract file eliminates the maintenance burden and prevents drift.

**Marketplace model (data products published on request):** Domain teams publish data products to the catalog only when a consumer requests them. Keeps the catalog small and focused on actively demanded data. Rejected because it recreates the bottleneck of waiting for a data provider to act before a consumer can discover the data. Automatic publication of all deployed data products makes potential value visible before demand is expressed.

**No catalog; organic discovery via Slack and documentation:** Teams rely on informal channels to find data. Rejected because the 40 Slack queries and 3 completed duplicates in the previous quarter demonstrated the cost of the status quo at 23 data products. The cost of catalog implementation is lower than the ongoing cost of organic discovery.

## Consequences

### Positive
- The "where can I find X data" Slack query pattern is replaced by a self-service catalog search; demand for data that already exists is routed to existing products rather than triggering new builds
- Lineage visibility allows consumers to understand the freshness and quality chain for derived data products before building on them
- Usage metrics provide the platform team with evidence for which data products are high-value (prioritize reliability) and which may be candidates for deprecation

### Negative
- Catalog accuracy depends on the contract files being accurate and complete; if a domain team deploys a schema change without updating the contract, the catalog entry becomes stale
- The semantic layer requires ongoing maintenance: metric definitions must be kept current as business definitions evolve, which requires cross-domain coordination

### Risks
- **Catalog becomes a governance theater artifact.** If domain teams register data products in the catalog to satisfy the requirement but do not maintain the metadata, the catalog loses value over time. Mitigation: catalog freshness (time since last contract update vs. time since last pipeline deployment) is tracked as a governance metric; data products where the contract is more than 30 days older than the last deployment trigger a freshness alert to the owner.

## Review Trigger
Revisit the catalog tooling if the number of data products grows beyond 200, at which point search relevance and lineage graph rendering may require more sophisticated catalog infrastructure than the current implementation provides.

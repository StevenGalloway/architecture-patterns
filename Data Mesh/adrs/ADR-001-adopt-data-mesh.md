# ADR-001: Adopt Data Mesh operating model for analytics scaling

## Status
Accepted

## Date
2025-05-21

## Context
The centralized data engineering team managed all analytical data pipelines for the organization: ETL from operational databases, transformation into warehouse tables, and serving to business intelligence tools. The team grew to 11 engineers, but the queue of pipeline requests from domain teams grew faster. By the time this decision was made, the data engineering backlog had 47 open requests with an average wait time of 6 weeks from ticket creation to production delivery.

The bottleneck was not a staffing problem in isolation. It was a structural problem: domain teams had the context to know what data was important and how it should be interpreted, but they could not act on that knowledge without waiting for a data engineering team that worked across all domains. When the Orders domain needed a new revenue attribution pipeline, the data engineers first had to learn the Orders domain's concepts (what does "settled" mean? how are returns handled? what is the difference between gross and net revenue in this context?). This knowledge transfer consumed weeks of collaborative time and still resulted in pipelines that required ongoing correction as the domain team discovered edge cases.

Domain teams were also the first to notice when their pipelines produced incorrect results -- but they had no ownership or operational visibility into the pipelines they depended on. An incorrect revenue figure would be in production for a reporting cycle before anyone could diagnose and fix it.

## Decision
Adopt the **Data Mesh** operating model:
- **Domain ownership:** Each domain team owns their data products end-to-end: pipeline development, testing, deployment, SLOs, and ongoing operations. The Orders domain owns all Orders data products; the Catalog domain owns all Catalog data products.
- **Data products as first-class artifacts:** Data is treated as a product with consumers, not as an internal implementation detail. Each data product has a published contract, owner, and quality guarantees.
- **Self-serve platform:** A central platform team provides reusable tooling, infrastructure templates, and governance automation that enable domain teams to build data products without deep platform expertise.
- **Federated governance:** Standards are defined centrally (naming conventions, schema contracts, PII tagging) but enforced automatically via policy-as-code gates in the CI/CD pipeline, not through manual approval processes.

## Alternatives Considered

**Scale the central data engineering team:** Hire more data engineers and increase the team's capacity to meet domain demand. Rejected because the bottleneck is not just throughput but also domain knowledge transfer. A larger central team would still require domain context for every pipeline request, and the knowledge transfer overhead scales with pipeline complexity, not just headcount.

**Data virtualization with a federated query layer:** Domain operational databases are made available to analysts directly through a federated query engine (e.g., Trino, Athena) without building dedicated data products. Rejected because raw operational data is not suitable for direct analytical use -- it lacks the semantic cleaning, de-duplication, and business rule application that makes analytical data trustworthy. Virtualization provides access but not quality.

**Self-service BI tools without data mesh structure:** Allow domain teams to build their own reports and dashboards directly from operational databases or raw data exports, without formal data product ownership. Rejected because it produces data silos and inconsistent definitions. The Sales team's "monthly revenue" figure and the Finance team's "monthly revenue" figure may differ by 8% and neither team can explain why, because both are computing the figure from raw data without shared semantic definitions.

## Consequences

### Positive
- The 6-week pipeline backlog is eliminated: domain teams build their own pipelines when they need them, at their own pace, without waiting for the central team
- Domain experts who understand the data are the same people building the pipelines that transform it; semantic errors are caught earlier and edge cases are handled correctly from the start
- The central data team transitions from a bottleneck to a platform team multiplying domain team capability

### Negative
- Domain teams that are not experienced with data engineering (pipeline development, data quality testing, SLO management) require training and onboarding support before they can operate independently
- Duplication of effort is possible: two domains may both build pipelines that compute similar metrics, without the coordination that a central team would have provided

### Risks
- **Data product quality inconsistency.** Without the discipline of a specialized data engineering team, some domain teams may produce lower-quality data products (missing null handling, incorrect aggregation logic). Mitigation: quality gates enforced via CI/CD (see ADR-003) provide a floor below which no data product can be deployed, regardless of the domain team's data engineering experience.

## Review Trigger
Revisit if the platform team cannot keep pace with domain team adoption, creating a new bottleneck in platform tooling rather than in pipeline delivery. Also revisit if regulatory requirements impose data governance controls that require centralized oversight rather than federated enforcement.

# ADR-004: Provide a self-serve data platform (paved road)

## Status
Accepted

## Date
2025-11-19

## Context
Domain teams have the ownership and context to build data products, but not all domain teams have the infrastructure skills to build pipelines from scratch. The first three domain teams to adopt Data Mesh each spent 3-5 weeks on infrastructure setup: choosing and configuring an orchestration tool, provisioning storage, setting up access controls, connecting to the operational databases, and configuring monitoring. This setup work was largely identical across the three teams but was done independently.

The Customer domain team's pipeline setup included a misconfigured encryption setting on their storage bucket, which exposed the dataset without at-rest encryption for 6 days before it was caught by a security audit. The infrastructure setup process had no guardrails and required each team to make infrastructure decisions for which they had limited context.

The platform team spent approximately 40% of its time in the first quarter answering infrastructure setup questions from domain teams. This was not the platform team's intended role (enabling domain autonomy through reusable tooling) -- it was effectively one-on-one support for bespoke infrastructure configurations.

## Decision
The platform team provides a **self-serve data platform** that domain teams use by default. The platform is a paved road: it is opinionated, handles infrastructure concerns automatically, and requires minimal infrastructure knowledge from domain teams. Teams that need to deviate from the paved road can do so, but they take on the infrastructure responsibility themselves.

**Platform capabilities provided:**

**Ingestion templates:** Pre-configured templates for common ingestion patterns (operational database CDC, API polling, event stream consumption). Templates handle connection pooling, schema detection, incremental extraction, and retry logic. Domain teams provide source credentials and a destination schema; the template handles the rest.

**Orchestration:** Apache Airflow with pre-built DAG templates for standard pipeline patterns (daily batch, hourly micro-batch, event-triggered). Domain teams define their pipeline logic in a Python transform function; the DAG template handles scheduling, retries, alerting, and SLO tracking.

**Storage provisioning:** The platform provisions storage (object storage + query engine) using Terraform modules. Domain teams specify their data product name and access policy; the module creates the storage, applies encryption, configures access controls, and provisions the query catalog entry. Encryption is always enabled; it is not an option.

**Observability:** Each pipeline provisioned through the platform automatically emits freshness metrics, row count metrics, and schema drift detection. These are pre-wired; no instrumentation code is required from the domain team.

**Cost visibility:** Domain teams can see the storage and compute costs attributable to their data products in a self-serve cost dashboard. Cost anomalies (> 50% increase week-over-week) trigger alerts to the data product owner.

## Alternatives Considered

**No platform; domain teams choose their own tools:** Domain teams are fully autonomous including infrastructure choices. Rejected because the 40% platform team support overhead and the encryption misconfiguration incident demonstrated the cost of infrastructure autonomy without guardrails. Autonomy must be bounded by defaults that prevent the most common infrastructure mistakes.

**Fully managed SaaS data platform (Databricks, Snowflake, dbt Cloud):** Adopt a SaaS platform as the paved road instead of building internal tooling. The SaaS platform handles infrastructure, scaling, and many governance features. Rejected as the primary platform because the current data volume does not justify the cost of a fully managed SaaS platform at enterprise pricing, and because vendor lock-in at the data platform level is a significant risk for a long-running workload. Revisit if data volume grows by 10x.

**Each domain team picks tools from an approved list:** Domain teams choose their own orchestration and storage tools from a short list of approved options. More flexibility than a single paved road. Rejected because "approved list" approaches still require domain teams to evaluate and choose tools, and cross-domain interoperability is harder when teams use different storage and query engines.

## Consequences

### Positive
- Domain teams go from concept to production pipeline in 1-2 weeks, not 3-5 weeks, because infrastructure setup is handled by the platform
- Encryption and access control are automatically applied; domain teams cannot accidentally deploy an unencrypted dataset
- The platform team's time shifts from individual support to platform improvement: adding new templates, improving observability, and updating governance checks

### Negative
- The paved road is opinionated; domain teams that have legitimate reasons to deviate from it must either justify an exception or take on full infrastructure responsibility
- The platform becomes critical shared infrastructure: a platform outage affects all domain teams' pipeline runs simultaneously, not just one team

### Risks
- **Platform adoption without engagement.** Domain teams may adopt the platform's templates but not understand the infrastructure they are running on, making them dependent on the platform team for all troubleshooting. Mitigation: onboarding includes a half-day workshop covering the platform's infrastructure model, what to check when a pipeline fails, and when to engage the platform team vs. self-serving through documentation.

## Review Trigger
Revisit if domain team count grows beyond 20, at which point the platform's shared infrastructure (Airflow, storage provisioning) may require horizontal scaling or per-domain isolation. Revisit the build-vs.-buy decision for the orchestration and storage layer if data volume grows by 10x.

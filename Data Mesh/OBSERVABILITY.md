# Observability — Data Mesh Pattern

## Why Observability Is Structurally Different in a Mesh

In a centralized data architecture, one team owns all pipelines. When data is wrong or late, there is one team to call. Observability is a single team's operational concern.

In a Data Mesh, there is no single team responsible for the full data lifecycle. The Orders team is responsible for the Orders data product. The Customers team is responsible for the Customers data product. A data quality incident in the Customers data product that propagates through a join in the Orders pipeline to 12 downstream analytical consumers requires cross-domain impact analysis — not just single-product monitoring.

This means observability in a Data Mesh must be both **federated** (each domain team observes their own data products, receives their own alerts, manages their own SLOs) and **platform-aggregated** (the platform provides cross-domain visibility for impact analysis, platform health monitoring, and SLO compliance reporting across all data products).

A domain team sees their data products. The platform team sees all data products. Neither view alone is sufficient.

---

## Golden Signals Adapted for Data Mesh

### 1. Latency (Freshness)

Data latency in a mesh is measured as data product staleness — how long since this data product last successfully refreshed.

| Metric | Description | Alert Threshold |
|---|---|---|
| `data_product.freshness_hours` | Hours since last successful refresh, per data product | Exceeds `slo.freshness_hours` from manifest |
| `data_product.freshness_slo_breach` | Boolean: has this product exceeded its freshness SLO? | 1 (any breach) |
| `pipeline.run_duration_minutes` | Duration of the most recent transformation run, per data product | Exceeds 2× historical baseline |
| `pipeline.run_queue_delay_minutes` | Time between scheduled run start and actual execution start | >15 minutes (orchestrator saturation signal) |

Freshness SLO breach is the primary latency signal in a mesh. A data product with a 25-hour freshness SLO that has not refreshed in 30 hours is in a data product outage — consumers are operating on stale data without knowing it.

### 2. Traffic (Consumption)

Consumption metrics reveal data product value and surface staleness or replacement patterns.

| Metric | Description |
|---|---|
| `data_product.query_count` | Query count per data product per consumer team per day |
| `data_product.consumer_count` | Number of distinct consumer teams with active access; growth indicates product value |
| `data_product.query_bytes_scanned` | Warehouse bytes scanned per consumer; cost attribution and abuse detection |
| `data_product.unused_days` | Days since last query; data products with `unused_days > 90` are candidates for deprecation |

A data product whose `consumer_count` is declining and `unused_days` is climbing is likely being replaced by a new version or superseded by another product. The platform should surface this to the data product owner before they continue investing in it.

A data product whose `query_bytes_scanned` per consumer spikes unexpectedly may indicate a consumer running a full-scan query that was not intended (missing filter, bug in consumer pipeline) — driving unexpected warehouse cost.

### 3. Errors (Quality)

Quality metrics are the most important observability signal in a mesh. Silent data quality degradation — completeness dropping, null rates climbing, row counts shifting unexpectedly — is the data equivalent of a 5xx error rate.

| Metric | Description | Alert Threshold |
|---|---|---|
| `data_product.quality.completeness_pct` | Percentage of required fields that are non-null, per data product | Below `slo.completeness_pct` from manifest |
| `data_product.quality.null_rate` | Null rate per required field; tracked per-field for root cause | Any field with null rate >5× its historical baseline |
| `data_product.quality.row_count` | Row count on most recent refresh | Delta >20% from same-period previous week |
| `data_product.quality.row_count_delta_pct` | Percentage change in row count vs. prior refresh | Alert if >±30% without a corresponding upstream event |
| `data_product.schema.contract_violations` | Number of consumer queries that failed against the current schema | Any nonzero value (indicates breaking schema change) |
| `data_product.quality.custom_test_failures` | Domain-specific quality test failures from dbt test suite | Any failure on a required test |

`schema.contract_violations` is the cross-domain error signal: a value greater than zero means a producer shipped a schema change that broke at least one consumer. This must page — it is an active downstream incident.

### 4. Saturation

Saturation in a mesh is multi-layered: warehouse compute saturation, orchestrator saturation, catalog saturation, and lineage backlog.

| Metric | Description | Alert Threshold |
|---|---|---|
| `platform.warehouse.credit_utilization` | Warehouse compute credit burn rate by domain | Domain approaching monthly credit allocation limit |
| `platform.warehouse.queue_depth` | Queries queued waiting for warehouse capacity | >50 queries in queue (compute saturation signal) |
| `platform.catalog.indexing_lag_minutes` | Lag between data product deploy and catalog entry availability | >60 minutes |
| `platform.lineage.events_backlog` | Number of lineage events awaiting processing | >1,000 events (lineage service saturation) |
| `platform.orchestrator.task_slot_utilization` | Percentage of Airflow/Prefect worker slots in use | >80% sustained for 30 minutes |

`platform.warehouse.credit_utilization` by domain is the cost governance metric. If the Orders domain is consuming 40% of monthly warehouse credits in the first week of the month, the domain team needs to know before they exhaust their allocation and start affecting other domains.

---

## SLI / SLO Definitions

### Data Product Freshness SLO

**SLI:** For each data product, the percentage of scheduled refresh windows that complete successfully within the product's declared `freshness_hours` SLO.

```
freshness_SLI = (refresh_windows_completed_within_slo / total_scheduled_refresh_windows) × 100
```

**SLO:** 99.0% of refresh windows meet the freshness SLO over a rolling 28-day period.

Error budget: 1% of refresh windows may miss the SLO. For a daily-refresh product, that is approximately 0.3 missed refreshes per month.

### Data Quality SLO

**SLI:** For each data product, the percentage of refreshes where all required quality checks pass (completeness ≥ threshold, row count within expected range, no null violations on required fields).

**SLO:** 99.5% of refreshes pass all required quality checks over a rolling 28-day period.

### Consumer Access SLO

**SLI:** Percentage of consumer warehouse queries against a data product that complete within 10 seconds (p99).

**SLO:** 95% of queries complete in ≤10 seconds p99.

This SLO is measured by the warehouse's query execution telemetry, not by consumer-side instrumentation. It detects when a data product's table has become unquerably large or inefficiently structured.

---

## Structured Event Log Schema

Every data product refresh emits one structured event to the platform's observability pipeline:

```json
{
  "event_type": "data_product_refresh",
  "timestamp": "2025-11-26T02:00:14.382Z",
  "product_name": "orders_daily_revenue",
  "domain": "orders",
  "refresh_run_id": "run_20251126_orders_daily_revenue_001",
  "refresh_start": "2025-11-26T01:58:02.000Z",
  "refresh_end": "2025-11-26T02:00:14.000Z",
  "duration_seconds": 132,
  "row_count": 48203,
  "row_count_delta_pct": 2.1,
  "quality_check_results": [
    { "check_name": "completeness_order_id", "result": "pass", "value": 100.0, "threshold": 100.0 },
    { "check_name": "completeness_revenue_usd", "result": "pass", "value": 99.8, "threshold": 99.5 },
    { "check_name": "row_count_min", "result": "pass", "value": 48203, "threshold": 100 },
    { "check_name": "freshness_hours", "result": "pass", "value": 2.0, "threshold": 25.0 }
  ],
  "quality_gate_passed": true,
  "lineage_captured": true,
  "consumers_notified": false,
  "slo": {
    "freshness_hours": 25,
    "completeness_pct": 99.5
  }
}
```

`consumers_notified` becomes `true` if the refresh fails the quality gate — in that case, the platform sends a notification to all registered consumer teams for this product. Consumers should know immediately when a data product they depend on has a quality incident; they should not discover it when their own pipeline fails.

---

## Key Dashboards

### 1. Data Product Health (Domain Team View)
- Freshness status for all data products in this domain (green/yellow/red by SLO status)
- Quality check results for most recent refresh, per product
- Consumer count and query frequency trend (last 30 days) per product
- Open access requests pending domain owner approval

### 2. Cross-Domain Lineage Impact (Platform View — Incident Response)
- When a data product fails a quality check: which downstream data products are derived from it? Which consumer teams have active queries against those downstream products?
- Used by on-call during a data product outage to assess blast radius before consumer teams start filing incidents
- Powered by the lineage graph — requires lineage to be captured for every platform-managed transformation

### 3. Platform Health (Platform Team View)
- Warehouse credit burn rate by domain vs. monthly allocation
- Orchestrator task slot utilization (Airflow/Prefect)
- Catalog indexing lag
- Lineage event backlog
- Access control provisioning SLA compliance (% of access requests provisioned within 5 minutes of approval)

### 4. SLO Compliance (Leadership / Governance View)
- % of data products meeting their freshness SLO (rolling 28 days)
- % of data products meeting their quality SLO (rolling 28 days)
- Data products with open SLO violations (sorted by consumer count — highest consumer impact first)
- Error budget burn rate by domain

---

## Chaos Engineering Scenarios

Run these in a staging environment quarterly to validate that the observability and incident response processes work:

| Scenario | Method | Expected Behavior | Pass Criteria |
|---|---|---|---|
| Upstream source table schema change | Rename a column in a source operational table; observe downstream data product on next refresh | Transformation job fails; quality gate blocks publish; consumer notification sent; lineage shows affected downstream products | No silent data corruption; consumers notified within 10 minutes of failure; on-call has lineage impact analysis within 15 minutes |
| Warehouse compute saturation | Schedule 10 large transformation jobs simultaneously to exhaust warehouse capacity | Platform priority queue activates; critical data products (financial reporting) execute first; non-critical jobs queue | No data product SLO breach for critical products; queue depth alert fires within 5 minutes |
| Catalog service outage | Take down the catalog API for 30 minutes | Data products continue publishing to the warehouse; catalog entry creation queues up; no data loss; catalog catches up within 5 minutes of restoration | Zero data loss; catalog entries created in correct order after restoration; no domain team intervention required |
| PII detection false positive | Push a data product with a field name containing the word "email" that is actually an internal ID (not PII) | CI gate blocks deployment; domain team can invoke exception review process | Exception review workflow reachable in under 2 clicks; reviewed and resolved within 4 business hours |
| Consumer access revocation | Revoke a consumer team's access to a restricted data product | Warehouse access removed within 5 minutes; consumer's queries fail with permission error; consumer team receives notification | Zero delay on access revocation; consumer queries do not succeed after revocation; notification delivered |

---

## Alerting Philosophy

**Page the domain team's on-call when:**
- A data product misses its freshness SLO by more than 2× (e.g., a 25-hour SLO product that has not refreshed in 50 hours). A 2× breach means consumers are operating on data that is materially stale — this is a data product outage, not a warning.
- A quality gate fails on a data product with 3 or more consumer teams. High consumer count means the blast radius is material.
- `data_product.schema.contract_violations` is greater than zero. This means a breaking change is actively affecting downstream consumers.

**Notify the domain team (no page) when:**
- Quality completeness drops below SLO but the quality gate has not failed yet (degrading trend, not yet a breach)
- Freshness SLO is within 20% of the threshold (approaching breach, not yet breached)
- A consumer's query pattern changes significantly (potential misuse or bug in consumer pipeline)

**Do not alert on:**
- Individual transformation warnings (dbt warnings, non-critical test soft failures) — aggregate into a daily quality digest for the domain team
- Warehouse credit utilization below 70% of monthly allocation — this is normal operation, not a saturation signal
- Catalog indexing lag under 30 minutes — within normal operating bounds

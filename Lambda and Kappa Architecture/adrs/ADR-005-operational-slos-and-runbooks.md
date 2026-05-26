# ADR-005: Define operational SLOs and runbooks for streaming

## Status
Accepted

## Date
2026-02-11

## Context
Streaming pipeline failures are uniquely insidious because they often fail silently: the Flink job may continue running and processing events while producing incorrect or incomplete output. Unlike a service that returns 500s (immediately visible in error rate dashboards), a streaming pipeline that drops events or computes aggregations incorrectly may not surface in operational dashboards for hours or days.

Three failure modes were discovered in production before operational monitoring was standardized:

**Silent consumer lag growth:** A Kafka topic partition became imbalanced after a broker rebalance. The Flink job's consumer for that partition slowed down, building consumer lag. The lag grew from 0 to 45,000 events over 8 hours without any alert. The hourly order count metric was increasingly stale during that period. Detection came from an analyst who noticed the metric had not updated.

**Checkpoint failure loop:** A Flink job's checkpoint started failing due to a slow state backend write. Flink continued processing events but without successful checkpoints. If the job had failed and restarted during this window, it would have replayed from the last successful checkpoint -- hours earlier -- and reprocessed a large event window. The job ran for 6 hours in this state before a restart triggered the large reprocess. Detection came from an engineer noticing checkpoint failure metrics on the Flink console.

**Late event flooding:** A backlog of mobile offline sync events arrived simultaneously, causing the late event rate to spike. The late events were within the 72-hour window and were included in historical aggregations, but the reprocessing of those aggregations caused write contention on the affected Iceberg partitions. Detection came from a write latency spike in the Iceberg write metrics.

All three failures had observable signals that would have triggered alerts before the problem became user-visible. None of the signals were being monitored.

## Decision
The following SLOs and monitoring are required for all production streaming pipelines:

**Consumer lag SLO:** Maximum lag of 10,000 events per partition. Alert at 5,000 (warning), page at 10,000 (critical). Lag is measured at the Kafka level (partition offset lag) and reported every 30 seconds.

**Checkpoint SLO:** Successful checkpoint completion required within every 10 minutes. Alert if no successful checkpoint in 15 minutes; page if no successful checkpoint in 30 minutes. Checkpoint size and duration are tracked as metrics.

**End-to-end freshness SLO:** The timestamp of the most recently processed event must be within 5 minutes of the current time. Alert at 10 minutes behind; page at 20 minutes behind. This SLO catches situations where the job is running but event processing has stalled.

**Late event rate SLO:** Late events (arrival timestamp > 1 hour after event timestamp) should be less than 0.5% of total events. Alert if late event rate exceeds 1% over a 10-minute window (indicating unusual late arrival patterns).

**Output freshness SLO:** Iceberg curated tables must have at least one new Flink write commit within the last 30 minutes. Alert if no write commit in 45 minutes; this catches cases where the Flink job is running but not producing output.

**Runbooks maintained:**
1. How to diagnose and resolve consumer lag (including partition rebalancing procedures)
2. How to interpret checkpoint failure metrics and when to restart vs. investigate
3. How to perform a Tier 1 (Kafka) replay (offset reset, overwrite configuration)
4. How to perform a Tier 2 (S3 archive) replay (replay job configuration, Iceberg partition overwrite)
5. How to handle a late event flood (when to let the window handle it vs. when to trigger a reconciliation)

## Alternatives Considered

**Alert only on job failures (no lag or freshness SLOs):** Alert when the Flink job crashes or throws exceptions, not on lag or freshness metrics. Simpler alert configuration. Rejected because all three incidents described in the Context were cases where the job was running without throwing exceptions, but the output was degraded. Job-failure-only alerting would have missed all three.

**Business metric deviation alerts (alert when metrics look wrong):** Instead of infrastructure signals, alert when business metrics deviate from expected patterns (e.g., daily orders drop by >20% vs. last week). Adopted as a complement but not a replacement: business metric alerts catch problems that operational signals miss, but they fire after the problem has already affected users. Infrastructure signals provide earlier warning.

**Automated remediation (auto-restart on checkpoint failure):** Configure Kubernetes to restart the Flink job automatically after a certain number of checkpoint failures. Faster recovery than manual intervention. Partially adopted: automatic restart is enabled for crash failures, but for checkpoint failures (where the job is running but not checkpointing), automatic restart requires careful configuration to avoid triggering a large reprocess from the last successful checkpoint unexpectedly. The runbook covers when to restart manually and what to verify before doing so.

## Consequences

### Positive
- Consumer lag is now alerted before it affects metric freshness; the 8-hour lag incident would have triggered a page within 30 minutes of lag growth starting
- Checkpoint failure alerts give operators time to investigate and remediate before a job restart triggers an unexpected large reprocess
- End-to-end freshness SLO catches the broadest category of stale output, regardless of which specific component is causing the staleness

### Negative
- The lag and freshness alerts require tuning per pipeline; a pipeline that processes events in large batches may have legitimate lag spikes that trigger false positive alerts
- Runbook maintenance is ongoing; the checkpoint failure runbook in particular requires updates when the Flink version or state backend configuration changes

### Risks
- **Alert fatigue from normal operational variability.** Flink pipelines have inherent variability (garbage collection pauses, checkpoint size variance). Alert thresholds set too tightly trigger alerts during normal operation. Mitigation: thresholds were set after two weeks of observing normal metric distributions in production; the warning threshold is set at the p99 of normal operation, not at a round number.

## Review Trigger
Revisit SLO thresholds after any significant change to event volume or pipeline complexity. Revisit runbooks after each Flink version upgrade, as checkpoint behavior and recovery procedures may change between versions.

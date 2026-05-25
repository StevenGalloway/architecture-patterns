# ADR-003: Establish replay/backfill strategy for correctness

## Status
Accepted

## Date
2025-10-22

## Context
The Kappa architecture's correctness guarantee depends on the ability to reprocess historical events when logic bugs or late data require correcting historical metrics. This capability must be designed into the system before it is needed; attempting to design replay during an incident produces ad-hoc solutions with high operational risk.

Two incidents made this concrete:

**Logic bug in revenue attribution:** A Flink aggregation job had a bug in the promotional discount deduction logic that was introduced in a deployment 6 weeks earlier. The bug had been silently producing slightly incorrect daily revenue figures. When the bug was discovered, 42 days of revenue metrics needed to be recomputed. The Kafka topic retained only 7 days of raw events. The S3 archive had events going back 2 years, but no process existed for replaying from S3 into the Flink pipeline. The fix required writing a custom Spark job to recompute the affected metrics from S3 data, which took 4 engineer-days to implement and validate.

**Late-arriving events from a mobile offline sync:** Mobile clients sync events when they reconnect after being offline. Events with event timestamps from 3 days ago arrived in the Kafka topic today. The daily order count metric for 3 days ago had already been materialized; the late events were not included in it. The business impact was a 2% undercount in daily orders for that day, which affected downstream finance reporting.

Both situations required reprocessing capabilities that were not built into the initial Kappa implementation.

## Decision
The replay and backfill strategy has three tiers based on event age:

**Tier 1: Kafka hot replay (0-14 days):** Flink checkpoint state is reset to a specific offset in the Kafka topic. The streaming job replays from that offset, recomputing all downstream tables from that point forward. Results overwrite the affected Iceberg partitions atomically. This is the standard replay path for recent corrections.

**Tier 2: S3 archive replay (14 days - 2 years):** Events older than 14 days are available in an S3 archive in Parquet format, partitioned by event date. A separate Flink job (or Spark job for very large ranges) reads from S3, applies the corrected logic, and writes results to the affected Iceberg partitions. Partition overwrite is atomic via Iceberg's overwrite API.

**Tier 3: Seed from operational database (any age):** For backfills where event replay is impractical or where the source-of-truth is the operational database rather than the event stream (e.g., a new metric derived from current database state), a one-time seed job reads from the operational database directly and populates the Iceberg table. This is used for initial population of new metrics, not for corrections to existing ones.

**Late event handling:** The Flink streaming job uses a watermark-based late event window of 72 hours. Events that arrive with event timestamps within the 72-hour window are included in the affected aggregation window's result via late data handling. Events older than 72 hours are routed to a separate late-event log for batch reconciliation.

## Alternatives Considered

**Kafka infinite retention:** Retain all events in Kafka forever, eliminating the need for an S3 archive tier. Rejected because the storage cost of infinite Kafka retention at current event volume (approximately 2TB per month) would exceed the cost of tiered storage (S3 archive) by 8x over a 2-year window.

**Replay using operational database snapshots:** Instead of replaying events, take point-in-time snapshots of the operational database and rebuild metrics from those snapshots. Rejected because operational database snapshots do not capture the event-time granularity needed for accurate time-window analytics. A daily database snapshot does not tell you how many orders arrived between 14:00 and 15:00 on a specific day.

**No replay; accept metric corrections as future adjustments:** When a logic bug is discovered, adjust the metric going forward without correcting historical data. This is the simplest approach. Rejected because corrected historical data is required for financial reporting accuracy and compliance. A 6-week undercount of revenue metrics cannot be left uncorrected.

## Consequences

### Positive
- Historical logic bugs can be corrected without ad-hoc code: the replay path is a first-class operational procedure with defined runbooks
- The 72-hour late event window handles the mobile offline sync scenario for most late arrivals without requiring a batch reconciliation job
- Iceberg's atomic partition overwrite ensures that readers see consistent data during a replay: they see either the old partition data or the new partition data, not a mix

### Negative
- Tier 2 S3 archive replay is slower than Tier 1 Kafka replay; reprocessing 6 weeks of data from S3 takes 3-4 hours, which is acceptable for non-urgent corrections but creates a window of stale data during the replay
- The late event window of 72 hours means that events arriving more than 72 hours late are not automatically included in historical aggregations; a separate process is required

### Risks
- **S3 archive data not in sync with Kafka.** If the S3 archiving job falls behind, recent events may be in Kafka but not yet in S3. A Tier 2 replay that assumes S3 is complete may produce incorrect results for the recent end of the time range. Mitigation: the replay procedure verifies that the S3 archive is complete to the replay end timestamp before starting.

## Review Trigger
Revisit the 14-day hot replay window if Kafka storage costs decrease to the point where extending hot retention is cost-effective. Revisit the 72-hour late event window if mobile offline sync patterns shift and events arrive more than 72 hours late more frequently.

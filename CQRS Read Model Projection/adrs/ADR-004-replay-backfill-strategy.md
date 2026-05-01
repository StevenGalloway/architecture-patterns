# ADR-004: Support replay/backfill to rebuild read models

## Status
Accepted

## Date
2025-11-12

## Context
Three months after the CQRS projector was deployed, two situations arose that required rebuilding the customer order history read model from scratch:

The first was a projection bug: a status mapping function had a defect that caused orders with a specific rare payment method to show incorrect status. The bug had been silently producing incorrect data for 6 weeks before it was discovered. Fixing the projection code was straightforward, but fixing the already-projected read model data required reprocessing all events for affected orders. There was no mechanism to do this selectively; the only option was to rebuild the entire read model from the event log.

The second situation was a new query requirement: the product team requested order history filtered by product category, which required a new field in the read model that had not been projected from earlier events. The field needed to be populated for all historical orders, not just new orders. This was a backfill from scratch, not a patch for a bug.

In both cases, the absence of replay tooling meant that rebuilding the read model required ad-hoc scripting, careful coordination to avoid serving stale data during the rebuild, and significant on-call time. The rebuild for 3.2 million orders took approximately 4 hours without any tooling to monitor progress.

## Decision
The projector is designed with first-class replay support:

**Replay from event log:** The projector supports a `--replay-from-offset=0` flag that resets the consumer offset for a given projector to the beginning of the event log. A full replay rebuilds the read model by reprocessing all historical events. Replay uses the same idempotent projection handlers as normal processing; the read model is cleared before replay begins to prevent stale data from before the replay appearing in query results.

**Shadow rebuild pattern:** For read models that must remain available during a rebuild, the projector rebuilds into a shadow table (`orders_read_model_new`) while the current table continues to serve queries. When the rebuild completes and the shadow table is within 5 seconds of live lag, the tables are swapped atomically (rename + alias update). The old table is kept for 48 hours before deletion as a rollback option.

**Write-side snapshot + event catch-up:** For very large event logs (over 10 million events), a full replay is slow. The projector supports seeding the read model from a point-in-time snapshot of the write-side database (exported as a CSV), then replaying only the events that occurred after the snapshot. This reduces rebuild time proportionally to the snapshot freshness.

**Progress monitoring:** Replay progress is exposed as a metric (`projector.replay.lag_events`) that counts remaining events. A dashboard shows estimated completion time. An alert fires if the replay lag has not decreased for 10 consecutive minutes (indicating a stalled replay).

## Alternatives Considered

**Selective re-projection (replay only affected aggregate IDs):** Identify the specific aggregate IDs whose read model data is incorrect and replay only their events. Simpler and faster for bug fixes that affect a known subset of aggregates. Adopted as a complementary capability but not as a replacement for full replay, because bugs that are discovered late may affect aggregates that cannot be identified without re-processing all events to find them.

**Read model versioning instead of replay (keep old read model, add new one alongside):** When the read model schema needs to change, create a new read model version (`orders_read_model_v2`) that is built from new events going forward, and maintain the old version for historical queries. Rejected because it requires the query service to understand and merge data from multiple versions, adding significant query complexity, and because it does not solve the case where historical data in the old model is incorrect and needs correction.

**Event log retention tied to read model rebuild capability:** Guarantee that the event log retains all events for at least as long as a full replay might be needed. Adopted as an operational constraint: the event log has a minimum retention of 2 years, and any policy change to the event log retention is reviewed against rebuild requirements.

## Consequences

### Positive
- Projection bugs can be corrected without ad-hoc scripting: reset the projector, run a replay, query the new read model
- New read model requirements that need historical backfill are addressed by the same replay mechanism, not by one-off migration scripts
- Shadow rebuild prevents downtime during large replays; the query service continues to serve the previous version while the rebuild proceeds

### Negative
- Full replay of a large event log is slow and resource-intensive; a 3.2M event replay at current throughput takes approximately 45 minutes without snapshot seeding
- The shadow rebuild pattern requires sufficient database capacity to hold two versions of the read model simultaneously during the rebuild window

### Risks
- **Read model serves stale data between replay clear and replay completion.** When a replay starts, the current read model is cleared. If the replay fails partway through, the read model may be partially populated (containing only a subset of events) and incorrect. Mitigation: the shadow rebuild pattern is the default for production replays; the old model is not cleared until the shadow is confirmed complete.

## Review Trigger
Revisit the snapshot-seeding approach if the event log grows beyond 50 million events, at which point even snapshot-plus-catch-up may take too long without additional parallelization of the replay pipeline.

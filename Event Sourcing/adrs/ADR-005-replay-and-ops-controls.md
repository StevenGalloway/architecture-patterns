# ADR-005: Provide replay tooling and operational controls

## Status
Accepted

## Date
2026-01-28

## Context
Event sourcing's replay capability is one of its primary operational advantages: the ability to rebuild derived read models from the authoritative event log. However, replay is only useful if the tooling to perform it is reliable, observable, and built into the system's operational model before it is needed in an incident.

Two situations made this clear. The first was a projector bug in the fee report read model that produced slightly incorrect aggregate values for accounts with multiple concurrent fee applications. When the bug was identified, the operations team had no mechanism to rebuild just the fee report read model. The only documented approach was to restart the projector and hope it rebuilt itself, which it did not (the consumer offset was not reset, so it only processed new events). Fixing the read model required an ad-hoc database patch script that took 4 hours to write and verify.

The second situation was adding a new `account_age_days` field to the account summary read model, required for a fraud model feature. This field needed to be populated for all existing accounts, not just accounts that receive new events. Without replay tooling, the new field would be null for all accounts created before the deployment date -- unacceptable for a field used in fraud scoring.

Both situations required replay capability that was not built into the initial projector implementation.

## Decision
The projector is built with the following operational controls:

**Cursor management:** The projector stores its change feed cursor in a `projector_state` table keyed by projector name. The cursor can be reset to any position (including offset 0 for full replay) via an admin API endpoint that requires operator authentication.

**Named projectors with independent cursors:** Each read model (account summary, transaction history, fee report) has its own named projector with an independent cursor. Resetting the fee report projector does not affect the account summary projector's position.

**Shadow rebuild:** A full rebuild uses the shadow table pattern: the projector writes to `{read_model}_rebuild` during replay, the production table continues serving queries, and the tables are swapped atomically when the rebuild is within 10 seconds of the live cursor. The old production table is retained for 48 hours before deletion.

**Lag and throughput metrics:** Each projector emits:
- `projector.lag.events`: events remaining between cursor and live head
- `projector.throughput.events_per_second`: current processing rate
- `projector.apply_failures.count`: events that failed to apply (parsing errors, constraint violations)

Alerts fire if `lag.events` exceeds 10,000 (indicating the projector is falling behind live event rate) or if `apply_failures` exceeds 0 for any 5-minute window.

**Runbook:** A runbook covers: how to identify a lagging projector, how to trigger a shadow rebuild, how to interpret lag metrics, and how to escalate if a rebuild fails partway through.

## Alternatives Considered

**Event log compaction with periodic snapshots:** Instead of replaying from the full event log, maintain aggregate snapshots at regular intervals (every 1,000 events per aggregate). Replay starts from the most recent snapshot, significantly reducing replay time. Adopted as a complementary optimization for state rehydration (loading individual aggregates for command processing), but not as a replacement for full event log replay. A snapshot covers one aggregate's state at one point in time; the fee report read model requires aggregate data across all accounts, which cannot be efficiently reconstructed from per-aggregate snapshots.

**External replay service:** A separate service owns replay orchestration, monitors projector lag, and triggers rebuilds automatically. Rejected for initial implementation because it adds an additional service dependency to an already operationally complex pattern. Replay tooling is embedded in the projector as an operational capability, not delegated to a separate service.

**Read model version tables instead of shadow rebuild:** Maintain read model versions as separate tables (`account_summary_v1`, `account_summary_v2`). New reads go to the latest version; during a rebuild, the new version is populated while the old version continues to serve reads. When the new version is ready, update the query service configuration to point to the new table. Partially adopted: the shadow rebuild naming convention uses versioned table names. Rejected as a long-term versioning strategy because it requires updating query service configuration on every rebuild, adding a manual coordination step.

## Consequences

### Positive
- Projection bugs are recoverable without ad-hoc scripting: reset the cursor, trigger a shadow rebuild, verify, swap
- New read models that need historical backfill use the same replay mechanism as bug fixes; no separate migration tooling is needed
- Lag alerts provide early warning before a falling-behind projector affects the freshness of read model data visible to users

### Negative
- Full replay of a large event log (the Account domain currently has 8.4 million events) takes approximately 2 hours at current throughput; this is acceptable for non-urgent rebuilds but unsuitable for incident response
- The shadow rebuild pattern doubles the read model storage requirement during the rebuild window; the infrastructure must have capacity for this

### Risks
- **Runbook staleness.** If the projector's internal implementation changes (cursor format, table names, admin API) and the runbook is not updated, the runbook becomes incorrect precisely when it is needed during an incident. Mitigation: the runbook is tested during quarterly disaster recovery drills that include a full projector replay exercise.

## Review Trigger
Revisit the replay throughput if the event log grows to 50 million events, at which point the 2-hour replay time may be unacceptable and parallelized replay (multiple projector instances reading different aggregate ID ranges) may be warranted.

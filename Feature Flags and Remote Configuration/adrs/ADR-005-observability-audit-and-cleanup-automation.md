# ADR-005: Immutable audit log, evaluation metrics, and automated cleanup alerts

## Status
Accepted

## Date
2026-03-04

## Context
Two operational gaps were identified as the flag system scaled from 15 to 47 flags over three months.

**Incident diagnosis without audit trail.** On 2026-02-11, a checkout error rate spike was traced to a flag targeting rule change. The on-call engineer knew the flag was involved but had no record of when it was changed, who changed it, or what the previous state was. The rule had been modified 4 hours before the incident. Finding the root cause required reading through Slack history. Once identified, the fix took 2 minutes; the investigation took 40 minutes.

**Stale flag accumulation.** The 47-flag count included 12 flags that had been at 100% for more than 60 days. No one could confirm whether those flags were still doing anything useful. Removing them would require reading through the code paths they guarded — which several engineers estimated at 2–3 hours per flag. This is the same "flag is never safe to remove because nobody knows if it's still load-bearing" problem that the taxonomy TTL policy (ADR-002) addresses at creation time. But TTL enforcement alone doesn't help for flags that were created before the policy, and it doesn't surface flags that are at 100% and could be permanently enabled in code.

## Decision

**1. Immutable audit log.**
Every flag create, update, and delete operation appends an entry to an append-only audit log:
```json
{
  "timestamp": "2026-02-11T14:32:01Z",
  "actor": "alice@example.com",
  "operation": "UPDATE",
  "flagKey": "checkout-v2",
  "before": { "rules": [{ "type": "percentage", "percentage": 10, "value": true }] },
  "after":  { "rules": [{ "type": "percentage", "percentage": 50, "value": true }] }
}
```
The log is stored in an append-only Redis stream (`XADD` only, no `DEL`). Entries are replicated to S3 daily for 1-year retention. The management API exposes `GET /audit?flagKey=<key>&since=<timestamp>` for on-call querying during incidents. Log entries cannot be modified or deleted via the management API — only S3 lifecycle rules govern eventual expiry.

**2. Evaluation event emission.**
The SDK emits a structured evaluation event for each flag check, sampled at 1% for flags evaluated > 1,000 times/minute:
```json
{
  "flagKey": "checkout-v2",
  "variant": true,
  "ruleMatched": "percentage-50",
  "tenantId": "t_7f3a",
  "userId": "u_9c21",
  "timestamp": "2026-03-04T09:15:33Z"
}
```
Events are written to a structured log sink (Loki or CloudWatch Logs). A dashboard shows variant distribution per flag over time — this is the primary signal for detecting unexpected flag behavior (e.g., a 10% flag suddenly evaluating to 80% because a targeting rule was misconfigured).

**3. Staleness alerts.**
A daily cron job checks:
- Release flags older than 25 days → Slack DM to flag owner ("flag expires in 5 days")
- Release flags older than 30 days → Slack alert to flag owner's team channel ("flag is overdue for cleanup")
- Experiment flags older than 80 days → warning; older than 90 days → overdue
- Any flag whose `owner` field references a team not in the org directory → alert to platform team

**4. Cleanup automation.**
When a Release or Experiment flag crosses its TTL, a GitHub issue is automatically created in the owning team's repo:
- Title: `[FLAG CLEANUP] Remove flag: checkout-v2 (expired 2026-03-15)`
- Body includes: flag definition, current variant distribution from evaluation events, list of files containing references to the flag key (from a static analysis scan)
- Issue is assigned to the flag's owner
- Issue is labeled `flag-debt` for tracking in team backlogs

## Alternatives Considered

**Git-based audit log (flag state stored in a git repo, changes tracked as commits):** Every flag change is a commit to a `flags/` directory. Git provides the full change history with actor and timestamp. Rejected because: (1) flag changes via API would need to commit to a git repo in the request path — adds latency and introduces git as a runtime dependency; (2) high-frequency flag changes (a/b experiment ramp up 1% increments) would create commit noise; (3) querying history by flag key requires git log filtering rather than a direct API.

**Application performance monitoring (APM) for evaluation events (no SDK-level emission):** Route all flag evaluations through a tracing library that auto-captures them as spans. Rejected as the sole mechanism because APM tools sample aggressively at high traffic volumes and drop spans — evaluation distribution metrics require more reliable counting. SDK-level emission with explicit 1% sampling at high volume gives controlled, predictable coverage.

**Manual cleanup process (rely on engineers to remove flags after TTL):** No automation; TTL is advisory. Teams are expected to create their own cleanup tickets. Rejected based on the observed outcome: 12 flags had been at 100% for 60+ days with no cleanup in progress. Advisory-only TTLs without automated surfacing do not produce the desired behavior.

## Consequences

### Positive
- The 40-minute incident investigation on 2026-02-11 would have been resolved in < 5 minutes with `GET /audit?flagKey=checkout-v2&since=24h`
- Evaluation distribution dashboard provides immediate visibility into unexpected flag behavior
- Staleness alerts and auto-generated cleanup issues surface flag debt before it accumulates to the 12-flag backlog observed in the initial audit
- Immutable log provides a compliance-ready change history for all flag modifications

### Negative
- Requires build investment: audit log API, evaluation event pipeline, cron job for staleness checks, static analysis integration for cleanup issues
- High-volume flags at 1% sampling still produce significant evaluation event volume — at 10,000 evaluations/second, 1% sampling is still 100 events/second per flag, which requires a log sink that can handle the throughput
- Auto-generated GitHub issues are useful only if teams close them; if teams ignore them, issue count grows and becomes noise

### Risks
- **Audit log Redis stream grows unbounded without expiry.** Redis streams require explicit `XLEN` monitoring and `XTRIM` or expiry policies. If the stream grows too large, Redis memory pressure affects flag state storage in the same Redis instance. Mitigation: S3 archival runs daily; after archival, entries older than 30 days are trimmed from the Redis stream.

## Review Trigger
Revisit the 1% sampling rate for evaluation events if a flag incident occurs that was not visible in the sampled data. Revisit the S3 retention period (1 year) if regulatory or compliance requirements extend the audit trail requirement.

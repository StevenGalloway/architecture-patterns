# ADR-004: Automatic abort and rollback on analysis failure

## Status
Accepted

## Date
2025-11-05

## Context
The question of whether to roll back automatically on analysis failure or require a human decision was debated at length. The concern about automation was that a miscalibrated threshold could trigger a rollback during a healthy deployment, requiring the team to re-deploy during business hours with no new information. The concern about human-in-the-loop was that the mean time to rollback is directly bounded by human response time, and on-call engineers are not always available to make decisions within the window where rollback reduces blast radius significantly.

A specific incident made the case for automation. During a canary deployment at 11:45 PM, the canary's error rate climbed to 3.2% (above the 2% threshold) due to a newly introduced dependency on a feature flag service that was not available in the production environment at that time. The analysis system detected the failure, but rollback required an on-call engineer to confirm and approve the action. The on-call engineer was paged but was not available for 18 minutes. During those 18 minutes, the canary remained at 20% traffic and continued to serve errors to a subset of users.

An automated rollback at the point of analysis failure would have reduced the error exposure window from 18 minutes to under 60 seconds.

## Decision
Canary rollouts are configured to **automatically abort and roll back** when any required analysis metric exceeds its threshold. The automated sequence is:

1. Analysis metric exceeds threshold for the configured evaluation window (5 minutes)
2. Rollout controller immediately sets canary traffic weight to 0%
3. Canary replica set is scaled down to 0 pods
4. Stable replica set is confirmed as the sole active version
5. On-call engineer is paged with rollout context: which service, which deployment, which metric triggered the abort, the metric value that triggered, and a link to the analysis dashboard

The on-call notification is informational, not a required approval step. The rollback has already completed by the time the engineer is paged.

Manual override is available: an engineer can mark an analysis run as inconclusive (e.g., an external dependency outage caused the metric spike, not the new code) and restart the rollout. Manual override requires a comment explaining the reasoning, which is logged with the rollout record.

## Alternatives Considered

**Human-approval required for rollback:** Analysis failure triggers a page; the on-call engineer reviews the metrics and manually approves or rejects the rollback. Rejected because the 18-minute response time incident demonstrated the cost of human latency in the rollback path. For a 2% error threshold, each minute of delay exposes 2% more of the user base to elevated errors.

**Automatic pause (traffic freeze) instead of automatic rollback:** On analysis failure, freeze the canary traffic weight (do not promote or roll back) and page the on-call engineer to decide. Rejected because freezing at 20% traffic leaves 20% of users experiencing errors while the engineer reviews. An automatic rollback to 0% stops the error exposure immediately; the engineer then has time to review without ongoing user impact.

**Probabilistic rollback (roll back if failure persists for 10 consecutive minutes):** Require sustained analysis failure before rolling back, to reduce false positives from transient metric spikes. Partially adopted via the 5-minute evaluation window -- a single spike does not trigger immediate rollback. But extending to 10 minutes was rejected because it doubles the minimum exposure window for genuine regressions.

## Consequences

### Positive
- Rollback time from analysis failure to full stable traffic is under 60 seconds, regardless of time of day or on-call availability
- The on-call engineer receives a rollback notification with full context, allowing post-mortem analysis without time pressure to decide
- The manual override mechanism provides an escape valve for false positives without requiring blanket human approval for all rollbacks

### Negative
- Automated rollback on a false positive (e.g., a transient metric spike unrelated to the canary) triggers a full re-deployment cycle for a healthy change, consuming engineering time and delaying the release
- The rollback notification must include enough context for the on-call engineer to determine within minutes whether the rollback was justified, which requires structured rollout context to be available at notification time

### Risks
- **Cascading rollbacks during platform-wide incidents.** If a shared dependency (database, external API) degrades during multiple simultaneous canary deployments, all canaries may trigger automated rollbacks simultaneously. This is correct behavior (protecting user traffic) but can cause confusion if the team incorrectly attributes the platform incident to specific deployments. Mitigation: the rollback notification includes the metric value and a comparison to the stable version's current metric value; if stable is also degraded, the rollback was triggered by a platform issue, not the canary.

## Review Trigger
Revisit the 5-minute evaluation window if false positive rollbacks become frequent (more than 10% of automated rollbacks are later determined to be false positives). A longer window reduces false positives but increases blast radius for genuine regressions.

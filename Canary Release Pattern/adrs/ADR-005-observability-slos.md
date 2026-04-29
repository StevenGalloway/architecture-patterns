# ADR-005: Observability is mandatory for Canary rollouts

## Status
Accepted

## Date
2025-12-22

## Context
After canary deployments were running for two months, we identified a recurring gap: the automated analysis could tell us whether to roll back, but it could not tell us *why* a canary was behaving differently from stable. This distinction matters because the appropriate response to "canary has elevated error rate because of a new code bug" is different from "canary has elevated error rate because it was the version running when an unrelated database incident occurred."

A specific rollback investigation took 3 hours to resolve because the deployment team could not determine whether the elevated error rate on the canary had been caused by the new code or by a Redis cluster rebalancing event that happened to occur during the canary window. The investigation involved manually correlating deployment timeline data, Redis cluster event logs, and application error logs -- data that existed in three different systems with three different time formats.

The observability requirement for canary deployments is not just "collect the metrics used for analysis" -- it is "collect enough context that post-rollback investigations can be completed quickly and the cause of analysis failure can be attributed unambiguously."

## Decision
The following observability requirements are mandatory for any service that uses canary deployments:

**Per-version request metrics:** All request metrics (rate, error rate, latency) are tagged with a `version` label (`stable` or `canary`) so that canary and stable traffic can be graphed separately in the same dashboard. This is enforced at the metrics instrumentation layer, not derived from separate service instances.

**Dependency failure metrics:** Downstream dependency failures and timeouts are tracked separately from application-layer errors, with the same `version` tag. This allows the investigation team to distinguish "canary has high error rate because of its own code" from "canary has high error rate because it calls a new dependency that is unhealthy."

**Rollout event markers:** Rollout step transitions (weight changes), analysis results, aborts, and promotions are emitted as annotation events to the dashboard platform. These appear as vertical markers on time-series graphs, making it immediately visible when the canary weight changed in relation to metric changes.

**Structured rollback context:** When an automated rollback occurs, a structured event is logged containing: service name, deployment ID, triggering metric name, metric value at trigger, evaluation window start/end, a direct link to the canary analysis dashboard filtered to the rollout window.

**Runbook per service:** Each service with canary deployments maintains a runbook documenting how to interpret its analysis metrics, common false positive patterns (e.g., "a Redis eviction event always causes a 30-second error spike and should not trigger rollback"), and the escalation path for rollbacks that cannot be attributed.

## Alternatives Considered

**Generic dashboards without rollout context:** Use existing service dashboards (error rate, latency) without rollout-specific annotations or version tagging. Rejected because this requires investigators to manually correlate deployment timeline data with metric data, which was the time-consuming part of the 3-hour investigation. Annotations and version tags reduce investigation time for the most common case.

**Separate monitoring stack for canary analysis:** Run canary traffic through a separate metrics collection pipeline so canary metrics are completely isolated from production metrics. Rejected because the point of a canary deployment is to observe the new version under production conditions, including shared dependencies. A separate pipeline would not capture interactions with the production environment.

**AI-assisted rollback investigation:** After each rollback, an automated analysis system reviews logs and metrics to suggest probable causes. Deferred: this is a useful future capability but requires a significant investment in log correlation tooling that is not justified until the team has validated canary deployments at scale with sufficient rollback data to train the system.

## Consequences

### Positive
- Post-rollback investigations that previously took hours can be completed in minutes because the rollout context, version-tagged metrics, and dependency failure data are co-located in the same dashboard
- Rollout event markers in dashboards allow engineers to say "the error rate spike started exactly when the canary was promoted to 20%" rather than manually correlating timestamps
- The runbook requirement ensures that service teams document their service's canary behavior before deploying, which often surfaces threshold miscalibrations before they cause false positives in production

### Negative
- Version-tagged metrics double the cardinality of all request metrics during canary periods; at high deployment frequency this adds non-trivial storage cost to the metrics platform
- Runbook maintenance requires ongoing ownership; runbooks written at deployment time become stale when the service's behavior or dependencies change

### Risks
- **Metrics collection failure during rollout.** If the metrics pipeline experiences an outage during a canary window, the analysis system has no data to evaluate and defaults to pausing the rollout. This is the safe failure mode, but it delays promotions. Mitigation: the metrics pipeline has its own availability SLO (99.9%), and a canary pause due to missing metrics generates an alert distinct from an analysis failure alert.

## Review Trigger
Revisit if the team adopts a unified observability platform (e.g., Grafana + Mimir + Tempo) that provides built-in deployment tracking, at which point some of the manual annotation and runbook requirements may be replaceable with platform-native features.

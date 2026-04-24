# ADR-005: Instrument bulkhead saturation and tune limits using SLOs

## Status
Accepted

## Date
2025-12-10

## Context
After bulkheads were deployed with initial limit values, we had no systematic way to evaluate whether the limits were well-calibrated. An over-provisioned limit (too high) provides insufficient isolation: a slow dependency can still consume enough permits to affect other callers. An under-provisioned limit (too low) creates unnecessary rejections during normal traffic peaks, generating errors that look like dependency failures in dashboards but are actually self-imposed capacity constraints.

In the first two weeks after deployment, the on-call team received three pages for elevated 503 error rates on the Notification service bulkhead. Investigation revealed the Notification service semaphore limit of 20 was being hit during normal batch notification processing that coincided with peak order traffic. The limit was too conservative for the actual traffic pattern. The pages were false positives -- the system was protecting itself from a threat that was not present -- but they consumed on-call time and generated unnecessary customer-facing errors.

We needed an observability foundation that would allow us to distinguish "bulkhead correctly protecting critical path from slow dependency" from "bulkhead incorrectly rejecting legitimate traffic due to miscalibrated limit."

## Decision
The following metrics are instrumented for each bulkhead and reported to the metrics platform:

- `bulkhead.permits.in_use` (gauge): current in-flight count per dependency, sampled every 10 seconds
- `bulkhead.permits.saturation_seconds` (counter): cumulative seconds spent at max permit utilization per dependency
- `bulkhead.rejects.count` (counter): requests rejected due to exhausted permits, by dependency and endpoint
- `bulkhead.downstream.latency_p99` (histogram): downstream call latency per dependency
- `bulkhead.downstream.timeout_rate` (rate): proportion of calls that hit the per-call timeout per dependency

Alerting thresholds:
- Alert if `bulkhead.permits.saturation_seconds` exceeds 30 seconds in a 5-minute window for any critical-path dependency
- Alert if `bulkhead.rejects.count` exceeds 1% of total requests for any dependency
- Page if `bulkhead.rejects.count` exceeds 5% for any critical-path dependency

Limit tuning process: limits are reviewed after each alert and after any change to downstream service capacity. The target is for `permits.in_use` to reach no more than 70% of the limit during peak traffic in normal operating conditions, leaving 30% headroom for spikes. If peak usage consistently stays below 50% of the limit, the limit is reduced.

## Alternatives Considered

**Adaptive/auto-tuning bulkhead limits:** The semaphore limit adjusts automatically based on observed downstream latency (increase limit when latency is low, decrease when latency rises). Rejected for initial deployment because adaptive limits are complex to reason about during incidents -- it is hard to determine whether a high reject rate is because the limit is too low or because the adaptive algorithm correctly responded to downstream degradation. Manual tuning with good observability is preferable until we have sufficient operational experience.

**No dedicated metrics; rely on downstream error rates in existing monitoring:** Use existing error rate and latency dashboards for downstream dependencies without adding bulkhead-specific metrics. Rejected because downstream error rates do not distinguish between "requests that reached the downstream and failed" and "requests that were rejected at the bulkhead and never reached the downstream." The distinction matters for triage.

**Centralized bulkhead management service:** A shared service manages semaphore limits across all service instances and dynamically adjusts them based on aggregate traffic patterns. Rejected because it adds a new distributed coordination dependency to the request path. Local semaphores with good per-instance observability provide sufficient control without adding a coordination failure mode.

## Consequences

### Positive
- Distinguishes legitimate protection events (Fraud Detection slow, bulkhead correctly containing blast radius) from miscalibration events (Notification limit too low, rejecting valid traffic)
- The saturation metric provides early warning before the reject rate climbs, allowing proactive limit adjustment
- Operational runbook linked from alert documentation gives on-call engineers a clear playbook for each alert type

### Negative
- Metrics instrumentation adds a small overhead to each request: gauge updates and counter increments on every bulkhead acquire/release cycle
- Limit tuning requires periodic review; without active ownership, limits will stagnate and drift from optimal values as traffic patterns change

### Risks
- **Alert fatigue from miscalibrated thresholds.** If the reject rate threshold (1%) is set too tightly relative to normal traffic variability, the alert fires during minor spikes that do not require intervention. Mitigation: the 1% threshold was validated against two weeks of post-deployment traffic data before being set as a page threshold. It is revisited after any significant traffic change (new product launch, seasonal event).

## Review Trigger
Revisit limit values after any major product launch that changes traffic patterns. Revisit the observability model if the team adopts a service mesh that provides dependency-level metrics natively, which would allow bulkhead metrics to be correlated directly with mesh-level observability data.

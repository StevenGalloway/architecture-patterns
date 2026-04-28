# ADR-003: Define a minimal analysis contract and SLO thresholds

## Status
Accepted

## Date
2025-09-10

## Context
Automated canary analysis is only useful if the metrics it evaluates are the right metrics and the thresholds are calibrated to distinguish real regressions from normal statistical noise. When automated analysis was first enabled, it used a single metric: HTTP 5xx error rate. The threshold was set at 1%.

The first canary that failed analysis had a 0% error rate but had introduced a 120ms latency regression on the order confirmation endpoint. The automated analysis passed the canary through to full traffic because it was only checking error rate. Users and engineering leadership noticed the regression through customer feedback and manual dashboard review 35 minutes after full promotion.

Conversely, a separate canary was aborted by the automated analysis because a single slow request pushed the error rate above 1% during the 15-minute analysis window. The deployment was rolled back, investigated, and found to be healthy -- the single slow request was an outlier. The canary had been aborted based on insufficient sample size.

Both failure modes -- false negative (regression not caught) and false positive (healthy deployment aborted) -- were caused by an under-specified analysis contract. We needed a structured, documented set of metrics and thresholds per service that the team agreed to maintain.

## Decision
Each service that uses canary deployments maintains an **analysis contract** file in its repository specifying:

**Required metrics (all must pass for promotion):**
- `error_rate_5xx`: percentage of requests returning 5xx. Threshold: < 2% over the analysis window
- `latency_p95_ms`: p95 response time in milliseconds. Threshold: < 300ms (or service-specific baseline + 20% margin)
- `latency_p99_ms`: p99 response time. Threshold: < 500ms (or baseline + 30% margin)

**Resource guardrails (failure causes analysis failure, not immediate abort):**
- CPU utilization: < 80% sustained over 5 minutes
- Memory usage: < 85% of limit

**Minimum sample size gate:** The analysis does not begin until the canary has processed at least 500 requests. If the minimum is not reached within 30 minutes, the canary is paused and an alert is sent.

Thresholds are defined as absolute values in the contract file, not as percentages relative to stable, because relative comparisons require stable to be healthy during the analysis window. An absolute threshold is evaluated independently.

## Alternatives Considered

**Relative comparison between canary and stable metrics:** The canary is considered healthy if its error rate is within X% of the stable version's current error rate. Rejected for primary thresholds because if stable is currently degraded (an unrelated incident), a canary with the same degradation would pass analysis even though it is producing errors at a rate that violates the service SLO.

**Single composite health score:** Aggregate all metrics into a single score and compare to a threshold. Rejected because a composite score obscures which specific metric is causing a failure. During rollback investigations, the on-call engineer needs to know whether the canary failed due to latency, errors, or resource saturation -- not just that the score was below threshold.

**AI/ML-based anomaly detection for canary analysis:** Use a trained model to detect anomalous behavior in canary traffic rather than fixed thresholds. Rejected for initial deployment because ML-based anomaly detection requires a training period, produces opaque decisions that are hard to explain during incidents, and is a significant investment relative to the value gained compared to well-calibrated fixed thresholds.

## Consequences

### Positive
- The analysis contract is a written, versioned artifact that the team reviews and updates; there is no ambiguity about what criteria a canary must meet for promotion
- Latency regression detection (the failure mode from the 120ms incident) is now part of the standard analysis
- The minimum sample size gate prevents false aborts on insufficient data, addressing the second failure mode

### Negative
- Analysis contracts must be updated when service traffic patterns change (e.g., a new high-traffic endpoint that has different latency characteristics than the existing baseline)
- Absolute thresholds require agreement on what the service's baseline performance should be, which requires prior measurement and team alignment

### Risks
- **Stale thresholds after infrastructure changes.** If the service migrates to larger instances or a faster database, the latency baseline improves but the analysis contract still uses the old thresholds. The canary would pass at the old threshold even if it introduced a regression relative to the new baseline. Mitigation: the analysis contract is reviewed and updated after any infrastructure change that materially affects the service's performance profile.

## Review Trigger
Revisit thresholds after any significant traffic growth (>50% increase in request rate) or infrastructure change that shifts the service's normal operating range.

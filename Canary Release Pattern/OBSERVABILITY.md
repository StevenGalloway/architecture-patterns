# Observability — Canary Release Pattern

## Why Observability is Existential for Canary

Canary releases are only as good as the metrics used to evaluate them. The entire premise of the pattern — that automated analysis can distinguish a healthy deployment from a regression — depends on measuring the right things, with sufficient signal, and comparing them correctly.

Bad analysis gates produce two failure modes:

**False negative (canary passes but was broken):** The analysis window is too short, the thresholds too wide, or the wrong metrics are measured. A genuine regression is promoted to 100% of traffic. The canary provided false confidence — it was worse than no canary at all, because the team believed they had validation coverage they didn't have.

**False positive (canary fails on noise):** Metric variance is higher than the threshold allows for. The analysis fails on a healthy deployment due to normal traffic fluctuation. Engineers receive a rollback notification, investigate, find nothing wrong, and re-promote manually. After the third false positive, engineers stop trusting the analysis automation and begin bypassing it. This is the failure mode that kills canary programs — not technical failure, but erosion of trust.

Getting observability right is not a nice-to-have. It is the prerequisite for canary releases working at all.

---

## Golden Signals Applied to Canary Analysis

The critical insight for canary metric evaluation: **compare canary against stable, not canary against an absolute threshold.** The stable version serves as a real-time control group. This approach is more robust than absolute thresholds because it automatically accounts for time-of-day traffic patterns, external load changes, and infrastructure variability. If the stable version's p95 latency increases during a deployment window (due to an upstream dependency issue), an absolute threshold would flag the canary as degraded — a false positive. A relative comparison would correctly recognize that both versions are slower, indicating an external cause rather than a canary regression.

### 1. Latency

Compare percentile latency between stable and canary pods for the same time window:

| Metric | Query pattern | Failure condition |
|---|---|---|
| `canary.latency.p50` | `histogram_quantile(0.50, rate(http_request_duration_ms_bucket{version="canary"}[5m]))` | `canary.p50 / stable.p50 > 1.15` (15% slower than stable) |
| `canary.latency.p95` | `histogram_quantile(0.95, rate(http_request_duration_ms_bucket{version="canary"}[5m]))` | `canary.p95 / stable.p95 > 1.15` (15% slower) OR `canary.p95 > 200` (absolute SLO breach) |
| `canary.latency.p99` | `histogram_quantile(0.99, rate(http_request_duration_ms_bucket{version="canary"}[5m]))` | `canary.p99 / stable.p99 > 1.25` (25% slower — p99 has higher natural variance) |

The 15% relative threshold reflects the finding from ADR-001: the 40ms regression on the Orders service represented roughly a 25% increase in query latency. A 15% degradation threshold would have caught this during the first canary step.

### 2. Traffic

Traffic metrics validate the traffic splitting mechanism, not the application:

| Metric | What it measures | Failure condition |
|---|---|---|
| `canary.traffic_weight` | `canary.requests.rate / (canary.requests.rate + stable.requests.rate)` | `abs(measured_weight - declared_weight) > 0.01` (±1% from declared weight) |
| `canary.request_rate` | Absolute requests per second hitting canary pods | Drop > 50% from expected indicates routing failure, not code regression |

Traffic weight drift above ±1% indicates a traffic splitting misconfiguration — the ingress controller or service mesh is not enforcing the declared weight. This is a platform issue, not a code regression, and should not trigger a canary rollback. It should trigger a platform alert.

### 3. Errors

Compare error rates between versions using the stable version as a real-time baseline:

| Metric | Query pattern | Failure condition |
|---|---|---|
| `canary.error_rate` | `sum(rate(http_requests_total{version="canary",status=~"5.."}[5m])) / sum(rate(http_requests_total{version="canary"}[5m]))` | `canary.error_rate - stable.error_rate > 0.005` (0.5% absolute increase above stable baseline) |
| `canary.4xx_rate` | Same pattern, status=~"4.." | `canary.4xx_rate / stable.4xx_rate > 2.0` (doubling of 4xx rate indicates auth or validation regression) |

Using `canary.error_rate - stable.error_rate > threshold` instead of `canary.error_rate > absolute_threshold` prevents false positives when the stable version's error rate temporarily increases due to external conditions during the canary window.

### 4. Saturation

A canary that consumes significantly more resources than stable will degrade under traffic growth and cost more to run:

| Metric | Query pattern | Failure condition |
|---|---|---|
| `canary.cpu.utilization` | `avg(rate(container_cpu_usage_seconds_total{pod=~"orders-canary.*"}[5m]))` | `canary.cpu / stable.cpu > 1.25` (25% higher CPU than stable) |
| `canary.memory.utilization` | `avg(container_memory_working_set_bytes{pod=~"orders-canary.*"})` | `canary.memory / stable.memory > 1.20` (20% higher memory) |
| `canary.gc_pause_time` (JVM/Go) | Language-specific GC metrics | `canary.gc_pause_p99 > stable.gc_pause_p99 × 1.50` (GC regression is a common memory leak signal) |

---

## SLI / SLO Definitions

### Canary Analysis Accuracy SLO

**SLI:** Percentage of canary rollouts that proceeded to 100% promotion and subsequently did not produce a production incident within 24 hours.

**SLO:** 95% of promoted canary releases are incident-free within 24 hours.

This SLO measures analysis false negatives — promotions of builds that should have been rolled back. If this number falls below 95%, the analysis thresholds are too permissive and must be tightened.

### Rollback Execution SLO

**SLI:** Percentage of automated rollback events that complete (traffic fully shifted back to stable) within 2 minutes of the analysis failure decision.

**SLO:** 99% of rollback events complete within 2 minutes.

A rollback that takes longer than 2 minutes is a platform failure mode, not a normal operational event.

### False Positive Rate SLO

**SLI:** Percentage of canary rollbacks where post-rollback investigation confirms no code regression (rollback caused by metric noise or threshold miscalibration).

**SLO:** False positive rate < 10% of all rollbacks.

Above 10%, engineer trust in canary automation degrades and bypass behavior increases. Investigate and re-tune thresholds when this threshold is breached.

---

## Structured Log Schema for Canary Events

Every promotion decision, rollback decision, and analysis step produces a structured log entry:

```json
{
  "event_type": "canary_analysis",
  "deployment_id": "orders-deploy-20240115-083421",
  "service": "orders",
  "version_stable": "v2.0.4",
  "version_canary": "v2.1.0",
  "step_weight": 5,
  "analysis_window_minutes": 10,
  "analysis_result": "fail",
  "metrics": [
    {
      "metric_name": "error-rate",
      "stable_value": 0.003,
      "canary_value": 0.009,
      "threshold": 0.005,
      "delta": 0.006,
      "result": "fail"
    },
    {
      "metric_name": "p95-latency-ms",
      "stable_value": 142,
      "canary_value": 185,
      "threshold_ratio": 1.15,
      "actual_ratio": 1.30,
      "result": "fail"
    },
    {
      "metric_name": "saturation-cpu",
      "stable_value": 0.42,
      "canary_value": 0.45,
      "threshold_ratio": 1.25,
      "actual_ratio": 1.07,
      "result": "pass"
    }
  ],
  "decision": "rollback",
  "decision_reason": "error-rate exceeded stable baseline by 0.006 (threshold: 0.005); p95 latency 30% higher than stable (threshold: 15%)",
  "rollback_initiated_at": "2024-01-15T08:44:21Z",
  "rollback_completed_at": "2024-01-15T08:45:47Z",
  "rollback_duration_seconds": 86,
  "notification_sent_to": "#checkout-alerts",
  "timestamp": "2024-01-15T08:44:21Z"
}
```

These logs serve as the immutable audit trail for canary decisions. They are the answer when a compliance audit asks "what was the basis for promoting this build to production?"

---

## Key Dashboards

### 1. Canary Rollout Status (operational, live during deployments)
- Current deployment: service name, stable version, canary version
- Current step weight (5% / 20% / 50% / 100%) and time elapsed in current step
- Analysis status per metric: pass / fail / evaluating
- Promotion timeline: when did each step promote, when is the next step scheduled

### 2. Stable vs. Canary Comparison (per-deployment analysis view)
- Side-by-side p50, p95, p99 latency: stable (blue) vs. canary (green), same time window
- Side-by-side error rate: absolute values and delta from stable
- CPU and memory utilization comparison
- Traffic weight actual vs. declared (detects traffic splitting misconfiguration)

### 3. Historical Canary Outcomes (weekly operations review)
- Total deployments in period: promotions vs. rollbacks
- Rollback reason distribution: which metric triggered rollback most often
- False positive rate trend: rollbacks confirmed as non-regressions after investigation
- Mean time from canary start to full promotion (healthy deployments)

### 4. Analysis Accuracy (monthly, for threshold tuning)
- False negative incidents: promotions that caused production incidents within 24 hours
- False positive rate: rollbacks confirmed as noise
- Threshold sensitivity: how close metric values got to thresholds across all deployments (identifies thresholds that are too tight or too loose)

---

## Chaos Scenarios

Test these behaviors in staging before production and quarterly thereafter:

| Scenario | Test method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Analysis service unavailable** | Kill the Prometheus endpoint the AnalysisTemplate queries | Canary should pause (not auto-promote, not auto-rollback) and alert on-call | Analysis status shows "insufficient data"; no promotion occurs; platform alert fires |
| **Metric store gap (sparse data)** | Drop metric collection for 2 minutes during analysis window | Insufficient data should be treated as analysis failure, not success | Canary pauses or rolls back; does not promote on zero-sample analysis |
| **Stable version degrades during canary window** | Inject latency into stable pods during canary analysis | Relative comparison should not flag canary as failing; absolute SLO threshold is the safety net | Canary analysis passes on relative comparison; absolute threshold catches if both versions exceed SLO |
| **Rollback execution failure** | Block the Rollout controller from updating the service | Rollback failure must alert platform on-call within 3 minutes | PagerDuty alert fires within 3 minutes of rollback initiation without completion |
| **Traffic weight drift** | Misconfigure ingress to route 15% to canary during 5% step | Traffic weight metric detects drift; platform alert fires | `canary.traffic_weight` metric shows 15%; alert fires; does not trigger canary rollback (platform issue, not code issue) |

---

## Alerting

**Page on:**
- Automated rollback fails to complete within 3 minutes — this is a platform failure requiring immediate intervention
- Canary analysis reports "insufficient data" for two consecutive analysis windows — metric collection may have failed silently
- Traffic weight drift > 2% from declared weight for > 5 minutes — traffic splitting is misconfigured

**Notify (Slack, no page):**
- Canary rollback occurs — SRE awareness; the rollback worked as designed, but SRE should know a regression was caught
- Canary promotion to each step (5%, 20%, 50%, 100%) — audit trail for the service owner's Slack channel
- Analysis false positive confirmed — prompts threshold review

**Do not alert on:**
- Individual canary analysis failures — these are expected; the system rolled back automatically; a page is not appropriate unless the rollback itself failed
- Canary deployments completing successfully — this is the normal case; do not create notification fatigue
- Metric values approaching (but not exceeding) thresholds — these are informational; page only on threshold breach

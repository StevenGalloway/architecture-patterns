# Observability — Bulkhead Pattern

## Why Bulkhead Observability Requires Specific Instrumentation

A bulkhead that emits no metrics is invisible. You cannot tell whether it is protecting you — whether the limits are appropriate, whether they are being approached, whether they are being hit constantly and rejecting legitimate traffic. Uninstrumented bulkheads are only marginally better than no bulkheads: you get fault isolation, but you get no signal when that isolation is being stressed, and no data for tuning.

The primary observable signal from a bulkhead is the rejection rate per dependency. This metric does not exist in standard HTTP client or connection pool instrumentation. It requires deliberate, bulkhead-specific instrumentation. The platform engineering team ensures that the bulkhead library emits this metric automatically; service teams do not wire it manually.

---

## Golden Signals

### 1. Latency

| Metric | Description | Alert threshold |
|---|---|---|
| `bulkhead.acquire_latency_ms{dependency}` | Time from permit request to permit acquisition. In fail-fast mode, this should be near zero — the permit is either available (microseconds) or the request is rejected immediately. Sustained values above 1ms indicate queuing behavior or lock contention in the semaphore implementation. | p99 > 5ms |
| `bulkhead.total_request_latency_ms{dependency}` | Total time for a bulkhead-protected call: permit acquisition + downstream call latency + permit release. Segmenting by dependency reveals which downstream service contributes most to overall request latency. | Per-dependency baseline × 3 |
| `bulkhead.downstream_latency_ms{dependency}` | Time spent in the downstream call after permit acquisition. If this grows (e.g., Fraud Detection goes from 80ms to 1,400ms), the bulkhead's permit utilization will rise as in-flight requests stay open longer. The latency increase is the leading indicator; permit exhaustion follows. | p99 × 2 sustained |
| Latency by compartment: saturated vs. normal | Compare p99 latency for Payment calls during periods when Fraud Detection's bulkhead is saturated vs. when it is not. If payment latency is unaffected during fraud saturation, the bulkheads are working. If payment latency rises during fraud saturation, there is a shared resource not covered by the bulkhead. | Increase > 10% during peer saturation |

### 2. Traffic

| Metric | Description |
|---|---|
| `bulkhead.permits_acquired_total{dependency}` | Counter of permits successfully acquired per dependency per time period. Represents actual call volume reaching each dependency. |
| `bulkhead.permits_rejected_total{dependency}` | Counter of permits rejected (bulkhead was exhausted). **This is the primary bulkhead health metric.** Any non-zero value means traffic is being shed from a dependency. |
| `bulkhead.rejection_rate{dependency}` | `rejected / (acquired + rejected)` per time window. Rejection rate above 0% means the bulkhead is actively shedding load. Expected to be 0% under normal conditions; acceptable under extreme load (but should trigger review). |
| `bulkhead.permits_acquired_per_second{dependency}` | Request rate per dependency. Useful for detecting traffic shifts between dependencies that would change appropriate limit values. |

### 3. Errors

| Metric | Description |
|---|---|
| `bulkhead.rejected_total{dependency}` | Total bulkhead rejections, labeled by dependency name. This is the top-level error metric for bulkhead health. Segment by `dependency` to identify which compartment is under pressure. |
| `bulkhead.downstream_errors_total{dependency, error_type}` | Errors that occur after permit acquisition (timeouts, connection errors, 5xx responses from downstream). Separating these from bulkhead rejections distinguishes between "we can't get a permit" and "we got a permit but the call still failed." |
| `circuit_breaker.state{dependency}` | Current state (CLOSED, OPEN, HALF-OPEN) for each dependency. A circuit breaker that opens during bulkhead saturation confirms that the dependency is genuinely degraded, not just slow. |
| `bulkhead.rejected_total{dependency} / http.requests.total` | The fraction of all inbound requests that result in a bulkhead rejection. If 10% of Order creation requests are rejected at the Fraud Detection bulkhead, that means 10% of orders with new customers are failing. |

**Distinguishing rejection sources in logs:**

```json
{
  "timestamp": "2025-11-29T03:14:01.720Z",
  "request_id": "9b1e7c22-84b3-4d2a-b981-2a1e67804de0",
  "order_id": "ord_789123",
  "dependency": "fraud_detection",
  "event": "bulkhead_rejected",
  "permits_available": 0,
  "permits_in_use": 30,
  "permits_max": 30,
  "action_taken": "order_proceeded_without_fraud_check",
  "reason": "fraud_detection_bulkhead_exhausted"
}
```

This structured log entry enables exact attribution: which dependency rejected, how many permits were in use, and what the service did in response (proceed without the check, or reject the order entirely).

### 4. Saturation

Saturation metrics provide early warning before permits are fully exhausted. The goal is to alert when the limit is being approached, not after it has been exceeded and traffic is already being shed.

| Metric | Description | Alert threshold |
|---|---|---|
| `bulkhead.permits_available{dependency}` | Current permits remaining in the pool. Approaching 0 = imminent saturation. | < 20% of max (e.g., < 6 of 30 for Fraud Detection) |
| `bulkhead.utilization_pct{dependency}` | `(permits_in_use / permits_max) × 100`. The primary saturation gauge. | > 80% sustained for 5 minutes |
| `bulkhead.permits_in_use{dependency}` | Current in-flight requests per dependency. Useful for seeing how saturated each compartment is in absolute terms. | Approaching max per dependency |
| Comparative saturation across dependencies | Heatmap of utilization across all dependencies simultaneously. Reveals if multiple dependencies are approaching limits at the same time (coordinated load event vs. single dependency issue). | Any dependency > 80% for 5+ min |

---

## SLI / SLO Definitions

### Rejection Rate SLO (Per Dependency)

**SLI:** Percentage of permit requests that are successfully acquired (not rejected by the bulkhead).

```
SLI = bulkhead.permits_acquired / (bulkhead.permits_acquired + bulkhead.permits_rejected)
      measured per dependency, per 5-minute window
```

**SLO targets:**

| Dependency | Rejection rate SLO | Rationale |
|---|---|---|
| Payment Service | < 0.1% rejections | Critical path; any rejection is a payment failure |
| Inventory Service | < 0.1% rejections | Critical path; rejection blocks order completion |
| Fraud Detection | < 2% rejections | Non-critical; some shedding acceptable under peak load |
| Notification Service | < 5% rejections | Best-effort; best-effort by definition tolerates some loss |

A sustained Payment rejection rate above 0.1% is an on-call page. A sustained Fraud Detection rejection rate above 2% is a team notification to review the limit.

### Critical-Path Dependency Availability SLO

**SLI:** Percentage of order creation requests that complete without a bulkhead rejection on a critical-path dependency (Payment or Inventory).

**SLO:** 99.9% of order creation requests over a rolling 28-day window complete without a Payment or Inventory bulkhead rejection.

This SLO captures the user-visible outcome of bulkhead configuration: a correctly configured and correctly sized bulkhead should never reject critical-path calls during normal operations.

---

## Structured Log Schema for Bulkhead Events

Four event types are logged by the bulkhead library automatically:

**Permit acquired:**
```json
{
  "event": "bulkhead_permit_acquired",
  "dependency": "payment_service",
  "permits_in_use": 12,
  "permits_max": 80,
  "acquire_latency_us": 42
}
```

**Permit released:**
```json
{
  "event": "bulkhead_permit_released",
  "dependency": "payment_service",
  "permits_in_use": 11,
  "permits_max": 80,
  "held_duration_ms": 148
}
```

**Permit rejected:**
```json
{
  "event": "bulkhead_permit_rejected",
  "dependency": "fraud_detection",
  "permits_in_use": 30,
  "permits_max": 30,
  "utilization_pct": 100.0
}
```

**Circuit breaker state change:**
```json
{
  "event": "circuit_breaker_state_change",
  "dependency": "fraud_detection",
  "previous_state": "CLOSED",
  "new_state": "OPEN",
  "failure_rate_pct": 52.3,
  "consecutive_failures": 10
}
```

---

## Key Dashboards

### 1. Bulkhead Capacity Utilization Heatmap (operational, always-on)

A heatmap with dependencies on the Y axis and time on the X axis. Color represents utilization percentage:
- Green: 0–60% utilization
- Yellow: 60–80% utilization
- Orange: 80–95% utilization
- Red: 95–100% utilization (permits near exhaustion or fully exhausted)

This dashboard answers "which dependency is under pressure right now?" at a glance.

### 2. Rejection Rate Trending (operational, always-on)

Time-series chart of rejection rate per dependency over the last 24 hours. Overlays: traffic volume on the same axis. This answers "are rejections correlated with traffic spikes or with dependency degradation?"

A rejection rate that tracks traffic (rises when traffic rises) suggests the limit needs to be increased. A rejection rate that rises without a traffic increase suggests the downstream dependency is degrading and holding permits longer.

### 3. Per-Dependency p99 Latency Comparison (health review, weekly)

Time-series comparison of p99 `bulkhead.downstream_latency_ms` for each dependency. The reference for "is the Fraud Detection limit correctly sized?" is its downstream latency trend: if downstream latency is rising, permit utilization will follow, and the limit should be reviewed before utilization reaches 80%.

### 4. Permits Available by Dependency (on-call reference)

Single-number gauges showing current permits available for each dependency. Drill-down shows permits in use, permits max, and utilization over the last hour. On-call uses this dashboard during incidents to immediately determine whether the issue is bulkhead saturation or downstream error.

---

## Chaos Engineering Scenarios

Run these in the staging environment before production deployment and on a quarterly cadence thereafter:

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Saturate Fraud Detection to limit** | Inject 2,000ms latency on all Fraud Detection responses; send enough traffic to consume all 30 permits | Fraud Detection bulkhead reaches 100% utilization; new fraud check requests are rejected with bulkhead error; Payment and Inventory calls are completely unaffected | Payment and Inventory rejection rate = 0% during Fraud Detection saturation; Fraud Detection `permits_available` reaches 0; alert fires within 2 minutes |
| **Saturate all non-critical dependencies simultaneously** | Inject latency on Fraud Detection and Notification simultaneously to exhaust both bulkheads | Both non-critical bulkheads saturate; critical-path (Payment, Inventory) calls are unaffected | Payment and Inventory rejection rate = 0%; both non-critical alert simultaneously; critical-path latency unchanged |
| **Simulate Black Friday pre-bulkhead condition** | Disable bulkheads and inject Fraud Detection latency to reproduce original incident | All calls fail as shared pool exhausts | This run is for before/after comparison and documentation, not a pass/fail test |
| **Retry storm under saturation** | Saturate Fraud Detection bulkhead; configure caller to retry immediately on rejection | Retry storm amplifies Fraud Detection saturation; verify that backoff policy prevents cascading to critical path | Critical-path calls remain unaffected; retry rate does not grow exponentially; backoff causes retry volume to decay over 30 seconds |
| **Limit reconfiguration under load** | Reduce Payment limit from 80 to 40 while load test is running | Mid-flight permits are respected; new permits are rejected above 40; no crash or deadlock in bulkhead implementation | No panic or deadlock; rejection rate rises smoothly; restoring limit to 80 allows rejections to cease |
| **Circuit breaker opens during bulkhead saturation** | Allow Fraud Detection bulkhead to saturate and then inject connection errors on remaining Fraud Detection calls | Circuit breaker opens after failure threshold; all Fraud Detection traffic is stopped immediately; permits drain to 0 | Circuit breaker state = OPEN within 10 seconds of failure threshold; Fraud Detection permits drain; critical-path unaffected throughout |

---

## Alerting Philosophy

**Page on-call:**
- Any critical-path dependency (Payment, Inventory) rejection rate > 0.1% for 3 consecutive minutes — this means orders are failing
- Any bulkhead utilization > 95% for 2 consecutive minutes — imminent total saturation
- Circuit breaker OPEN state for a critical-path dependency — the dependency is genuinely down

**Notify team (no page):**
- Any dependency utilization > 80% sustained for 5 minutes — approaching limit, review may be needed
- Non-critical dependency (Fraud Detection, Notification) rejection rate > 2% — limit may need tuning
- Any dependency's downstream p99 latency increases > 50% sustained for 10 minutes — early indicator that permit utilization will rise

**Do not alert on:**
- Individual bulkhead rejections (expected behavior at high load; alert only on rate, not individual events)
- Notification service rejection rate < 5% (best-effort by design)
- Bulkhead permit acquisition taking > 1ms for a single request (alert only on sustained p99 trend)
- Circuit breaker HALF-OPEN state (expected recovery behavior; only alert if it does not transition to CLOSED)

# ADR-005: Observability and SLOs for resilience controls

## Status
Accepted

## Date
2026-03-04

## Context
Resilience4j exposes metrics via Micrometer, but without a defined set of dashboards, alert thresholds, and SLOs, the metrics are collected but not acted on. Two incidents illustrated this gap after Resilience4j was fully deployed.

The first: the Payment Gateway circuit breaker was in the OPEN state for 12 minutes during a high-traffic period, failing fast for all payment calls. The circuit had been opened by a brief Payment Gateway configuration change that caused elevated error rates. The configuration change was reverted within 2 minutes, but the circuit breaker's 30-second open duration and the half-open trial behavior meant the circuit remained open for 12 minutes total before it fully closed. During those 12 minutes, customers attempting checkout received 503 errors. Nobody on-call was alerted until a customer support escalation arrived 10 minutes after the circuit opened.

The second: the Fraud Detection retry rate was elevated for 3 hours before anyone noticed. The elevated retry rate indicated that Fraud Detection was returning intermittent errors -- not enough to open the circuit breaker, but enough to slow order processing. Investigation revealed that a Fraud Detection deployment had introduced a database query that was inefficient for a specific order type, causing elevated error rates only for those orders. The retry rate metric, if monitored, would have surfaced this pattern 3 hours earlier.

## Decision
The following Resilience4j metrics are monitored and alerted:

**Circuit breaker metrics:**
- `resilience4j.circuitbreaker.state` per instance: track state transitions (CLOSED → OPEN, HALF_OPEN → OPEN, HALF_OPEN → CLOSED)
- Alert immediately when any circuit breaker transitions to OPEN state (this is always a signal worth investigating)
- Alert if any circuit breaker remains in OPEN state for more than 2 minutes
- `resilience4j.circuitbreaker.failure.rate` per instance: track trend over 5-minute windows

**Retry metrics:**
- `resilience4j.retry.calls` tagged with `kind=failed_with_retry` per instance: rate of calls that succeeded only after retrying
- `resilience4j.retry.calls` tagged with `kind=failed_without_retry` and `kind=failed_after_retries`: rates of calls that failed despite retries
- Alert if retry success rate (`failed_with_retry` / total) exceeds 5% for any 10-minute window (indicates persistent transient errors)

**Timeout metrics:**
- `resilience4j.timelimiter.calls` tagged with `kind=timeout` per instance: timeout rate
- Alert if timeout rate exceeds 2% for any dependency over a 5-minute window

**SLOs per dependency:**
- Payment Gateway: < 0.5% error rate (post-retry), circuit breaker open time < 30 seconds per hour
- Inventory service: < 1% error rate, circuit breaker open time < 60 seconds per hour
- Fraud Detection: < 2% error rate (higher tolerance due to non-critical path), circuit breaker open time < 120 seconds per hour

Dashboards include: circuit breaker state timeline per dependency, retry rate trend, timeout rate trend, and fallback invocation rate. A single "resilience health" dashboard shows all four dependencies side by side for quick operational review during incidents.

## Alternatives Considered

**Alert only on circuit breaker open state, not on retry rate:** Only generate alerts for the most severe indicator (circuit open) and let teams check retry metrics on demand. Rejected because the Fraud Detection incident demonstrated that elevated retry rate is an early warning signal that precedes circuit opening. Waiting for the circuit to open before alerting loses the window where intervention could have prevented a more significant degradation.

**Custom Prometheus queries instead of Resilience4j metrics:** Write PromQL queries against application-level request metrics (latency histograms, error rate counters) to derive resilience-equivalent signals, without using Resilience4j's dedicated metrics. Rejected because Resilience4j's metrics include state that is not available from application-level request metrics alone (circuit breaker state, half-open call counts, retry counts per attempt).

**Shared resilience dashboard with all services combined:** One dashboard covering resilience metrics for all services using Resilience4j. Rejected because the SLO thresholds differ per service and per dependency; a shared dashboard cannot display per-service thresholds without configuration complexity that makes it harder to read during an incident. Service-specific dashboards with a shared template are maintained instead.

## Consequences

### Positive
- Circuit breaker transitions generate immediate alerts, eliminating the 10-minute detection gap from the Payment Gateway incident
- Elevated retry rate is surfaced as an early warning signal before it progresses to circuit opening, providing a 3-hour earlier detection window for the Fraud Detection query performance issue
- SLO definitions per dependency provide a quantitative basis for evaluating whether a new resilience configuration (e.g., changing the Payment Gateway timeout) is within acceptable bounds

### Negative
- Each Resilience4j instance adds its own set of metrics; for services with many dependencies, the metrics cardinality grows proportionally, adding storage overhead to the metrics platform
- Circuit breaker state transition alerts are binary (open/closed) and can fire in rapid succession during half-open trial behavior, requiring alert deduplication to prevent alert fatigue

### Risks
- **Alert fatigue from circuit breaker flapping.** If a dependency is intermittently degraded, the circuit breaker may transition between OPEN and HALF_OPEN repeatedly, generating a stream of alerts. Mitigation: alerts on circuit breaker state include a deduplication window of 5 minutes -- a circuit that opens and immediately closes (fast recovery) does not generate a separate close alert, only the open alert.

## Review Trigger
Revisit SLO thresholds after any major change to downstream service infrastructure or SLAs. Revisit the alert deduplication window if circuit breaker flapping becomes a common occurrence, which would suggest that the circuit breaker thresholds in ADR-003 need recalibration.

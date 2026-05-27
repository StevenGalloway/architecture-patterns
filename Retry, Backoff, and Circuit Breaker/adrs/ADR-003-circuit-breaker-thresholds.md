# ADR-003: Circuit breaker thresholds and windows

## Status
Accepted

## Date
2025-11-12

## Context
The circuit breaker's purpose is to stop sending requests to a dependency that is consistently failing, sparing the dependency load from futile requests while it recovers, and protecting the calling service from holding threads open waiting for responses that will not succeed.

The challenge is calibrating the circuit breaker thresholds. A threshold that is too sensitive trips on normal transient variability -- a single slow response in 10 requests should not open the circuit. A threshold that is too lenient takes too long to trip during genuine outages, continuing to send requests to a failing dependency for longer than necessary.

Two incidents informed the threshold decisions:

During a Fraud Detection deployment, the service returned errors for approximately 45 seconds while the new version was starting up. With an initial threshold of 20% failure rate over a 10-call sliding window, the circuit breaker opened after 2 failures out of 10 calls -- much too quickly. The circuit remained open for 60 seconds, then entered half-open state. During the 45-second deployment window, the Fraud Detection service was actually recovering and would have successfully served requests that were being rejected by the open circuit. Approximately 800 order requests received a "fraud check unavailable" error unnecessarily.

A second incident with the Inventory service was the opposite: the threshold was set to 50% failure rate but the sliding window was only 5 calls. During a high-traffic period with 200 calls per second, 5 calls represented only 25ms of traffic -- far too short a window to distinguish a genuine outage from a transient spike.

## Decision
Circuit breaker configuration per dependency uses a count-based sliding window with these parameters:

**Payment Gateway (critical path, expensive to fail):**
- Sliding window size: 20 calls
- Failure rate threshold to open: 60% (12 of 20 calls)
- Slow call rate threshold: 50% of calls exceeding the timeout are counted as failures
- Slow call duration threshold: 2,000ms
- Wait duration in open state: 30 seconds
- Number of permitted calls in half-open state: 3

**Inventory service (critical path, fast SLA):**
- Sliding window size: 15 calls
- Failure rate threshold: 50%
- Slow call threshold: 800ms
- Wait duration open: 20 seconds
- Half-open permitted calls: 3

**Fraud Detection (non-critical, higher tolerance):**
- Sliding window size: 20 calls
- Failure rate threshold: 70% (higher tolerance because transient errors are more common)
- Slow call threshold: 500ms
- Wait duration open: 45 seconds (longer open state to allow full recovery)
- Half-open permitted calls: 5

**Minimum number of calls:** 10 calls must be evaluated before the failure rate threshold is applied. This prevents the circuit from opening on the first few calls after a deployment when sample size is insufficient.

## Alternatives Considered

**Time-based sliding window instead of count-based:** Evaluate failure rate over a rolling time window (e.g., last 60 seconds) rather than the last N calls. Better suited to high-traffic services where N calls can occur in less than a second. Rejected for the current traffic levels because at 200 calls/second, a time window of 60 seconds would capture 12,000 calls, which is a larger sample than necessary and adds memory overhead. At higher traffic, time-based windows would be reconsidered.

**Single configuration for all dependencies:** Use the same circuit breaker thresholds for all four dependencies. Simpler to maintain. Rejected because the Payment Gateway incident and Fraud Detection incident demonstrated that different dependencies require different sensitivity levels. A single conservative threshold protects less critical dependencies (Fraud Detection) more aggressively than needed while not being conservative enough for critical ones (Payment Gateway).

**Adaptive thresholds based on historical failure rates:** Set the failure threshold relative to the dependency's normal baseline (e.g., "open if failure rate is 3x the 7-day average"). More accurate than fixed thresholds during periods of gradual degradation. Rejected for initial implementation because it requires historical metric data to initialize and adds algorithmic complexity to the configuration model. Fixed thresholds informed by observed baseline metrics are sufficient for current needs.

## Consequences

### Positive
- The minimum-calls gate prevents false positives from the first few calls after a deployment or circuit reset
- Slow call thresholds ensure that a dependency that is responding but responding very slowly is treated as degraded, preventing thread exhaustion from slow-but-not-failing calls
- Per-dependency thresholds match the criticality and expected behavior of each dependency

### Negative
- Per-dependency configuration is verbose and requires domain knowledge (understanding the Fraud Detection API's normal error rate) to configure correctly
- The half-open state permits a fixed number of trial calls before deciding to close or reopen the circuit; a small number (3) may produce insufficient signal if the dependency's recovery is probabilistic

### Risks
- **Cascading circuit breaker opens during shared infrastructure failure.** If multiple dependencies share an infrastructure component (e.g., the same Redis cluster) that fails, all circuits may open simultaneously. This is correct behavior (failing fast for all affected dependencies) but may be alarming if the on-call engineer sees multiple circuit breaker open alerts and cannot immediately identify the shared root cause. Mitigation: circuit breaker open events are annotated with the triggering dependency name; the runbook includes guidance on identifying shared infrastructure failures.

## Review Trigger
Revisit thresholds after any change to dependency traffic patterns or SLAs. Revisit the count-based vs. time-based window choice if traffic volume increases by more than 5x, at which point a count-based window of 20 would represent less than 100ms of traffic.

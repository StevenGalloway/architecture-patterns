# ADR-004: Enforce timeouts and cancellation for bulkhead-protected calls

## Status
Accepted

## Date
2025-10-22

## Context
After bulkheads were deployed, we observed an unexpected behavior during a Fraud Detection service brownout: the semaphore permit usage stayed at the maximum (30) for an extended period even after the Fraud Detection service began recovering. Investigation showed that 28 of the 30 permits were held by calls that had already exceeded any reasonable response time -- some had been in-flight for over 45 seconds -- but had not been cancelled because there was no timeout enforcing a permit release.

The permits were effectively leaked in the sense that the calls were never going to return useful results (any upstream that takes 45 seconds on a call with a 400ms SLA is not recoverable), but the semaphore had no knowledge of elapsed time. The permits remained acquired until the downstream connection was eventually closed by the remote end or the process restarted.

This meant that bulkhead recovery was not driven by the downstream recovering -- it was driven by TCP connection timeouts, which operate on a much longer timescale than application-level recovery. The bulkhead was providing isolation from resource exhaustion but not from permit lock-up during slow calls.

## Decision
All bulkhead-protected calls enforce a **per-call timeout** that is shorter than the semaphore permit hold time would become under degraded conditions:

- Payment service: 1,500ms
- Inventory service: 800ms
- Fraud Detection: 500ms
- Notification service: 2,000ms (async, best-effort)

Timeout values are configured alongside semaphore limits in the same configuration block to make their relationship explicit.

On timeout, the in-flight request is cancelled (the underlying HTTP request is aborted) and the semaphore permit is released in a `finally` block. The cancellation is propagated to the underlying connection so that the permit release and connection release happen together.

If the downstream call supports request cancellation (gRPC supports this natively; REST APIs generally do not), the cancellation signal is sent. For REST APIs that do not acknowledge cancellations, the connection is closed from the client side.

## Alternatives Considered

**Global timeout at the HTTP client level instead of per-bulkhead timeout:** Set a single socket timeout on the HTTP client that applies to all outbound calls. Rejected because different dependencies have very different acceptable latency budgets. A 500ms timeout appropriate for Fraud Detection would cause unnecessary failures for Notification service calls that are expected to take up to 1,500ms.

**Timeout at the caller level (each service sets its own timeout):** Each service that calls the Order Processing service sets its own total request timeout, which propagates through. Rejected because this gives callers indirect control over how long bulkhead permits are held. The bulkhead should enforce its own timeout on held permits regardless of caller behavior.

**Deadline propagation from the inbound request:** Use the inbound request's remaining deadline as the timeout for downstream calls. Include as a complement, not a replacement: propagating inbound deadlines is good practice for preventing work on behalf of already-abandoned requests, but it does not replace the bulkhead-level timeout because inbound requests can have long or unspecified deadlines.

## Consequences

### Positive
- Semaphore permits are released on a predictable schedule tied to application-level timeouts rather than TCP-level timeouts
- Bulkhead recovery after downstream degradation is faster: permits are freed within `timeout_ms` of the call starting, not within minutes of TCP connection teardown
- The relationship between timeout budget and concurrency limit is explicit in configuration, making it easier to reason about worst-case permit hold time (`permits × timeout_ms` = maximum permit-seconds consumed)

### Negative
- Aggressive timeouts may cause false failures for legitimate calls that are slow but would eventually succeed; timeout values must be calibrated against the actual downstream p99 latency
- Cancellation signals are not reliably acted on by REST APIs; the connection is closed client-side, but the server may continue processing the abandoned request, wasting server-side resources

### Risks
- **Timeout value drift.** If timeout values are not updated when downstream SLAs change, timeouts may be too aggressive (causing unnecessary failures) or too lenient (holding permits too long). Mitigation: timeout values are reviewed as part of the quarterly SLO review process.

## Review Trigger
Revisit timeout values after any downstream dependency changes its service-level objective. Revisit the cancellation approach if any downstream service adopts gRPC, which supports reliable cancellation propagation.

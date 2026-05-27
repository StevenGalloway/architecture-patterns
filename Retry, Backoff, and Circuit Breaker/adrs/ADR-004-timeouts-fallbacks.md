# ADR-004: Timeouts and fallbacks are mandatory for remote calls

## Status
Accepted

## Date
2026-01-14

## Context
Before timeouts were standardized, the Order Processing service used the default HTTP client timeout, which is effectively infinite on many client libraries. During a Fraud Detection brownout (responses taking 12-14 seconds instead of the normal 80ms), order processing threads were held open waiting for responses. The Spring Boot default thread pool has 200 threads. At peak traffic, the 14-second Fraud Detection response time caused threads to accumulate until the pool was exhausted, at which point new requests queued. The queue filled, and the service stopped accepting new requests entirely. The Fraud Detection brownout caused a complete Order Processing outage.

The root cause was a missing timeout: without a hard limit on how long a thread would wait for Fraud Detection, a degraded dependency could consume all processing capacity. The fix -- adding a 1,000ms timeout to the Fraud Detection call -- was a one-line configuration change that would have prevented the entire incident.

Fallbacks were raised as a separate concern after the timeout was added: with a hard 1,000ms timeout on Fraud Detection, a legitimate degradation of that service (consistently slow but not fully unavailable) would now result in a 503 for every order rather than a successful order with fraud check unavailable. The product team determined that orders from established customers (account age > 90 days, no prior fraud signals) could be processed with a degraded fallback (treat as low-risk) when Fraud Detection was unavailable. New accounts would be held for manual review.

## Decision
Timeouts are mandatory for all remote calls. No call to an external dependency is made without a configured timeout in the Resilience4j `TimeLimiter`:

- Payment Gateway: 3,000ms (charged operations need more time budget; credit card processors can be slow)
- Inventory service: 600ms
- Fraud Detection: 1,000ms
- Notification service: 2,000ms (async notification, longer budget acceptable)

When a timeout fires, the underlying HTTP request is cancelled and the thread is freed. The Resilience4j time limiter wraps the call in a `CompletableFuture` with a deadline; the future is cancelled on timeout.

Fallbacks are defined per endpoint, not per dependency, because the business acceptability of degradation varies by operation:

- Order creation with Fraud Detection timeout for established accounts: proceed with low-risk treatment, flag for async review
- Order creation with Fraud Detection timeout for new accounts: return 503, ask user to retry
- Order creation with Inventory timeout: return 503 (cannot proceed without inventory confirmation)
- Order creation with Payment timeout: return 503 (cannot proceed without payment)
- Notification send with Notification service timeout: log for async retry, do not fail the order

## Alternatives Considered

**Socket timeout at the HTTP client level instead of Resilience4j time limiter:** Configure `connectTimeout` and `readTimeout` on the HTTP client used by each downstream call. Simpler, and avoids the need for Resilience4j's `CompletableFuture` overhead. Rejected as the sole mechanism because socket-level timeouts do not integrate with Resilience4j's circuit breaker and metrics. The Resilience4j time limiter fires a `TimeoutException` that counts toward the circuit breaker's slow call rate; a socket timeout that bypasses Resilience4j would not.

**Per-request deadline propagation:** Each incoming request has a deadline (the time budget remaining from the SLA for the entire request). Downstream calls inherit the remaining deadline rather than using a fixed timeout. More accurate for multi-step operations (if two downstream calls are made sequentially, the second gets the remaining budget after the first). Adopted as a future enhancement but not implemented in the initial version because it requires passing the deadline through the call stack, which requires changes to all service code that makes downstream calls.

**No fallback for any dependency (all failures are surfaced):** When Fraud Detection times out, always return 503. Simple and honest about service degradation. Rejected because the product team's analysis showed that approximately 70% of orders are from established accounts where Fraud Detection unavailability represents a very low actual risk, and refusing those orders during every Fraud Detection outage produces significant revenue impact for a risk that is acceptable during short outages.

## Consequences

### Positive
- Thread exhaustion from slow dependencies is prevented; a dependency can be slow for any duration without holding more than the configured maximum concurrent connections
- The fallback model for established accounts allows the business to continue processing low-risk orders during Fraud Detection degradation, reducing revenue impact from outages
- Timeout values are centralized in configuration (not scattered across HTTP client configurations in different service integrations)

### Negative
- The fallback for established accounts requires the Order Processing service to understand customer account age -- a piece of domain knowledge that arguably belongs in the Fraud Detection or Customer domain. The fallback is pragmatic but adds a dependency on account data to the order creation flow.
- Timeout calibration requires knowledge of each dependency's actual p99 response time; an overly aggressive timeout causes false failures for legitimate slow responses.

### Risks
- **Timeout value too conservative for dependency performance.** If the Payment Gateway p99 response time is normally 2,500ms and the timeout is set to 3,000ms, there is only 500ms of headroom. A normal traffic spike can cause the timeout to fire for legitimate requests. Mitigation: timeout values are set at 3x the observed p99 under normal conditions, not at 2x or at the SLA boundary.

## Review Trigger
Revisit timeout values after any downstream dependency infrastructure change (e.g., the Payment Gateway migrating to a new processing platform with different latency characteristics). Revisit the Fraud Detection fallback if the risk model changes or if regulatory requirements change what constitutes acceptable fraud check bypass conditions.

# ADR-002: Retry policy and backoff strategy

## Status
Accepted

## Date
2025-09-17

## Context
After Resilience4j was adopted, we needed to define the retry policy parameters for each dependency. The initial configuration used the same defaults for all four dependencies, but this proved inappropriate. The Payment Gateway has strict idempotency requirements (retrying a payment charge without an idempotency key can result in a double charge). The Inventory service returns 400 for out-of-stock requests, which are not transient and should not be retried. The Fraud Detection API returns 429 with a `Retry-After` header during rate limit windows.

An early misconfiguration retried 400 responses from the Inventory service. The consumer code interpreted any retry failure as a transient error, so when the Inventory service correctly returned a 400 "out of stock" response, the retry mechanism retried the request twice more (all of which also returned 400) before propagating the error. This tripled the load on the Inventory service for every out-of-stock check during a high-traffic period.

A separate misconfiguration retried Payment Gateway calls without an idempotency key. The intent was to handle network timeouts where the payment may or may not have been processed. Without an idempotency key, a retry for a timed-out payment that had actually succeeded resulted in a double charge to the customer.

## Decision
Retry configuration is per-dependency and explicitly categorizes which conditions are retry-eligible:

**Retry-eligible conditions:**
- `ConnectException`, `SocketTimeoutException`, `ReadTimeoutException`: network-layer failures that indicate no response was received; safe to retry
- HTTP 429 with `Retry-After` header: rate limit exceeded; retry after the specified delay (max 30 seconds)
- HTTP 500, 502, 503, 504: server-side transient errors; retry with backoff
- HTTP 408: request timeout acknowledged by server; safe to retry

**Not retry-eligible:**
- HTTP 400, 422: client error; the request is malformed or invalid. Retrying will produce the same error
- HTTP 401, 403, 404: authentication/authorization failure or resource not found; retrying will not change the outcome
- HTTP 409: conflict; the conflict must be resolved by the caller, not retried

**Retry parameters:**
- Maximum attempts: 3 (1 initial + 2 retries)
- Backoff: exponential, initial interval 200ms, multiplier 2, maximum interval 2,000ms
- Jitter: ±25% of each interval to prevent synchronized retry storms
- For Payment Gateway specifically: idempotency key (derived from the order ID + attempt number) is always included in retry requests

## Alternatives Considered

**Uniform retry policy across all dependencies:** Same max attempts, same backoff, applied to all 5xx responses regardless of dependency. Simpler to configure but rejected because the Inventory service 400 incident demonstrated that uniform policies produce inappropriate behavior when dependencies have different semantics for error codes.

**Client library-level retry (e.g., Apache HttpClient retry handler):** Configure retry behavior in the HTTP client rather than in Resilience4j. Rejected because HTTP client retry behavior operates below the Resilience4j circuit breaker. A retry at the HTTP client level is transparent to the circuit breaker, which does not count the retried attempts as failures. Retry behavior must sit above the circuit breaker to ensure retried failures count toward the circuit breaker's failure threshold.

**Exponential backoff without jitter:** Pure exponential backoff (200ms, 400ms, 800ms) without jitter. Rejected because pure exponential backoff still allows synchronized retries if multiple requests fail at the same time (e.g., all requests during a dependency restart fail simultaneously). Jitter distributes the retry timing and prevents the thundering herd effect that occurred with the Fraud Detection retry storm.

## Consequences

### Positive
- The explicit list of retry-eligible conditions prevents retries of business errors (out-of-stock, invalid request) that would only amplify load on the dependency without a chance of success
- Idempotency keys on Payment Gateway retries prevent double charges for timed-out payment requests
- Jitter-based backoff prevents retry storms during dependency outages

### Negative
- Per-dependency retry configuration is more verbose than a shared default; each new dependency requires a review of which error conditions are retry-eligible
- The distinction between "transient server error" (retry-eligible 500) and "permanent server error" (not retry-eligible 500) requires understanding the dependency's error semantics and is not always clearly documented by the upstream service

### Risks
- **Incorrect exception mapping.** A new client library update changes the exception types thrown for certain error conditions, and the Resilience4j retry configuration's exception mapping is not updated. Previously non-retried errors become retried, or previously retried errors stop being retried. Mitigation: exception mapping is tested with mock scenarios in integration tests for each dependency.

## Review Trigger
Revisit retry parameters after any change to downstream dependency SLAs. Revisit idempotency key handling if the Payment Gateway changes its idempotency key semantics or expiry window.

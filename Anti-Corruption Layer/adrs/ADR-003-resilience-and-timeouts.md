# ADR-003: Apply strict timeouts and circuit breaker in the ACL

## Status
Accepted

## Date
2025-08-06

## Context
After the ACL was in place for six weeks, we had a production incident where the vendor CRM API degraded under load during a promotional event. The vendor's response times climbed from the normal 120ms to over 8 seconds. Because the ACL had no timeout enforcement, internal service threads were held open waiting for vendor responses. Within four minutes, the Orders service connection pool was saturated. Orders could not be placed, but the failure presented to users as a generic timeout rather than a service unavailability message.

The vendor's SLA was 99.5% monthly uptime. Our SLA to users was 99.9%. There was no isolation between the vendor's availability and ours. The ACL was transparently passing vendor latency into our call stack instead of acting as a protective boundary.

A second, smaller incident three weeks later involved vendor rate limiting. The vendor returned 429s for bursts of more than 50 requests per second without `Retry-After` headers. Our retry logic at the time was a naive immediate retry loop, which compounded the problem by generating more requests during the throttle window.

## Decision
The ACL enforces the following resilience policies on all outbound vendor calls:

**Timeout:** Hard 2,000ms per call timeout. If the vendor does not respond within 2 seconds, the ACL returns an error to the caller. The ACL does not wait for the vendor response.

**Retries:** Up to 2 retries for idempotent read operations only (GET-equivalent calls). Retry backoff is exponential starting at 200ms with ±50ms jitter. Mutating operations (create, update, delete) are not retried automatically; the caller decides whether to retry after receiving an error.

**Circuit breaker:** Half-open circuit trips after 5 consecutive failures within a 30-second window. The circuit remains open for 60 seconds before transitioning to half-open. In open state, calls fail immediately with a circuit-open error code rather than attempting vendor contact.

**Response caching:** For read operations on stable reference data (e.g., account metadata that changes infrequently), a 30-second TTL cache is applied within the ACL. Cache entries are invalidated explicitly on successful mutating operations.

## Alternatives Considered

**Rely on service mesh sidecar (Envoy/Istio) for timeout and retry policies:** The service mesh handles all outbound connection management at the network level. Rejected for this integration because the ACL needs operation-aware retry logic (retries only for idempotent reads, not mutations). Network-layer retries cannot distinguish read vs. write semantics without application-layer context.

**Let each consumer service configure its own timeout for ACL calls:** Services set whatever timeout they need, and the ACL passes through. Rejected because this puts per-vendor knowledge (what timeout is reasonable for this vendor) into every consumer. The ACL is the single place that understands vendor behavior.

**Accept vendor latency degradation and surface it as reduced SLA:** Document that vendor-dependent features have a separate 99.5% availability target. Rejected because the incident showed that vendor latency propagation is not visible to users as a degraded feature -- it presents as a full service outage due to thread pool exhaustion.

## Consequences

### Positive
- Vendor latency spikes are isolated to ACL callers; downstream services receive a fast error rather than a slow one, freeing threads for other requests
- Circuit breaker prevents thundering-herd retry storms during sustained vendor outages
- Cache reduces vendor call volume by approximately 40% for reference data lookups based on observed traffic patterns

### Negative
- Cached responses can be stale by up to 30 seconds; features relying on real-time account status (e.g., account suspension checks) cannot use the cache and must accept the vendor latency budget
- The 2,000ms hard timeout may cause failures for legitimate requests during vendor-side slowdowns that are within the vendor's stated SLA

### Risks
- **Circuit breaker miscalibration.** A threshold that is too sensitive (e.g., tripping on 2 consecutive errors) will open the circuit on transient vendor hiccups, causing unnecessary failures. Mitigation: tune thresholds based on two weeks of observed vendor error rate data before enabling in production.

## Review Trigger
Revisit timeout and retry values after the next major vendor API release or if the vendor publishes new rate limit documentation with different burst allowances. Revisit the cache TTL if account metadata changes become more frequent (e.g., vendor introduces real-time account updates).

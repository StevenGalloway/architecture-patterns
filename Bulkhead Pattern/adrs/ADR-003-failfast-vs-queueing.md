# ADR-003: Prefer fail-fast over unbounded queueing

## Status
Accepted

## Date
2025-08-27

## Context
When a bulkhead semaphore is exhausted, there are two fundamentally different responses available: reject the incoming request immediately, or queue it and wait for a permit to become available. The queueing approach is appealing because it reduces the number of explicit failures visible to callers -- requests wait rather than fail, and when a permit frees up, the queued request proceeds.

We tested the queueing approach in a load test simulating a slow Fraud Detection service. With a queue depth of 50 and a drain rate constrained by the slow downstream, queued requests waited an average of 3.2 seconds before being processed. The total elapsed time from a client's perspective was: client timeout budget consumed, response arrived after client already gave up, abandoned request still consumed a slot in the queue and a downstream call was eventually made for a request whose result was no longer needed.

The queue did not reduce failures. It transformed fast failures into slow failures while simultaneously consuming system resources for abandoned work. At sustained load, the queue was always full and requests were rejected anyway -- but after a 3+ second delay instead of immediately.

## Decision
When a bulkhead semaphore is exhausted, reject incoming requests **immediately** rather than queuing them. The rejection response is:
- HTTP 503 with a `Retry-After: 1` header for synchronous callers
- Structured error with error code `BULKHEAD_FULL` for internal service-to-service calls
- For endpoints that have a defined degraded response (e.g., recommendations), return the fallback response (empty list) with a `X-Partial-Response: true` header rather than a 503

Callers are responsible for their own retry strategy. The `Retry-After` header provides a signal for when to retry, but the bulkhead does not guarantee capacity will be available at that time.

Non-critical endpoints (Notification, Fraud Detection for low-risk orders) always have a defined fallback behavior. Critical-path endpoints (Payment, Inventory) return 503 and rely on the caller to retry or present an error to the user.

## Alternatives Considered

**Bounded queue with configurable depth:** Accept up to N queued requests per dependency before starting to reject. Tested and rejected: see the load test results in Context. A bounded queue provides a brief buffer for traffic bursts but does not help during sustained saturation, which is the primary failure mode.

**Priority queue: dequeue critical requests ahead of non-critical:** Maintain a queue with priority ordering so that high-priority requests (paying customer checkout) are served before low-priority requests (background sync jobs). Rejected because priority assignment adds complexity and the problem it solves (low-priority traffic starving high-priority traffic) is better solved by giving critical dependencies larger semaphore allocations rather than sharing a pool with a priority queue on top.

**Timeout the wait instead of failing immediately:** Queue requests but evict them after a configurable wait timeout (e.g., 500ms). If the permit becomes available within the timeout, proceed; otherwise reject. Rejected because the timeout adds latency to the failure path without meaningfully increasing success probability. When a dependency is saturated, permits are released slowly; a 500ms wait window rarely allows a queued request to proceed.

## Consequences

### Positive
- Failure latency is minimized: a rejected request receives an error in microseconds rather than waiting seconds for a permit that may never arrive
- System resources (memory, connections) are not consumed by queued requests that will ultimately fail or be abandoned
- Fail-fast behavior makes bulkhead exhaustion immediately visible in error rate metrics rather than manifesting as latency degradation

### Negative
- Callers that do not implement retry logic receive hard errors during dependency saturation periods, which may surface directly to end users
- Short traffic bursts (50-100ms spike) that would fit within a queue window now cause rejections that could have been absorbed

### Risks
- **Retry storms on rejection.** If callers retry immediately on receiving a 503, the retry traffic competes with existing in-flight requests for the same limited permits, potentially extending the saturation period. Mitigation: the `Retry-After` header signals a 1-second wait before retrying; callers are documented to respect this header.

## Review Trigger
Revisit if a specific endpoint has a user-visible impact from fail-fast behavior that a short queue window (under 200ms) would meaningfully mitigate. Evaluate the specific endpoint's traffic pattern before adding any queue depth.

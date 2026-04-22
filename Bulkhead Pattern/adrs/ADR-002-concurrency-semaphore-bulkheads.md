# ADR-002: Implement bulkheads as per-dependency semaphores

## Status
Accepted

## Date
2025-07-02

## Context
Having decided to adopt bulkhead isolation (ADR-001), we needed to choose the specific mechanism. The service runs on Node.js with an async event loop. It handles up to 3,000 requests per second at peak, with each request potentially triggering 2-4 downstream calls. The isolation mechanism needed to be low-overhead in the common case (permit available, call proceeds), add near-zero latency to non-saturated paths, and be accurate enough that the concurrency limit is not off by more than one or two permits under high contention.

We also needed the mechanism to work correctly in the single-process event loop model. Thread pool isolation is not applicable because Node.js does not dedicate OS threads to individual requests. The isolation must be at the application level, limiting the number of in-flight async operations per dependency regardless of the underlying thread model.

## Decision
Implement bulkheads as **per-dependency counting semaphores** with a max-permits value per dependency. Each semaphore tracks the number of currently in-flight requests to its corresponding dependency.

When a call is made:
1. The caller attempts to acquire a permit from the dependency's semaphore
2. If a permit is available, it is acquired and the call proceeds
3. If no permit is available, the call is rejected immediately (fail-fast, see ADR-003)
4. On call completion (success or error), the permit is released in a `finally` block

Each dependency has its own semaphore instance with a separate limit. The semaphores do not share a pool; exhausting the Fraud Detection semaphore has no effect on Inventory semaphore capacity.

Semaphore limits are configured in the service configuration file, not hardcoded, so they can be adjusted without a code deployment. Configuration changes trigger a semaphore rebuild at the application level.

## Alternatives Considered

**Thread pool isolation (Hystrix/Resilience4J bulkhead model):** Assign a dedicated thread pool to each dependency. Requests for a given dependency execute on its dedicated pool and cannot consume threads from other pools. Rejected for Node.js because the event loop model does not map to thread pools. Dedicated thread pools in Node require worker threads, which add cross-thread communication overhead and are not the natural unit of I/O isolation in an event loop runtime.

**Rate limiting instead of concurrency limiting:** Limit the number of requests per second to each dependency (requests/sec) rather than concurrent in-flight requests. Rejected because the failure mode we are protecting against is latency-induced concurrency buildup, not request volume. A slow downstream that takes 2 seconds per call can saturate a concurrency limit of 30 while processing only 15 requests/second -- well within any reasonable rate limit.

**Connection pool per dependency:** Use separate HTTP connection pools with per-pool limits instead of application-level semaphores. Partially applicable but insufficient alone: connection pools limit raw connections, but async operations can queue behind a full connection pool, unbounded, which recreates the resource exhaustion problem at the queue level. Semaphore-based limits provide the application-level back-pressure that prevents unbounded queueing.

## Consequences

### Positive
- Semaphore acquisition and release are O(1) operations with negligible latency impact on the non-saturated path
- The mechanism works correctly in the async event loop model without requiring worker threads or external state
- Each semaphore's current permit usage is directly inspectable, making bulkhead saturation an observable quantity

### Negative
- Per-dependency semaphores require per-dependency limit configuration; a new dependency added without a defined limit defaults to an unconfigured (unlimited) state unless the framework enforces explicit configuration
- Semaphore-based limits are per-process; in a horizontally scaled deployment with 10 instances, the aggregate concurrency limit is 10x the per-instance limit, which may be higher than the downstream dependency's actual capacity

### Risks
- **Permit leak on exception.** If a downstream call throws an unhandled exception that bypasses the `finally` block, the permit is never released. Over time, leaked permits reduce effective capacity. Mitigation: the semaphore implementation wraps all calls in a try/finally pattern enforced by a wrapper function; raw semaphore acquire/release is not exposed to caller code.

## Review Trigger
Revisit if the service migrates away from Node.js or adopts a hybrid worker thread model where OS-level thread pool isolation becomes a more natural fit than application-level semaphores.

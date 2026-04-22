# ADR-001: Adopt Bulkhead pattern for dependency isolation

## Status
Accepted

## Date
2025-04-23

## Context
The Order Processing service calls four downstream dependencies: the Inventory service, the Payment service, the Notification service, and the Fraud Detection service. Each call uses connections from a shared HTTP client connection pool with a global limit of 200 concurrent connections.

During a Black Friday load test, the Fraud Detection service began responding slowly -- p99 latency increased from 80ms to 1,400ms due to a database bottleneck on its end. Because all outbound calls shared the same connection pool, the slow Fraud Detection connections accumulated and within 90 seconds had consumed 160 of the 200 available connections. The remaining 40 connections were insufficient to serve the normal volume of Inventory and Payment calls. Orders that had no fraud risk at all began failing because no connections were available to reach the Inventory service.

The cascading failure was total: 100% of order creation attempts failed, including orders from established customers with no fraud signals that never needed fraud detection in the first place. The downstream failure had no logical relationship to most of the traffic it was blocking, but the shared resource created a physical coupling.

## Decision
Adopt the **Bulkhead** pattern across all downstream dependencies: isolate capacity allocations per dependency group so that saturation of one compartment cannot consume resources allocated to other dependencies.

Each downstream dependency receives a dedicated resource allocation -- in our case, a dedicated semaphore limiting concurrent in-flight requests. The limits are sized based on each dependency's observed call volume and acceptable concurrency, not as an equal split of a shared pool.

The initial bulkhead allocations are:
- Payment service: 80 concurrent requests (critical path)
- Inventory service: 60 concurrent requests (critical path)
- Fraud Detection: 30 concurrent requests (non-critical, async where possible)
- Notification service: 20 concurrent requests (non-critical, best-effort)

## Alternatives Considered

**Increase the shared connection pool size:** Make the global pool large enough that even a fully saturated slow dependency leaves sufficient connections for others. Rejected because this treats the symptom, not the cause. A large enough pool still has an upper limit that can be exhausted. The real problem is that a non-critical dependency (Fraud Detection) can consume resources needed by critical-path dependencies (Inventory, Payment).

**Circuit breaker only, no bulkhead:** A circuit breaker trips after failure threshold and stops sending requests to the failing dependency. Rejected as insufficient because circuit breakers act after failures have accumulated. During the period before the circuit trips, the slow dependency continues to hold connections. A bulkhead limits the number of connections a slow dependency can hold at any given time, operating in parallel with the circuit breaker.

**Thread-per-dependency isolation with dedicated thread pools:** Assign a dedicated thread pool to each dependency so that threads waiting on a slow downstream cannot affect threads serving other dependencies. Rejected because in an async/non-blocking runtime (our service uses async I/O), thread-per-dependency pools waste threads during the wait period. Semaphore-based concurrency limits achieve the same isolation with significantly less resource overhead.

## Consequences

### Positive
- A slow or unresponsive dependency is isolated: it can consume at most its allocated semaphore permits, leaving other dependencies' allocations unaffected
- Critical-path dependencies (Payment, Inventory) receive guaranteed capacity even during non-critical dependency degradation
- Bulkhead reject events are observable and attributable to specific dependencies, making triage faster during incidents

### Negative
- Each dependency requires an independently tuned limit; initial limits are estimates that will be wrong until calibrated against production traffic
- Adding a new downstream dependency requires a conscious decision about its concurrency budget, adding a step to the onboarding process

### Risks
- **Stale limit values as traffic patterns change.** Limits set based on current load become incorrect as traffic grows or dependency usage patterns shift. Mitigation: see ADR-005 for the observability and tuning process.

## Review Trigger
Revisit if the service migrates to a different I/O model (e.g., thread-per-request) where thread pool isolation becomes more natural than semaphore-based limits. Also revisit if any dependency is promoted from non-critical to critical path, which would require reassessing its semaphore allocation relative to other critical dependencies.

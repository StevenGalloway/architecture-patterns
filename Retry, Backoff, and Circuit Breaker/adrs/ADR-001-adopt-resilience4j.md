# ADR-001: Use Resilience4j for retries and circuit breakers

## Status
Accepted

## Date
2025-07-09

## Context
The Order Processing service calls four downstream dependencies: the Payment Gateway, the Inventory service, the Fraud Detection API, and the Notification service. Each of these dependencies can experience transient failures -- network timeouts, brief overloads, upstream deployments -- and the Order Processing service must handle those failures gracefully without cascading them to customers.

Before any standardized resilience approach was in place, each integration had its own ad-hoc failure handling. The Payment Gateway integration had a hand-rolled retry loop with a fixed 1-second delay between attempts. The Inventory integration had no retry logic and surfaced every transient failure as an order failure. The Fraud Detection integration had an overly aggressive retry (10 retries with no backoff) that turned a 30-second Fraud Detection outage into a sustained load spike because all concurrent requests were retrying simultaneously.

The Fraud Detection retry storm caused the only production incident that could be directly attributed to retry behavior: during a planned maintenance window on the Fraud Detection API, the Order Processing service's retry storm kept the connection pool saturated for 4 minutes after the maintenance window ended, delaying legitimate order processing. The issue was that 10 concurrent retries with no backoff meant the retry load was effectively 10x the normal request rate.

We needed consistent retry and circuit breaker behavior across all four dependencies, configurable per-dependency, with shared metrics and a single library to maintain.

## Decision
Adopt **Resilience4j** as the standard resilience library for all downstream calls from the Order Processing service and all subsequent Spring Boot services that require retry and circuit breaker behavior.

Resilience4j is used for:
- **Retry:** Exponential backoff with jitter, configurable max attempts and retry-eligible exception types
- **Circuit Breaker:** Count-based sliding window, configurable failure rate threshold and half-open trial calls
- **Time Limiter:** Hard timeouts per downstream call, configurable per dependency

The Resilience4j Spring Boot autoconfiguration is used to wire instances from `application.yml`, providing consistent configuration management and automatic exposure of metrics via the Actuator metrics endpoint.

## Alternatives Considered

**Netflix Hystrix:** The industry-standard library before it entered maintenance mode in 2018. Rejected because Hystrix is no longer maintained and does not receive security patches. Resilience4j is the recognized successor and was designed as a Hystrix replacement with a reactive-compatible architecture.

**Polly (C#) or other language-specific libraries:** Not applicable to this Java/Spring Boot service. Noted because the team was considering a partial polyglot migration; the decision to standardize on Resilience4j was made in the context of committing to JVM-based services for this service category.

**Custom implementation:** Build a retry and circuit breaker implementation tailored to the team's specific needs. Rejected because the implementation would need to handle all the edge cases Resilience4j already handles (metric recording, thread safety, decorator composability), and maintaining it would divert engineering time from product features.

**Service mesh resilience policies (Istio retry and circuit breaker):** Use Istio's VirtualService retry and traffic policy for dependency resilience instead of application-level Resilience4j. Rejected as a complete replacement because Istio resilience policies operate at the network level and cannot implement application-aware retry logic (e.g., retry only if the response body is a 503, not if it is a 400 with a business error code). Istio policies are a complement, not a replacement, for application-level resilience.

## Consequences

### Positive
- Retry and circuit breaker behavior is standardized across all four dependencies; a new dependency uses the same configuration structure as existing ones
- Resilience4j's Micrometer integration exposes per-dependency circuit breaker state, retry count, and call duration metrics automatically via the existing Actuator endpoint
- Retry logic is tested against the actual exception types thrown by each client library, not assumed from documentation

### Negative
- Resilience4j requires explicit configuration per named instance (one per dependency); services with many dependencies have verbose configuration files
- The Resilience4j circuit breaker and retry decorators must be applied to the correct method calls; a missed decoration means that dependency receives no resilience treatment without any compile-time or startup-time warning

### Risks
- **Missed decoration.** A developer adds a new downstream call without applying the Resilience4j decorator. The new call has no retry, circuit breaker, or timeout. Mitigation: the code review checklist for any new downstream integration includes verification that the Resilience4j decorator is applied.

## Review Trigger
Revisit if the team migrates to a reactive or async framework (Project Reactor, Kotlin coroutines) where Resilience4j's blocking decorator model may not be the best fit. Also revisit if the team adopts a service mesh with sufficient application-layer resilience policy support to replace application-level circuit breakers.

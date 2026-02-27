# Retry + Backoff + Circuit Breaker Pattern (Resilience Patterns)

## Summary
Modern enterprise systems fail in **predictable** ways: timeouts, transient 5xx errors, DNS issues, partial outages, and slowdowns. The **Retry**, **Backoff**, and **Circuit Breaker** patterns work together to improve reliability while preventing self-inflicted outages.

- **Retry**: reattempt a failed request when the failure is likely transient.
- **Backoff**: wait between retries (often exponential + jitter) to avoid thundering herds.
- **Circuit Breaker**: stop calling an unhealthy dependency for a period, allowing it to recover and protecting your system.

---

## Problem
A caller service depends on a downstream service that becomes slow or returns errors intermittently. Naïve implementations can:
- retry too aggressively → amplify load on an already failing service
- keep calling during outages → thread pool exhaustion and cascading failures
- time out without fallbacks → poor user experience and repeated incidents

---

## Constraints & Forces
- Some failures are transient (network blips) → retry helps
- Some failures are persistent (outage) → retry hurts; circuit breaker helps
- High concurrency magnifies failure effects (queue buildup, timeouts)
- Retrying non-idempotent calls can create duplicate side effects
- You need observability to tune thresholds (error rates, latency, timeouts)

---

## Solution
### Retry (with backoff + jitter)
- Retry only when it’s safe and meaningful:
  - retry **idempotent** operations (GET, safe PUT with idempotency key)
  - retry on transient error classes (timeouts, 429, selected 5xx)
- Use exponential backoff with jitter:
  - `sleep = base * 2^attempt + random(0..jitter)`

### Circuit Breaker
State machine:
- **CLOSED**: calls flow; failures tracked
- **OPEN**: fail-fast (no downstream call)
- **HALF_OPEN**: limited trial calls; close if healthy

### Timeouts + Fallbacks
- Timeouts bound latency and protect resources
- Fallbacks (cached/degraded) reduce user impact

---

## When to Use
- Any service-to-service HTTP/gRPC calls
- Enterprise integrations (SaaS APIs, payment providers, identity providers)
- Downstream dependencies with variable latency or quotas

## When Not to Use (or be careful)
- Non-idempotent operations without idempotency keys (e.g., charge card)
- Downstreams that interpret retries as duplicate actions
- When retrying violates latency budgets

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-retry-backoff-cb-sequence.mmd`
- `diagrams/03-circuit-breaker-state-machine.mmd`

## ADRs
- `adrs/ADR-001-adopt-resilience4j.md`
- `adrs/ADR-002-retry-policy.md`
- `adrs/ADR-003-circuit-breaker-thresholds.md`
- `adrs/ADR-004-timeouts-fallbacks.md`
- `adrs/ADR-005-observability-slos.md`

---

## Example Tech (Different from previous patterns)
**Java 21 + Spring Boot 3 + Resilience4j**:
- `downstream-flaky`: simulates intermittent errors and latency
- `caller-service`: calls downstream with retry+backoff and circuit breaker, plus fallback
- `infra`: docker-compose to run both services

See `examples/java-spring-resilience4j/`.

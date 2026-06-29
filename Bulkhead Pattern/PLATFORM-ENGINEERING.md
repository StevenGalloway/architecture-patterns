# Platform Engineering — Bulkhead Pattern

## Bulkheads as a Platform Primitive

A platform team that provides circuit breakers but not bulkheads has given service teams half a resilience toolkit. Circuit breakers stop sending traffic after failures accumulate. Bulkheads prevent the accumulation that causes the failures. They are complementary controls, and both belong in the platform's paved road.

The case for providing bulkheads as a platform capability is the same as the case for any platform primitive: if you don't provide it, teams will either implement it inconsistently, skip it entirely, or implement it incorrectly. The Fraud Detection incident happened because no standard bulkhead capability existed — the Order Processing team used the framework's default shared connection pool because that's what the documentation showed.

---

## What the Platform Provides

### The Bulkhead Library

The platform ships a bulkhead library (or a framework integration) that service teams consume as a dependency. The library is responsible for:

| Capability | Description |
|---|---|
| Semaphore permit management | Acquire and release permits with thread-safe semantics; configurable max concurrent limit |
| Fail-fast behavior | Immediately reject when no permits are available (not queuing mode by default) |
| Permit acquisition timeout | Configurable wait timeout before fail-fast (for the rare case where brief queuing is acceptable) |
| Metrics emission | Automatically emits `bulkhead.permits_acquired`, `bulkhead.permits_released`, `bulkhead.permits_rejected`, `bulkhead.permits_available` per named bulkhead |
| Integration with framework lifecycle | Automatically registers bulkheads defined in configuration at startup; errors on startup if a dependency is referenced without a configured bulkhead |

**Reference implementations by runtime:**

| Runtime | Library | Integration |
|---|---|---|
| Java (Spring Boot) | Resilience4j `BulkheadRegistry` | `@Bulkhead` annotation or programmatic API |
| Rust (Tokio async) | `tokio::sync::Semaphore` | Platform wrapper adds metrics emission and config loading |
| Go | `golang.org/x/sync/semaphore` | Platform wrapper adds metrics and circuit breaker integration |
| Node.js | `cockatiel` library | Platform wrapper adds standardized config schema |
| .NET | Polly `BulkheadPolicy` | Platform NuGet package wraps Polly with standard config schema |

The platform team owns the wrapper layer that adds metrics, standard config schema, and circuit breaker integration. Service teams own the underlying library version within the supported range.

---

## Standard Configuration Schema

Every service team configures bulkheads using the same schema, regardless of their runtime:

```yaml
# bulkhead.yaml — included in every service that calls downstream dependencies
bulkheads:
  - name: payment_service
    max_concurrent_requests: 80
    fail_fast: true
    permit_wait_timeout_ms: 0    # 0 = immediately fail if no permit available
    rationale: >
      Critical path. Every order creation requires a payment authorization.
      Sized at 80 based on 3× peak concurrent payment calls from load test (Nov 2024).
    review_date: 2026-01-01
    owner: order-processing-team
    criticality: critical

  - name: inventory_service
    max_concurrent_requests: 60
    fail_fast: true
    permit_wait_timeout_ms: 0
    rationale: >
      Critical path. Inventory check is required for order validation.
      Sized at 60 based on 3× peak concurrent inventory calls.
    review_date: 2026-01-01
    owner: order-processing-team
    criticality: critical

  - name: fraud_detection
    max_concurrent_requests: 30
    fail_fast: true
    permit_wait_timeout_ms: 0
    rationale: >
      Non-critical. Fraud checks are async for established customers.
      Synchronous fraud checks apply to new customers only (<15% of orders).
      Sized at 30 to handle peak synchronous checks with headroom.
    review_date: 2026-01-01
    owner: order-processing-team
    criticality: non-critical

  - name: notification_service
    max_concurrent_requests: 20
    fail_fast: true
    permit_wait_timeout_ms: 0
    rationale: >
      Non-critical, best-effort. Order confirmation notifications.
      Failed notifications are retried asynchronously; no order is blocked.
    review_date: 2026-01-01
    owner: order-processing-team
    criticality: non-critical
```

**Schema validation in CI:** The platform team maintains a JSON Schema for `bulkhead.yaml`. CI runs schema validation on every PR that modifies bulkhead configuration. Required fields (`name`, `max_concurrent_requests`, `rationale`, `review_date`, `owner`, `criticality`) must be present. A PR that adds a new downstream dependency to the service must include a corresponding `bulkhead.yaml` entry or CI fails.

---

## Self-Service: Adding a Bulkhead for a New Dependency

When a stream-aligned team adds a new downstream dependency to their service, the process is:

1. **Consult the limit-sizing guide** (published by the platform team). The guide provides a formula based on observed peak concurrent calls, a headroom multiplier, and criticality classification.

2. **Add the configuration entry** to `bulkhead.yaml` with all required metadata fields.

3. **Validate locally** by running the platform-provided test harness that simulates permit exhaustion and verifies fail-fast behavior.

4. **Submit PR** with the new dependency code and the `bulkhead.yaml` update in the same commit. CI validates the schema and the circuit breaker configuration is also present (the platform enforces co-deployment of bulkhead + circuit breaker per dependency).

5. **Monitor after deployment** using the platform-provided dashboard. The limit-sizing guide specifies that the initial limit should be revisited after 2 weeks of production traffic data.

No platform team ticket is required. No synchronous coordination with other teams. The platform provides the schema, the validation, and the dashboard — the service team does the sizing.

---

## Platform Contract

### What the platform guarantees

| Capability | Commitment |
|---|---|
| Library correctness | Semaphore semantics are correct: permits are always released, even on exception or timeout |
| Metrics emission | Standard metrics are emitted automatically; service teams do not wire metrics manually |
| Dashboard availability | Standard bulkhead dashboard is available in the observability platform for every service using the library |
| Schema stability | Breaking changes to the configuration schema are announced 60 days in advance with a migration guide |
| Security patches | Critical CVEs in the library are patched and released within 72 hours |

### What service teams are responsible for

| Responsibility | Owner |
|---|---|
| Limit values | Stream-aligned team |
| Rationale documentation | Stream-aligned team |
| Review cadence (review dates must be honored) | Stream-aligned team |
| Circuit breaker configuration per dependency | Stream-aligned team (platform provides the circuit breaker library but not the per-dependency settings) |
| Retry policy that respects bulkhead rejections | Stream-aligned team |
| Incident response when limits saturate | Stream-aligned team |

---

## Limit-Sizing Guide

The platform team publishes and maintains a sizing methodology that service teams follow:

**Step 1: Measure observed peak concurrency**

Run a load test at 1.5× expected peak traffic. Record the p99 concurrent in-flight requests to the target dependency using `bulkhead.permits_acquired - bulkhead.permits_released` at each sampling interval.

**Step 2: Apply the headroom multiplier**

```
initial_limit = observed_peak_concurrent × headroom_multiplier

criticality = critical: headroom_multiplier = 3.0
criticality = non-critical: headroom_multiplier = 1.5
```

A critical-path dependency gets 3× headroom because a rejection is user-visible and revenue-affecting. A non-critical dependency gets 1.5× headroom because a rejection is a degraded-mode event, not a failure.

**Step 3: Validate against total system capacity**

The sum of all bulkhead limits should not exceed total available connections or threads. If `sum(limits) > system_capacity`, reduce non-critical limits first.

```
Payment:    80
Inventory:  60
Fraud:      30
Notify:     20
────────────────
Total:     190   (< 200 connection pool limit — valid)
```

**Step 4: Set the review date**

Review date = today + 6 months, or sooner if traffic is growing rapidly (> 20% month-over-month).

---

## Golden Path Integration Points

Bulkheads connect to other platform capabilities:

```
Service Deployment Config ──► Bulkhead Config Validation (CI)
          │                            │
          ▼                            ▼
Circuit Breaker Library ◄──── Platform Resilience Package
          │                            │
          ▼                            ▼
Observability Platform ◄─── Automatic Metrics Emission
          │                            │
          ▼                            ▼
Alerting Platform ◄────── Saturation Alert Templates
```

A service team that uses the platform's service template gets bulkhead configuration validation, circuit breaker integration, metrics emission, and alerting pre-wired. They provide the limit values. Everything else is automatic.

---

## Signals That Bulkheads Have Become a Platform Anti-Pattern

Watch for these signals that the bulkhead platform capability has degraded or been bypassed:

| Signal | Root cause | Fix |
|---|---|---|
| Service teams are setting all limits to 9999 or "unlimited" | Limits are perceived as friction, not protection; limit-sizing is too hard | Simplify the sizing guide; publish a table of recommended starting values by dependency type |
| Bulkhead limits have `review_date` in the past for > 50% of entries | Review process is not enforced; teams forget | Add a CI check that warns (not fails) on past review dates; add Slack bot reminder 30 days before review date |
| Bulkhead rejection events are not wired to alerts | Metrics are emitted but nobody configured alerts | Platform team provides alert templates; flag services that have metrics but no alert configuration |
| Teams are bypassing the config schema with hardcoded limits in code | Configuration schema is not expressive enough for their use case | Extend the schema; do not accept workarounds that break observability |
| New downstream dependencies are being added without bulkhead entries | CI validation is not running, or is being bypassed | Enforce the dependency-must-have-bulkhead check in CI; make it a blocking check, not a warning |
| Multiple services implement their own custom semaphore logic | Platform library doesn't support their use case | Extend the platform library; custom implementations diverge from standard metrics schema and break dashboards |

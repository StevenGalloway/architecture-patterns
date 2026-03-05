# Bulkhead Pattern (Resource Isolation)

## Summary
The **Bulkhead** pattern isolates critical resources so that failure, latency, or overload in one part of a system does **not** sink the whole service. The name comes from ship bulkheads: compartments prevent flooding from taking down the entire vessel.

Bulkheads can be implemented at multiple layers:
- **Thread/worker pools** (separate execution pools per dependency)
- **Connection pools** (separate DB/client pools per downstream)
- **Concurrency limits** (semaphores per route/tenant/dependency)
- **Queue partitioning** (separate queues with dedicated consumers)
- **Infrastructure isolation** (separate pods/nodes/autoscaling groups)

This repo focuses on **concurrency bulkheads** (semaphores) and **dependency isolation**.

---

## Problem
A service calls multiple downstream dependencies (e.g., Payments, Inventory, Recommendations). If one dependency becomes slow or starts erroring:
- request threads pile up waiting on that dependency
- CPU/memory/connection pools are exhausted
- unrelated endpoints also degrade (cascading failure)

---

## Constraints & Forces
- Shared resources amplify failures (thread pools, connection pools, queues)
- One “slow lane” can starve “fast lanes” under load
- You need predictable latency for critical endpoints
- Isolation must be observable and tunable (limits, queue depth, timeouts)

---

## Solution
### Create compartments (bulkheads)
Allocate **separate resource budgets** for different work types:
- per downstream dependency (Payments vs Analytics)
- per endpoint group (checkout vs search)
- per tenant/customer tier (gold vs standard)

### Enforce concurrency limits
Use a semaphore per compartment:
- if permits are available → process
- if permits are exhausted → fail fast (429/503) or degrade with fallback
- keep a small queue (optional) but avoid unbounded waiting

### Combine with timeouts + circuit breakers
Bulkheads work best alongside:
- timeouts (to avoid long-held permits)
- circuit breakers (to stop calling unhealthy dependencies)
- retries (careful: don’t retry into a saturated bulkhead)

---

## When to Use
- Services calling multiple downstream dependencies
- Endpoints with very different latency characteristics
- High concurrency environments where overload is common
- Mission-critical flows where you must preserve capacity

## When Not to Use (rare)
- Simple, low-traffic services with few dependencies
- Systems where fail-fast is not acceptable and you need full queueing (then size queues carefully)

---

## Tradeoffs
### Benefits
- Prevents cascading failures and resource starvation
- Preserves capacity for critical endpoints
- Improves predictability of tail latency (p95/p99)

### Costs / Risks
- Requires tuning limits per compartment
- If limits are too low → unnecessary rejections
- If limits are too high → insufficient isolation
- Needs observability and runbooks (saturation, rejects, latency)

---

## Failure Modes & Mitigations
1. **Bulkhead saturation causes user-visible 429/503**
   - Mitigation: tune limits; implement fallbacks; consider priority queues
2. **Slow requests hold permits too long**
   - Mitigation: timeouts; cancel in-flight calls; keep downstream timeouts strict
3. **Retry storms amplify saturation**
   - Mitigation: cap retries; add jitter; don’t retry when bulkhead rejects
4. **Noisy neighbor across tenants**
   - Mitigation: per-tenant bulkheads; tiered capacity budgets
5. **Silent capacity erosion**
   - Mitigation: metrics on permits in-use, rejects, queue depth, latency percentiles

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-bulkhead-sequence.mmd`
- `diagrams/03-capacity-allocation.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-bulkhead.md`
- `adrs/ADR-002-concurrency-semaphore-bulkheads.md`
- `adrs/ADR-003-failfast-vs-queueing.md`
- `adrs/ADR-004-timeouts-cancellation.md`
- `adrs/ADR-005-observability-and-tuning.md`

---

## Example (Different Tech)
This example uses **Rust + Axum + Tokio** (new tech vs your Go/.NET/Java/Kotlin patterns):
- `caller`: exposes `/call/fast` and `/call/slow` and applies **separate bulkheads** per dependency
- `downstream-fast`: consistently fast endpoint
- `downstream-slow`: slow and occasionally erroring endpoint (simulates overload risk)
- `infra`: docker-compose to run all three services

See `examples/rust-axum-bulkhead/`.

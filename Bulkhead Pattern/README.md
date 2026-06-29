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

## Security Considerations

The Bulkhead pattern introduces a security surface that is easily overlooked because the pattern is primarily framed as a reliability concern. But the ability to control how much capacity a given caller or dependency can consume is also a security control — one that directly mitigates resource exhaustion attacks and tenant isolation failures.

**Key security dimensions of the Bulkhead:**
- **Tenant isolation as a security boundary:** Per-tenant bulkheads prevent one tenant from consuming all available capacity, which in a multi-tenant system is both a reliability failure and a data availability breach for other tenants. Without tenant bulkheads, a sufficiently high-volume tenant can effectively deny service to all others.
- **Defense against retry storms:** A compromised or misconfigured client that issues thousands of retries after receiving 429/503 responses can exhaust a bulkhead faster than legitimate traffic. The bulkhead must emit metrics that trigger rate limiting upstream before retry floods saturate the compartment.
- **AI inference pool protection:** GPU-backed inference pools are expensive and limited. A tenant that can submit unlimited large-context requests can monopolize inference capacity, preventing access for all other tenants. The token budget bulkhead is the primary isolation control for AI inference.
- **Audit logging for rejection events:** Every bulkhead rejection event is operationally meaningful and potentially security-relevant. A pattern of rejections concentrated on a specific tenant or caller is an anomaly that warrants investigation — it may indicate a misconfigured client, an attack, or a capacity planning failure.

**Compliance relevance:** SOC 2 CC9.1 (risk mitigation via availability controls), multi-tenant SLA contractual obligations, PCI DSS Requirement 6.4 (protection against denial of service for cardholder data environments).

→ See [SECURITY.md](SECURITY.md) for the full threat model, per-tenant isolation requirements, AI inference pool security controls, audit logging requirements for rejection events, and the security review checklist.

---

## Observability Considerations

A bulkhead that emits no metrics is a capacity control that no one can tune. The pattern's value is directly proportional to the quality of its observability: without permit utilization metrics, you cannot tell whether limits are too low (causing unnecessary rejections), too high (providing no isolation), or correctly sized.

**Golden signals for Bulkheads:**
- **Latency:** Track permit acquisition latency as a leading indicator of saturation. If acquiring a permit takes more than 1ms, the compartment is approaching full utilization and requests will soon start queueing or being rejected.
- **Traffic:** Monitor `permits_in_use` as a percentage of `permits_total` per compartment continuously. A compartment consistently above 60% utilization is a risk; one consistently below 10% has a misconfigured limit.
- **Errors:** Track rejection rate per compartment separately from upstream error rate. A rejection from the bulkhead is a deliberate resource control event, not a dependency failure. Conflating them makes both invisible.
- **Saturation:** The compartment itself is the saturation metric. When `permits_in_use == permits_total`, all new requests are rejected or queued. This is the critical signal — not CPU or memory.

**SLO targets (reference):** Rejection rate < 0.5% at baseline traffic, < 2% at 3× traffic. Permit utilization < 70% at baseline (leaving headroom for spikes). Permit acquisition latency < 1ms at p99.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, per-compartment SLI/SLO definitions, structured log schema for rejection events, dashboard designs, and 6 chaos engineering test scenarios with pass criteria.

---

## Team Topology

Bulkhead ownership is split across two layers that must not be conflated. The bulkhead library — the semaphore implementation, the metrics emission hooks, the configuration schema — is a platform team asset. The limit values — 80 permits for Payment, 30 for Fraud Detection — are the stream-aligned team's configuration. Only they know their traffic patterns, downstream SLAs, and the business consequence of rejecting a given call.

This distinction matters because the two types of ownership operate at different cadences. The platform team releases the library quarterly. The service team may need to tune limits in response to a production incident, a traffic growth event, or a dependency SLA change — on a weekly cadence. Conflating these into platform-owned limit values creates a bottleneck that undermines the pattern's operational value.

**The stale limit problem** is the most dangerous failure mode after initial deployment: a limit that was correctly set 18 months ago, by an engineer who has since left, that has never been revisited as traffic grew. Require every limit to have a documented rationale and a review date, enforced by CI.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the full ownership model, the stale limit problem and its mitigation, team interaction modes, and the scaling model from 1–5 to 15+ downstream dependencies.

---

## Cost Analysis

The cost of bulkheads is not infrastructure — it is capacity headroom and engineering time. Semaphore-based bulkheads add approximately zero infrastructure cost (a semaphore is microseconds of CPU and a few bytes of memory). The real cost is the engineering discipline to size, document, and review limits as the system evolves.

| Implementation approach | Additional infra cost | Engineering cost | Notes |
|---|---|---|---|
| Semaphore-based (recommended) | ~$0 | 0.05–0.2 FTE/year tuning | Negligible compute; cost is limit review cadence |
| Thread pool per dependency | +$0–800/month | 0.1–0.3 FTE/year | Only for synchronous thread-per-request runtimes |
| Pod-level isolation per dependency | +$300–8,000/month | 0.2–0.5 FTE/year | Justified only for PCI physical isolation requirements |

The cost of not implementing bulkheads is one Black Friday incident: a single slow dependency exhausting the shared connection pool and taking down all endpoints simultaneously. At typical e-commerce revenue rates, one such incident exceeds the full lifetime cost of implementing and tuning bulkheads.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full option comparison across four implementation approaches, the cost of over-provisioning from conservative limits, retry storm cost amplification, and the cost decision guide.

---

## AI Integration

AI inference workloads are the highest-stakes application of the Bulkhead pattern in modern systems. GPU compute is scarce, expensive, and non-fungible with CPU. Without bulkheads, a single burst of large-context requests can exhaust the entire inference pool, blocking all other users — including interactive users waiting on real-time responses.

**Key ways this pattern extends for AI workloads:**
- **GPU/CPU pool isolation:** LLM inference is compute-intensive. Without bulkheads, a model serving spike during a batch job starves your payment processing thread pool. GPU pools must be isolated from CPU pools; inference workloads must be isolated from serving workloads.
- **Inference queue bulkheads (interactive vs. batch):** Separate queues for interactive (low latency, small context) and batch (high throughput, large context) requests prevent a batch job from crowding out real-time users. The interactive queue has strict latency SLOs; the batch queue has throughput SLOs. They must not compete for the same resources.
- **Token budget bulkheads:** Isolate expensive long-context requests from cheap short-context requests at the tenant level. One tenant submitting 128K-token prompts exhausting the rate limit pool starves all other tenants. Token budget limits must be the primary control, not request count.
- **Fallback model bulkheads:** If the primary model's bulkhead is exhausted, route to a cheaper/faster fallback model rather than failing. The fallback model has its own compartment, preventing the fallback from being overwhelmed when the primary is saturated.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full AI inference isolation architecture, token budget bulkhead implementation, interactive vs. batch queue separation, and the fallback model routing pattern.

---

## Platform Engineering

The Bulkhead pattern is a platform capability that every service team should consume rather than implement. The bulkhead library — semaphore implementation, metrics emission, configuration schema, rejection behavior — is built once by the platform team and consumed by all stream-aligned teams as a dependency.

**The paved road model:** A service team that needs to protect against a slow dependency should add a bulkhead configuration entry — not implement a semaphore from scratch. The platform provides the semaphore, the metrics hooks, the dashboard templates, and the limit-sizing guide. The team provides the limit values and rationale documentation.

**Self-service limit configuration:** Teams configure limits in a versioned YAML file in their repository. CI validates the configuration schema (required fields: limit value, rationale, review date, owner). A CI check flags configurations with past-due review dates in the weekly engineering hygiene report. No platform team ticket required for limit changes.

**Platform contract:** The platform team commits to the bulkhead library being available, metrics emitting automatically, and breaking changes being announced 30 days in advance. Service teams commit to documenting limit rationale, reviewing limits on the scheduled date, and not configuring limits without load test evidence.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the bulkhead library interface, configuration schema, limit-sizing guide, self-service deployment approach, and signals that the bulkhead configuration has become dangerously stale.

---

## Business Case

Bulkhead isolation ensures that a slow or failing dependency affects only the compartment allocated to it, not the entire service — protecting business-critical flows (checkout, payment) from non-critical flows (recommendations, analytics) during dependency degradation.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for non-technical stakeholders (CPO, CFO, VP Engineering): the problem in plain language, what implementation costs in engineer-weeks and monthly infrastructure, what the business gains, and the risk of inaction.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (Order Processing service, downstream dependencies, bulkhead compartments)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (semaphore store, per-dependency compartments, circuit breakers, observability)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-bulkhead-sequence.mmd](diagrams/02-bulkhead-sequence.mmd) — Request sequence through bulkhead permit acquisition and release
- [03-capacity-allocation.mmd](diagrams/03-capacity-allocation.mmd) — Capacity allocation across compartments

---

## Architecture Decision Records
- [ADR-001: Adopt Bulkhead pattern](adrs/ADR-001-adopt-bulkhead.md)
- [ADR-002: Concurrency semaphore bulkheads](adrs/ADR-002-concurrency-semaphore-bulkheads.md)
- [ADR-003: Fail-fast vs. queuing mode](adrs/ADR-003-failfast-vs-queueing.md)
- [ADR-004: Timeouts and cancellation](adrs/ADR-004-timeouts-cancellation.md)
- [ADR-005: Observability and tuning](adrs/ADR-005-observability-and-tuning.md)

---

## Example (Different Tech)
This example uses **Rust + Axum + Tokio** (new tech vs your Go/.NET/Java/Kotlin patterns):
- `caller`: exposes `/call/fast` and `/call/slow` and applies **separate bulkheads** per dependency
- `downstream-fast`: consistently fast endpoint
- `downstream-slow`: slow and occasionally erroring endpoint (simulates overload risk)
- `infra`: docker-compose to run all three services

See `examples/rust-axum-bulkhead/`.

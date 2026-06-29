# Team Topology — Bulkhead Pattern

## Who Owns Bulkhead Configuration?

Bulkhead ownership is split across two layers, and conflating them is the most common governance failure.

The **bulkhead library or framework** — the semaphore implementation, the metrics emission hooks, the configuration schema — is a **platform capability**. The platform engineering team builds it once, maintains it, and provides it as a dependency that service teams consume.

The **bulkhead limit values** — 80 permits for Payment, 60 for Inventory, 30 for Fraud Detection, 20 for Notification — are **stream-aligned team configuration**. The Order Processing team owns these numbers. Only they know their traffic patterns, their downstream SLAs, and the business consequences of rejecting a given call.

This distinction matters because the two types of ownership operate at different cadences. The platform team changes the library on a quarterly release cycle. The service team may need to tune limits in response to production incidents, traffic growth, or new dependency relationships — on a weekly or even daily cadence. If the platform team owns the limit values, that tuning pace is impossible.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | Bulkhead library/framework, configuration schema, metrics emission, dashboard templates, limit-sizing guide |
| **Order Processing** | Stream-aligned | Bulkhead limit values for their downstream dependencies, limit review cadence, incident response when limits saturate |
| **Fraud Detection** | Stream-aligned | Provides capacity SLAs that inform the Order Processing team's limit configuration; owns reducing their own call latency |
| **Payment, Inventory, Notification** | Stream-aligned | Same as Fraud Detection — capacity SLA providers |
| **SRE / Observability** | Enabling team | Bulkhead saturation alerting standards, SLO definitions for rejection rate, chaos game days to validate isolation |

---

## Conway's Law Implications

The Fraud Detection team and the Order Processing team are different teams. This is correct organizational design — Fraud Detection is a specialized domain that should not be bundled with order processing. But it creates a coordination need that bulkhead configuration makes visible.

The Order Processing team must configure a bulkhead limit for the Fraud Detection dependency. To set that limit correctly, they need to know:

- What is Fraud Detection's observed p99 latency under normal load?
- What is the maximum concurrency Fraud Detection can handle before degrading?
- Is Fraud Detection on a growth trajectory that will require the limit to change in 6 months?

The Fraud Detection team has this information. The Order Processing team does not. Without a structured coordination mechanism, the Order Processing team sets a limit based on guesswork, and that limit becomes stale the moment Fraud Detection changes its infrastructure.

**The structural fix:** Downstream teams publish capacity SLAs as part of their service contract. This is the same documentation that informs circuit breaker timeout values, retry budgets, and SLO targets. The bulkhead limit is derived from that contract, not from internal knowledge that requires a meeting to obtain.

**The failure mode without this structure:** The Black Friday incident. The Fraud Detection service's database bottleneck caused its p99 latency to climb from 80ms to 1,400ms. The Order Processing team had no limit on how many connections Fraud Detection could consume, because there was no coordination mechanism that told them a limit was necessary. The limit was implicitly "all of them," which is the same as no limit at all.

---

## The Stale Limit Problem

The most dangerous failure mode for bulkheads is not a wrong initial configuration — it is a limit that was correctly set 18 months ago, by an engineer who no longer works there, that has never been revisited since traffic doubled.

Stale limits fail in both directions:

- **Too low after traffic growth:** Legitimate traffic is rejected at a rate that was once acceptable (2% rejection under peak load) but is now constant (15% rejection at baseline). The limit was sized for 1,000 req/sec; the service now handles 4,000 req/sec. Users see errors every day, and no one knows why because the limit was set before anyone on the current team joined.
- **Too high after a dependency was made non-critical:** A dependency that was originally on the critical path was rearchitected to be async, but its bulkhead limit still reflects critical-path sizing. The high limit allows it to consume excess capacity during degradation that could have been reallocated to current critical-path dependencies.

**The runbook requirement:** Every bulkhead limit must have a documented rationale and a review date.

```yaml
# bulkhead-config.yaml — required metadata per limit
dependencies:
  fraud_detection:
    max_concurrent_requests: 30
    rationale: >
      Non-critical path. Fraud checks are async for established customers.
      Sized at 30 to handle synchronous fraud checks for new customers
      at peak load (observed max: 22 concurrent during Nov 2024 load test).
    review_date: 2026-01-01
    owner: order-processing-team
    last_reviewed: 2025-04-23
    last_reviewed_by: "S. Galloway"
  payment:
    max_concurrent_requests: 80
    rationale: >
      Critical path. Every order creation requires a payment authorization.
      Sized at 80 based on p99 concurrent payment calls at 3× current peak traffic.
    review_date: 2026-01-01
    owner: order-processing-team
    last_reviewed: 2025-04-23
    last_reviewed_by: "S. Galloway"
```

The review date is enforced: a CI check flags configurations where `review_date` is in the past. The flag does not block deployments (that would create perverse incentives to push review dates out), but it does appear on the team's weekly engineering hygiene report.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform team → stream-aligned | **X-as-a-service** | Teams consume the bulkhead library, configuration schema, and dashboards without requiring platform team involvement. Standard use cases require no collaboration. |
| SRE → stream-aligned | **Enabling** | SRE team sets alerting standards (alert at 80% permit utilization), runs chaos game days to validate isolation, and consults on limit-sizing methodology. Not involved in day-to-day limit management. |
| Order Processing → Fraud Detection | **Collaboration (bounded)** | Required when setting or significantly revising the Fraud Detection bulkhead limit. Time-boxed: one async document exchange to share capacity data, not an ongoing meeting series. |
| Order Processing → Platform team | **Collaboration (exception)** | Required only for non-standard use cases: custom bulkhead implementations, framework integrations not covered by the platform library, or bulkhead limits that need to integrate with per-tenant isolation. |

---

## Cognitive Load Considerations

Bulkhead configuration is low-complexity for individual services but accumulates cognitive load as the number of downstream dependencies grows.

A service with 4 downstream dependencies (the Order Processing case) needs 4 limits, 4 rationale documents, and 4 review dates. That is manageable.

A service with 15 downstream dependencies needs 15 limits. At that scale, the cognitive load of tracking which limits are stale, which need revisiting because of traffic changes, and which dependencies have changed their capacity characteristics exceeds what a single team can maintain without tooling.

**Platform tooling that reduces this load:**
- Automatic saturation alerts (platform provides the alert; team does not need to set it up)
- Utilization trending in the dashboard (team can see at a glance which limits are being approached)
- Automated review date reminders (CI or Slack bot notifies the team owner 30 days before review date)

---

## Scaling the Team Model

| Scale | Downstream dependencies | Recommended model |
|---|---|---|
| Small | 1–5 dependencies | Stream-aligned team owns limits directly. Platform provides the library. Limit rationale is a comment in the config file. |
| Medium | 5–15 dependencies | Platform provides a configuration schema with enforced metadata (rationale, review date, owner). SRE team establishes limit-sizing guide. Downstream teams publish capacity SLAs. |
| Large | 15+ dependencies | Limit management becomes a first-class engineering process. Consider per-tenant limits (adds another dimension). Automated capacity planning tooling consumes utilization metrics to surface recommended limit adjustments. |

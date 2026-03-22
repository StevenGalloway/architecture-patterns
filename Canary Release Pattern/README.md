# Canary Release Pattern

## Summary
A **Canary Release** gradually shifts a small percentage of production traffic to a new version and expands the rollout only if **health and business signals** remain within acceptable limits.

Core ideas:
- Start with a small traffic slice (e.g., 1–5%)
- Observe critical metrics (error rate, latency, saturation, business KPIs)
- Automatically **promote** or **abort/rollback** based on analysis
- Reduce blast radius while still validating in real production conditions

---

## Problem
Deploying a new version to 100% of users at once risks:
- large-scale outage from a regression
- customer-impacting latency increases
- degraded reliability from unforeseen dependency interactions
- rapid incident escalation and rollback complexity

---

## Constraints & Forces
- You want real traffic validation without risking the entire fleet
- Metrics must be trustworthy and representative
- Canary analysis must be automated and repeatable
- You need clear rollback behavior and safe defaults
- Traffic splitting requires gateway/mesh/ingress support

---

## Solution
1. Deploy **stable** and **canary** versions side-by-side
2. Split traffic progressively (weights/headers/regions)
3. Run an **analysis** per step:
   - error rate threshold
   - p95 latency threshold
   - saturation (CPU/mem, thread pools)
4. Promote to 100% if analysis passes; otherwise rollback

Common variations:
- **Time-based** (increase weight every N minutes)
- **Metric-based** (increase weight when SLOs are healthy)
- **User-based** (canary for internal users / allowlisted accounts)
- **Region-based** (start in one region first)

---

## When to Use
- High-traffic services where real-world validation matters
- Changes with elevated risk (auth, payments, data access, caching)
- Teams with strong observability and defined SLOs
- Regulated environments requiring controlled change management

## When Not to Use (or be careful)
- Very low traffic services (insufficient signal; use shadow/blue-green)
- Changes that require strict schema migrations without compatibility
- Systems lacking reliable monitoring/alerting

---

## Tradeoffs
### Benefits
- Reduced blast radius
- Faster detection of regressions
- Supports continuous delivery with guardrails

### Costs / Risks
- Requires traffic splitting support (gateway/mesh/ingress)
- Needs metric governance (false positives/negatives)
- Can increase operational complexity (two versions running)

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-rollout-steps.mmd`
- `diagrams/03-analysis-gates.mmd`

---

## ADRs
- `adrs/ADR-001-canary-over-bluegreen.md`
- `adrs/ADR-002-traffic-splitting-ingress.md`
- `adrs/ADR-003-analysis-metrics-contract.md`
- `adrs/ADR-004-rollback-policy.md`
- `adrs/ADR-005-observability-slos.md`

---

## Example (New Tech)
This example uses **Kubernetes + Argo Rollouts** with a **.NET 8 Minimal API** app:
- progressive traffic weights
- automated analysis gates using a simple HTTP “web” metric
- explicit rollback behavior

See `examples/kubernetes-argo-rollouts-dotnet/`.

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

## Example (New Tech)
This example uses **Kubernetes + Argo Rollouts** with a **.NET 8 Minimal API** app:
- progressive traffic weights
- automated analysis gates using a simple HTTP "web" metric
- explicit rollback behavior

See `examples/kubernetes-argo-rollouts-dotnet/`.

---

## Security Considerations

Canary releases run two versions of a service simultaneously — and the window when they co-exist is a distinct security surface. The deployment and promotion pipeline itself is a trust boundary: the analysis automation that promotes code to 100% of traffic must be as hardened as the code it's promoting.

**Core security concerns for canary deployments:**
- The canary version must use the same secrets management as the production version. Never use separate credentials for canary pods that bypass production access controls or rate limits.
- Schema changes between the stable and canary version that affect shared state (database records, cache keys, message formats) can corrupt data for the portion of users served by the stable version. Canary deployments require backward- and forward-compatible changes during the overlap window.
- The CI/CD pipeline that controls traffic promotion must require the same code review and approval policies as any production deployment. Canary automation that bypasses standard controls is a supply chain vulnerability.
- Automated rollback is only useful if it has been tested independently of the canary promotion path. A rollback that has never been executed in staging is an untested recovery mechanism.

**Compliance relevance:** SOC 2 CC8.1 (change management must be authorized and auditable — automated promotions must log the decision, the metrics values, and the threshold at time of promotion); PCI DSS Req 6.3 (security of development practices applies to canary promotion pipelines).

→ See [SECURITY.md](SECURITY.md) for the full threat model, attack surface table, CI/CD pipeline security requirements, and pre-production security checklist.

---

## Observability Considerations

Canary releases are only as good as the metrics used to evaluate them. An analysis gate that measures the wrong thing produces false positives (good builds rolled back) or false negatives (broken builds promoted). Both outcomes destroy team trust in canary automation. When engineers start bypassing the analysis gate because "it always fails on noise," the entire blast radius reduction benefit disappears.

**The key principle:** compare canary metrics *against the stable version serving simultaneously*, not against an absolute threshold. The stable version is the real-time control group. A canary that is slower than stable — even if within the absolute SLO — is a regression.

**Golden signals for canary analysis:**
- **Latency:** `canary.latency.p95 / stable.latency.p95 > 1.15` = fail. Relative comparison catches regressions that stay within absolute SLOs but degrade the user experience.
- **Traffic:** `canary.requests.rate / total.requests.rate` must match the declared weight ±1%. Drift in this ratio means the traffic splitter is misbehaving, not the service code.
- **Errors:** `canary.error_rate - stable.error_rate > 0.005` (0.5% absolute increase over stable baseline) = fail. Comparing delta to stable is more robust than comparing to an absolute threshold.
- **Saturation:** `canary.cpu.utilization > stable.cpu.utilization × 1.25` = fail. A canary using 25% more CPU than stable will cost more and degrade under traffic spikes.

**SLO targets:** Canary Analysis Accuracy SLO — 95% of canary rollouts that proceed to 100% are incident-free within 24 hours (measures false negative rate). Rollback Execution SLO — automated rollback completes within 2 minutes of analysis failure.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, relative comparison methodology, SLI/SLO definitions, structured log schema for canary events, dashboard designs, and chaos engineering scenarios.

---

## Team Topology

Canary releases introduce a clean separation between two responsibilities: who owns the *mechanism* (traffic splitting, analysis runner, rollback automation) and who owns the *criteria* (which metrics matter for this specific service, what thresholds constitute success, what business KPIs should be monitored).

**Platform team** owns the mechanism. **Stream-aligned teams** own the criteria.

The failure mode when this split is wrong: a platform team defines a single global AnalysisTemplate for all services. The Orders service needs error rate and p95 latency analysis. The Recommendation service needs recommendation quality score and click-through rate analysis. A global template that doesn't know about service-specific business metrics will produce false positives for one service and false negatives for another. Platform sets the *framework*; product teams fill in the *values*.

**Conway's Law signal:** If canary rollouts for a service consistently fail on noise (false positives), the analysis configuration ownership is wrong. The team that understands what "correct behavior" means for their service must own the AnalysisTemplate for their service.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the full team type classification, platform vs. stream-aligned responsibility split, interaction modes, and the scaling model from manual canary (1-3 teams) to fully automated GitOps (10+ teams).

---

## Cost Analysis

The primary cost of canary releases is running two versions of the service simultaneously during the rollout window. For a service with 10 pods, a canary at 10% traffic adds 1-2 canary pods for the duration of the analysis window. At 4 steps × 10 minutes per step, that's 40 minutes of double pod cost per deployment.

| Scale | Infrastructure cost/month | Primary tooling |
|---|---|---|
| Small (2-5 services, Kubernetes) | ~$50-110/mo extra pods + $0 Argo Rollouts OSS | Argo Rollouts OSS |
| Medium (10-30 services) | ~$500-1,070/mo (pods + Prometheus storage) | Argo Rollouts + Prometheus |
| Large (50+ services, enterprise) | $250,000-560,000+/year (tooling + ops) | Spinnaker Enterprise or Argo Enterprise |

**The break-even argument:** A single major incident caused by a full-fleet bad deploy costs 4-24 engineer-hours plus customer impact. Canary at 5% limits a regression to 5% of customers for 10 minutes before automated rollback. At 8-12 deploys per week, catching 2-3 serious regressions per year recovers the annual infrastructure cost many times over.

**Largest hidden cost:** Analysis windows add latency to every deployment. A 4-step canary with 10-minute analysis windows takes a minimum of 40 minutes to reach 100%. For teams that need faster deployment cycles, tune step weights (fewer steps) or reduce analysis windows — but understand the tradeoff with detection confidence.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full infrastructure cost breakdown at 3 org scales, alternative tool comparison (Argo Rollouts vs. Flagger vs. LaunchDarkly), and the 4 cost anti-patterns most common in canary implementations.

---

## AI Integration

Canary releases for AI/ML systems require additional analysis gates beyond traditional software. The standard error rate and latency gates are necessary but not sufficient — a model that responds correctly in terms of HTTP status codes may be producing lower-quality outputs that only surface in quality metrics.

**Key AI-specific extensions to canary:**
- **Model version canary:** Route X% of traffic to a new model version. Gate promotion on quality metrics (accuracy, refusal rate, user satisfaction scores) in addition to latency and error rate. A sentiment classifier returning 200 OK with wrong classifications passes all traditional gates.
- **Shadow mode evaluation:** Run the new model on 100% of traffic without returning its responses. Compare outputs offline against the stable model before switching any traffic. De-risks model changes by providing full-traffic quality comparison before any user sees the new model's outputs. Note: doubles inference compute during the evaluation period.
- **Quality SLO gates:** Define measurable quality thresholds (sentiment accuracy >94%, hallucination rate <2%) that block canary promotion the same way latency SLOs do. These require a ground-truth evaluation layer in the analysis pipeline.
- **Rollback complexity for AI:** Reverting a model version is not a config change. It requires re-routing inference traffic and potentially invalidating cached model outputs from the canary version. If cached responses from the canary model persist after rollback, users continue receiving outputs from the rolled-back model version.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full treatment: model version canary implementation, shadow mode infrastructure requirements, quality SLO gate design, rollback procedures for AI systems, and A/B testing model variants on canary infrastructure.

---

## Platform Engineering

Canary release infrastructure should be a platform capability. Teams should declare what they want — success metrics, thresholds, step weights — and receive a working canary pipeline without configuring Argo Rollouts specs, writing AnalysisTemplate YAML, or managing traffic weights manually.

**The paved road:** A team adds a `canary:` block to their service manifest. The platform generates the Rollout spec, wires up the AnalysisTemplate, connects to the metrics store, and enables the canary dashboard in the observability platform. The team never touches Argo Rollouts directly.

```yaml
canary:
  enabled: true
  steps: [5, 20, 50, 100]
  analysis_window_minutes: 10
  metrics:
    - name: error-rate
      threshold: 0.01
    - name: p95-latency-ms
      threshold: 500
  rollback_on_failure: true
```

**Platform contract:** Traffic splitting accuracy ±1% of declared weight; automated rollback within 2 minutes of analysis failure; 30-day notice for AnalysisTemplate schema changes.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the paved road comparison table, full self-service manifest schema, platform contract definition, and the 5 anti-patterns that indicate canary has become a platform bottleneck.

---

## Business Case

A 1.5-engineer-week investment in canary release infrastructure limits any future deployment regression to 5% of users for 10 minutes before automatic rollback — compared to the current model where a bad deploy affects 100% of users until it's manually detected and reverted.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for CPO, CFO, and VP Engineering: the 22-minute checkout incident in plain language, what this implementation costs, the 97% reduction in customer impact for the same class of regression, and what we're not changing.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (developer, SRE, end user, external systems)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (rollout controller, analysis runner, traffic splitter, stable and canary pod sets, config store)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-rollout-steps.mmd](diagrams/02-rollout-steps.mmd) — Progressive traffic shifting steps and promotion schedule
- [03-analysis-gates.mmd](diagrams/03-analysis-gates.mmd) — Analysis gate decision logic and rollback trigger

---

## Architecture Decision Records
- [ADR-001: Prefer Canary releases over Blue/Green for high-traffic services](adrs/ADR-001-canary-over-bluegreen.md)
- [ADR-002: Traffic splitting via ingress controller](adrs/ADR-002-traffic-splitting-ingress.md)
- [ADR-003: Analysis metrics contract](adrs/ADR-003-analysis-metrics-contract.md)
- [ADR-004: Rollback policy and safe defaults](adrs/ADR-004-rollback-policy.md)
- [ADR-005: Observability standards and SLOs](adrs/ADR-005-observability-slos.md)

---

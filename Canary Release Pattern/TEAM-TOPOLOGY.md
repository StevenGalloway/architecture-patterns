# Team Topology — Canary Release Pattern

## Who Owns the Canary?

Canary releases are a **platform team** capability that stream-aligned teams consume. The infrastructure — traffic splitting, metrics collection, automated analysis, rollback orchestration — is owned and operated by the platform team. The analysis configuration — which metrics matter, what thresholds define success, what business signals must hold — is owned by the stream-aligned team that operates the service.

This split is not arbitrary. Platform owns the mechanism because the mechanism is the same for every service. Stream-aligned teams own the criteria because the criteria are different for every service. Confusing these two ownership domains is the most common reason canary deployments produce false positives, erode engineer trust, and get bypassed.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | Traffic splitting infrastructure, Argo Rollouts / Flagger deployment and upgrades, analysis runner execution engine, rollback orchestration, canary dashboard |
| **Observability** | Enabling team | Metric store (Prometheus + Thanos / Datadog), SLO tooling, canary analysis data provider, metric query API reliability |
| **Stream-aligned teams** | Stream-aligned | Analysis configuration: which metrics to evaluate, what thresholds constitute success, when to page on rollback, service-specific SLOs |
| **SRE / Reliability** | Enabling team | Rollback procedures and runbooks, incident integration (PagerDuty escalation on failed rollback), post-canary review process |

The Rollout controller and the AnalysisTemplate execution engine belong to platform. The content of the AnalysisTemplate — the specific metric queries and thresholds — belongs to the team that wrote the service.

---

## Conway's Law Implications

If the team that writes the code is different from the team that defines the deployment pipeline and analysis configuration, the analysis config will be wrong.

The platform team knows how to run a canary. They do not know whether a 2% increase in the Orders service error rate is a serious regression or expected noise from a new retry policy. The product team that built the Orders service knows this. They know the baseline behavior, the acceptable variance, and the business impact of a degraded checkout flow.

**What the org structure predicts about your canary program:**

- **Platform team defines a single global AnalysisTemplate** → The Orders service gets the same thresholds as the Recommendation service. Orders has a 0.5% error rate baseline and strict latency SLOs. Recommendations has a 2% error rate baseline and tolerates higher latency in exchange for richer results. The global template either misses Orders regressions (thresholds too loose) or constantly fails Recommendations (thresholds too tight). Engineers stop trusting the analysis and start promoting manually.
- **Stream-aligned teams write their own AnalysisTemplates with no platform review** → Config sprawl. Teams use different metric names, different query patterns, and different statistical approaches. The platform cannot provide a canary dashboard without building service-specific connectors.
- **Hybrid: platform provides AnalysisTemplate library and schema; stream-aligned teams declare their service's thresholds** → Scales. Teams inherit the platform's metric query structure and rollback mechanism. They customize only the threshold values and metric selection for their service. This is the recommended model.

---

## Failure Mode: Wrong Analysis Ownership

The most common failure pattern: the platform team, trying to provide a consistent out-of-the-box experience, defines a global AnalysisTemplate with default thresholds for all services. The defaults are conservative enough to be "safe" across the entire fleet.

For the Orders service (8-12 deploys/week, p95 latency SLO of 200ms, error rate SLO of 0.5%), the global template's 1% error rate threshold misses a genuine regression — the canary error rate goes from 0.4% to 0.8%, passes the 1% gate, and promotes a broken build.

For the Recommendations service (lower traffic, 3% error rate baseline, quality measured by click-through rate not error rate), the global template's error rate threshold causes false positives on normal variance, rolling back valid deployments.

Each service needs its own analysis configuration, owned by the team that understands the service's behavior.

**Signal to watch for:** If canary rollbacks are consistently occurring for reasons unrelated to the new code — baseline metric noise, incorrect thresholds, insufficient traffic sample — the analysis configuration ownership is in the wrong team.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform → stream-aligned | **X-as-a-service** | Canary infrastructure just works. Teams declare their analysis config; the platform executes rollouts, runs analysis, and handles rollback automatically. No collaboration required for standard deployments. |
| Observability → Platform | **Enabling** | Observability team provides reliable metric APIs (Prometheus query endpoint, Datadog metrics API) and SLO data that the analysis runner consumes. Quarterly review of metric schema changes that could break AnalysisTemplates. |
| Stream-aligned → Platform | **Collaboration** | Required only for non-standard needs: custom analysis providers, new traffic splitting strategies, percentage-based routing that doesn't fit the standard 5/20/50/100 schedule. Time-box these engagements — they should not be the norm. |
| SRE → Stream-aligned | **Enabling** | SRE provides rollback runbooks, post-canary review process, and escalation paths when automated rollback fails. Not on-call for normal canary rollouts — only escalated when rollback automation itself fails. |

---

## Scaling the Team Model

| Org scale | Recommended model |
|---|---|
| **1–3 teams** | Manual canary with a shared rollback runbook. One AnalysisTemplate per service, maintained by whoever deployed last. Platform infra not yet worth the investment. |
| **4–10 teams** | Argo Rollouts with per-service AnalysisTemplates. Platform team operates the controller and provides a template library. Each team owns their template's threshold values. |
| **10+ teams** | Platform self-service: teams declare canary config in their service manifest, platform generates the Argo Rollouts config and AnalysisTemplate via a GitOps pipeline. Platform team reviews policy violations only (threshold too wide, analysis window too short, rollback disabled). |

The transition from 4-10 to 10+ is the hardest. It requires the platform team to invest in tooling (self-service config generation, policy enforcement) rather than direct service support. Teams that stay in the 4-10 model at 15+ services become the bottleneck — every new service needs a platform ticket to set up their canary config.

---

## Cognitive Load Considerations

Canary deployments shift cognitive load from "did this deploy succeed?" (binary, post-deployment) to "what does success look like for this service?" (requires domain knowledge, pre-deployment). This is a good shift — it forces teams to articulate their service's expected behavior in measurable terms.

The risk is that the analysis configuration itself becomes a maintenance burden. An AnalysisTemplate that was tuned for the Orders service six months ago may have wrong thresholds today if the service's traffic patterns or latency characteristics have changed. Teams must review and update their analysis configs as their service evolves.

Platform mitigations:
- Analysis config lives in the service repository alongside the application code, not in a separate platform config repository. When a developer changes a service, they see the analysis config in the same PR.
- Platform provides a canary dry-run mode that evaluates the AnalysisTemplate against recent historical metrics without deploying anything. Teams can validate threshold correctness before the next deployment.
- Monthly summary of false positive and false negative rates per service, sent to service owners — gives teams the signal to tune their configs.

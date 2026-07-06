# Platform Engineering — Canary Release Pattern

## Canary Release as a Platform Primitive

A team should not need to understand Argo Rollouts CRDs, write AnalysisTemplate YAML from scratch, configure traffic weight calculations, or debug Prometheus query syntax to deploy their service safely. These are platform concerns. The team's concern is: which metrics matter for my service, and what thresholds define success.

The platform provides the mechanism. The team provides the criteria. When this boundary is clear, canary releases scale to dozens of services without requiring a platform team ticket for each one.

Done poorly, canary becomes a bureaucratic gate that adds 40 minutes to every deployment with no team ownership of whether it works. Done well, it is the deployment primitive that every team uses without thinking about it — the same way teams use structured logging without building their own log forwarder.

---

## The Paved Road

| Without platform (dirt road) | With platform (paved road) |
|---|---|
| Each team reads Argo Rollouts docs and writes their own Rollout spec | Standard Rollout spec generated from a service manifest declaration |
| Each team writes their own AnalysisTemplate, invents their own metric query syntax | Platform provides a validated AnalysisTemplate library; teams declare thresholds, not queries |
| Each team defines their own rollback strategy (or leaves it to defaults they don't understand) | Automated rollback is the default; teams opt out explicitly with justification |
| Each team monitors their own canary deployment in a terminal or custom dashboard | Canary dashboard is auto-generated per service; accessible in the developer portal |
| Deployment failures are discovered by an engineer watching kubectl events | Notification sent to service owner's Slack channel when canary rollback occurs |

The paved road must be faster than the dirt road. If writing a Rollout spec by hand is faster than declaring canary config in the service manifest, teams will write the Rollout spec — and the platform loses its value.

---

## Self-Service Model

Teams declare canary configuration in their service manifest. The platform generates the Argo Rollouts Rollout resource and AnalysisTemplate. Teams never touch raw Rollout YAML unless they have a non-standard requirement.

```yaml
# service.yaml — service team owns this file, lives in service repository
apiVersion: platform.internal/v1
kind: Service
metadata:
  name: orders
  team: checkout-squad
spec:
  image: orders-service
  replicas: 10
  canary:
    enabled: true
    steps: [5, 20, 50, 100]
    analysis_window_minutes: 10
    metrics:
      - name: error-rate
        threshold: 0.005          # 0.5% — tighter than default, Orders has strict SLO
      - name: p95-latency-ms
        threshold: 200            # 200ms — per Orders service SLO
      - name: saturation-cpu
        threshold: 0.70           # Alert if canary uses >70% CPU vs stable
    rollback_on_failure: true
    notify_on_rollback: "#checkout-alerts"
```

**What teams control via the manifest:**
- Canary step weights and analysis window duration
- Which metrics to evaluate and what threshold values define success
- Rollback behavior (enabled by default; explicit opt-out requires justification comment)
- Notification channel for rollback events

**What teams do not control:**
- The traffic splitting mechanism (ingress controller vs. service mesh — platform decision per cluster)
- The AnalysisTemplate query syntax (platform-maintained, versioned, tested)
- The rollback execution mechanism (Argo Rollouts controller — platform-owned)
- The metric store connection (platform-provided Prometheus endpoint)

---

## Platform Contract

The platform team publishes and maintains a formal contract for the canary capability. Teams can rely on these guarantees when building their deployment pipelines:

| Capability | Platform guarantee |
|---|---|
| **Traffic splitting accuracy** | ±1% from the declared step weight. A 5% canary weight routes 4–6% of traffic to the canary. Drift beyond ±1% triggers a platform alert. |
| **Rollback execution time** | Automated rollback completes within 2 minutes of analysis failure detection. A rollback that does not complete in 2 minutes pages the platform team on-call. |
| **Analysis report availability** | Canary analysis report (metric values, pass/fail per metric, promotion or rollback decision) is available in the developer portal within 5 minutes of promotion or rollback. |
| **AnalysisTemplate library stability** | 30-day notice for any breaking change to the AnalysisTemplate library schema or metric query syntax. Minor additions (new optional metric types) are non-breaking and require no notice. |
| **Platform availability** | Argo Rollouts controller availability: 99.9% monthly. A controller outage does not affect running services — it only blocks new deployments. |

**What service teams are responsible for:**
- The correctness of their declared metric thresholds (the platform runs the analysis; teams own whether the thresholds are meaningful)
- Ensuring the metrics declared in their canary config are emitted by their service (a metric that is never emitted produces no signal — the platform cannot detect this proactively)
- Reviewing canary rollback notifications and acting on them within the on-call SLA for their service

---

## Developer Experience

### Local Development

Local development should not require canary infrastructure. Developers run their service normally against a local Kubernetes cluster or docker-compose. The canary configuration in `service.yaml` is parsed and validated locally but does not trigger a rollout:

```bash
# Validate canary config schema locally before pushing
platform validate service.yaml

# Output:
# ✓ canary.steps: [5, 20, 50, 100] — valid
# ✓ canary.metrics[0]: error-rate at 0.005 threshold — within acceptable range
# ✓ canary.metrics[1]: p95-latency-ms at 200ms — within acceptable range
# ⚠ canary.analysis_window_minutes: 10 — note: insufficient signal at <10 req/s canary traffic
```

The validation tool runs as a pre-commit hook and as a CI step, catching configuration errors before they reach staging.

### Staging Environment

The staging environment has canary infrastructure enabled and runs the full canary promotion sequence for every deployment. This serves two purposes:
1. Validates that the analysis configuration works before production exposure
2. Catches analysis template misconfigurations (wrong metric names, invalid query syntax, thresholds that are never reachable) in a safe environment

Staging uses a shorter analysis window (2 minutes vs. 10 minutes production) to keep the feedback loop fast. Teams should see a complete canary promotion or rollback within 10 minutes of deploying to staging.

### Dry Run Mode

The platform provides a dry-run capability that evaluates the current AnalysisTemplate against the last 24 hours of production metrics without shifting any traffic:

```bash
platform canary dry-run orders --version v2.1.0

# Output:
# Evaluating AnalysisTemplate against production metrics (2024-01-15 08:00 to 09:00)
# ✓ error-rate: 0.003 (threshold: 0.005) — would PASS
# ✓ p95-latency-ms: 185ms (threshold: 200ms) — would PASS
# ✓ saturation-cpu: 0.42 (threshold: 0.70) — would PASS
# Simulated result: PROMOTE
```

Dry run mode is particularly useful after tuning analysis thresholds — teams can validate that the new thresholds would have passed the last 24 hours of production traffic before deploying with those thresholds.

---

## Anti-Patterns the Platform Must Prevent

The platform must enforce these through configuration validation, not documentation. If a team can accidentally configure a broken canary, they will.

| Anti-pattern | Platform enforcement |
|---|---|
| **Bypassing canary by deploying directly to production pods** | RBAC: teams do not have kubectl patch or replace permissions on Deployment resources. All deployments must go through the Rollout resource, which the platform controls. |
| **Thresholds set so wide they never fail** | Validation: if `error-rate` threshold > 0.10 (10%), validation warns the team that their threshold is likely too permissive. Requires justification comment to merge. |
| **Analysis window < 3 minutes** | Validation: enforced minimum analysis window of 3 minutes. Below that, there is insufficient traffic sample for most services. |
| **Canary enabled on a service with <5 replicas** | Warning: canary traffic splitting at 5% is 0.25 replicas on a 5-replica deployment — not meaningful. Warn and suggest minimum replica count for the declared canary step weights. |
| **Same AnalysisTemplate threshold for all services** | Enforcement: every service must declare its own threshold values. The platform library provides the query structure; it does not provide default threshold values that can be silently inherited. |

---

## Golden Path Integration Points

Canary release integrates with the broader platform:

```
CI/CD Pipeline ──────► Rollout Controller ──────► Traffic Splitter
      │                        │                        │
      ▼                        ▼                        ▼
Image Registry          Analysis Runner         Ingress Controller
(signed artifacts)   (AnalysisTemplate         (weight enforcement)
                      from GitOps store)
      │                        │
      ▼                        ▼
Service Manifest ──► Platform Config       Metrics Platform
(team-owned)         Generator             (Prometheus query API)
                     (platform-owned)
                                                    │
                                                    ▼
                                           Developer Dashboard
                                           (auto-generated per service)
```

Each integration point is automatic from the team's perspective. A team that adds `canary: enabled: true` to their service manifest gets traffic splitting, analysis, rollback automation, dashboard, and notifications without touching any other system. That is the definition of a platform primitive.

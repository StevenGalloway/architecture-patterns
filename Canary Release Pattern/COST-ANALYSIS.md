# Cost Analysis — Canary Release Pattern

## Cost Drivers

Canary releases introduce costs across four dimensions. The first three are infrastructure costs you pay continuously. The fourth — incident cost reduction — is the reason you pay them.

| Dimension | Description |
|---|---|
| **Dual-version compute** | During the canary window, two versions of the service run simultaneously. At a 5/20/50 step schedule with 10-minute analysis windows, the canary window is 30-40 minutes per deployment — not continuous overhead, but it multiplies pod count during that window. |
| **Traffic splitting overhead** | Varies by approach: Ingress-based splitting has near-zero overhead; service mesh sidecar proxy adds ~1-3ms per request and ~50-100MB memory per pod for the sidecar process. |
| **Analysis tooling** | Prometheus + Thanos for metric storage, Argo Rollouts or Flagger as the analysis runner, Grafana for canary dashboards. Most components are OSS with compute costs for hosting. |
| **Deployment time overhead** | A 4-step canary (5% → 20% → 50% → 100%) with 10 minutes of analysis at each step adds a minimum of 40 minutes to deployment time vs. a 5-minute blue/green cutover. This is an engineer productivity cost, not infrastructure cost, but it is real. |

---

## Infrastructure Cost by Org Scale

### Small (2–5 services, Kubernetes on EKS/GKE)

| Component | Cost |
|---|---|
| Argo Rollouts controller | Free (OSS); controller runs as a Deployment using ~0.5 vCPU / 256MB at idle |
| Extra Kubernetes pods during canary window | ~$20–50/month (30-40 min/deploy × 8-12 deploys/week, canary adds 10-20% pod count) |
| Prometheus (single instance, 15-day retention) | ~$30–60/month (m5.large or equivalent: ~$70/month, shared with other monitoring workloads) |
| **Total infrastructure overhead** | **~$50–110/month** |

At this scale, the operational overhead is minimal — one engineer can set up Argo Rollouts in 1-2 days, and the ongoing maintenance burden is hours per month, not a dedicated headcount.

### Medium (10–30 services, Kubernetes, multi-team)

| Component | Cost |
|---|---|
| Argo Rollouts OSS or Flagger | Free (OSS); controller scales horizontally, ~$20/month in compute |
| Extra pod cost during canary windows | ~$200–500/month (more services, higher base pod count) |
| Prometheus + Thanos (30-day retention, HA) | ~$300–500/month (Thanos with object storage adds S3 cost; HA Prometheus doubles compute) |
| Grafana (self-hosted or Cloud free tier) | $0–50/month |
| **Total infrastructure overhead** | **~$520–1,070/month** |

At this scale, the analysis tooling becomes the dominant cost. Thanos or Cortex for long-term metric storage is required because the default Prometheus 15-day retention window isn't long enough to establish stable baselines for canary comparison.

### Large (50+ services, enterprise, multi-cluster)

| Component | Annual cost |
|---|---|
| Argo Rollouts Enterprise or Spinnaker enterprise support | $50,000–200,000/year |
| Dedicated canary analysis platform (Kayenta, enterprise DataDog) | $30,000–100,000/year |
| Multi-cluster traffic splitting infrastructure | $50,000+/year (engineering + compute) |
| SLO tracking and error budget tooling | $20,000–60,000/year |
| Dedicated platform engineering headcount (0.5–1 FTE) | $100,000–200,000/year fully loaded |
| **Total annual cost** | **$250,000–560,000+/year** |

At this scale, the OSS operational burden (Prometheus scaling, Argo Rollouts upgrades, Thanos object store management) typically justifies an enterprise support contract. The cost comparison is not OSS-free vs. enterprise pricing — it is OSS-free + 0.5 FTE ops burden vs. enterprise contract + 0.1 FTE ops burden.

---

## Alternative Approaches Cost Comparison

| Approach | Licensing | Ops burden | Traffic splitting | Analysis |
|---|---|---|---|---|
| **Argo Rollouts OSS** | $0 | Low (Kubernetes-native, declarative) | Ingress or service mesh | Built-in AnalysisTemplate |
| **Flagger** | $0 | Low (similar to Argo Rollouts) | Ingress, Istio, Linkerd, App Mesh | Built-in metric templates |
| **Spinnaker OSS** | $0 | High (~0.5 FTE to operate well) | Manages Kubernetes deployments | Kayenta canary analysis engine |
| **LaunchDarkly** (feature flags as canary) | $400–2,000/month | Low (managed SaaS) | User-based targeting, not traffic % | Limited (A/B testing, not SLO analysis) |
| **AWS CodeDeploy** | $0 for Kubernetes; $0.02/deployment for EC2 | Low (managed) | Linear and canary deployment configs | Limited (CloudWatch alarms only) |
| **Harness CD** | $2,000–8,000/month (enterprise) | Low (managed SaaS) | Kubernetes canary + blue/green | Built-in canary verification |

**LaunchDarkly note:** Feature flags solve a different problem. They can limit blast radius by user segment, but they do not validate infrastructure behavior (memory, CPU, connection pool exhaustion) the way traffic-based canary does. Using feature flags as a substitute for canary deployment is an incomplete solution that catches behavioral regressions but misses infrastructure regressions — exactly the class of issue the 40ms database query regression (ADR-001) demonstrated.

---

## Break-Even Analysis

**Scenario:** Orders service, 8–12 deploys/week, ~$X/minute in order volume.

A single major production incident caused by deploying bad code to 100% of users:
- **Engineer time to detect and resolve:** 4–24 hours (the 22-minute checkout outage required detection, diagnosis, rollback, and verification)
- **Customer impact during that window:** varies, but at any meaningful order volume, 22 minutes of degraded checkout is a material revenue event
- **Post-incident costs:** customer refunds, SLA credits, support volume spike, trust erosion

At 8–12 deploys/week × 52 weeks = 416–624 deployments/year. If canary catches 2–3 serious regressions per year that would otherwise have been full-traffic incidents, the infrastructure cost ($50–1,070/month at small-to-medium scale) is recovered in the first avoided incident.

The break-even calculation is not primarily about infrastructure cost. It is about incident cost. The infrastructure cost is the insurance premium. The avoided incident cost is the claim.

---

## Hidden Costs

| Cost | Notes |
|---|---|
| **Analysis window deployment latency** | A 4-step canary with 10-minute analysis windows adds 40 minutes minimum to deployment time. At 8–12 deploys/week, this is 5–8 engineer-hours/week of waiting. Design the canary schedule to match the risk profile of each deploy — not every deploy needs a 40-minute canary window. |
| **Analysis template tuning** | When analysis templates produce false positives (rolling back valid deployments), engineers spend time tuning thresholds. Budget 2–4 hours per service for initial threshold calibration and expect quarterly reviews. False positives destroy trust in canary automation faster than almost anything else. |
| **Metric store storage** | Canary analysis requires comparing canary metrics against stable baseline metrics over the same time window. Long-term metric retention for baseline comparison (30+ days) is more storage than Prometheus defaults provide, requiring Thanos or similar long-term storage. |
| **Two-version compatibility tax** | During the canary window, two versions run simultaneously. Any code change that is not backward-compatible with the previous version requires a two-phase deployment. This is a hidden engineering cost when developers assume single-version consistency. |

---

## Cost Anti-Patterns

**1. Running canary for services with insufficient traffic**
A service receiving fewer than 10 requests/second cannot generate statistically meaningful signal during a 10-minute analysis window. At 5% canary weight, that is 3 requests per minute in the canary pod — not enough to distinguish a real regression from noise. The analysis produces false positives, engineers override the automation, and the canary system loses credibility. Use blue/green for low-traffic services (as noted in ADR-001).

**2. Leaving both versions deployed long past the canary window**
If a deployment is promoted but the canary pod set is not scaled down, you are paying for double the compute with no benefit. The Rollout controller handles this automatically, but infrastructure-as-code drift or manual kubectl interventions can leave orphaned canary replicas. Audit pod counts weekly and set alerts on unexpected replica sets.

**3. Running full canary for trivial changes**
A documentation-only change, a logging format tweak, or a dependency version bump with no behavioral change does not need 40 minutes of production analysis. Some teams distinguish between "release-level" changes (full canary) and "patch-level" changes (accelerated canary with 2-minute windows or direct blue/green). Over-applying the full canary window to trivial changes causes engineers to perceive canary as a delay mechanism rather than a safety mechanism.

**4. Global AnalysisTemplate with thresholds calibrated for the worst-case service**
If the global error rate threshold is set to 2% to accommodate high-baseline services, low-baseline services will promote regressions that never trigger the threshold. This is not a cost saving — it is a false economy that manifests as production incidents.

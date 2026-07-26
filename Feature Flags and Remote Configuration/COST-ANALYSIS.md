# Cost Analysis: Feature Flags and Remote Configuration

## Cost Drivers

Feature flag system costs are dominated by different factors at different scales. Understanding which cost driver dominates at your scale determines whether to build, buy, or adopt an open-source managed option.

| Cost Driver | Notes |
|-------------|-------|
| **SDK instance count** | Each SDK instance holds a persistent SSE connection. This is the primary scaling variable — it grows with service instance count, not user count. |
| **MAU (Monthly Active Users)** | Drives managed service pricing (LaunchDarkly bills per MAU). In-process evaluation makes per-evaluation cost essentially zero; you are paying for targeting rule complexity and user context lookups. |
| **Flag evaluation volume** | At in-process evaluation, flag eval is CPU-nanoseconds. Cost materializes only in log storage if evaluation events are emitted at 100% sample rate for high-volume flags. |
| **Audit log storage** | Flag changes are low-volume but must be retained indefinitely (or per compliance window). Not a primary cost driver at typical change rates (100–500 flag changes/month). |
| **Management API compute** | Low-traffic API; does not scale with user count. Scales with engineer count and CI/CD pipeline automation. |
| **SSE connection infrastructure** | Load balancer cost for maintaining persistent connections. 1,000 SDK instances × persistent SSE = meaningful load balancer line item at scale. |

---

## Option Comparison

Three viable options exist on the build vs. buy spectrum:

- **Option A: Self-built** — Node.js management API, Redis for flag state cache, PostgreSQL for flag definitions and audit log
- **Option B: LaunchDarkly** — Market-leading managed service, per-seat + per-MAU pricing
- **Option C: Flagsmith** — Open-source flag platform, self-hosted or managed cloud tier

### Cost at Three Scale Tiers

| Tier | SDK Instances | MAU | Self-Built (A) | LaunchDarkly (B) | Flagsmith (C) |
|------|---------------|-----|-----------------|-------------------|----------------|
| **Small** | 10 | 100K | $150/mo infra + 3 wk build | ~$400/mo | ~$45/mo (cloud) or $80/mo infra self-hosted |
| **Medium** | 50 | 1M | $400/mo infra + 0.1 FTE maint. | ~$2,500/mo | ~$300/mo (cloud) or $200/mo infra |
| **Large** | 200 | 10M | $900/mo infra + 0.1 FTE maint. | ~$8,000–15,000/mo | ~$1,000/mo (cloud) or $500/mo infra |

**LaunchDarkly pricing basis:** ~$10/seat/month (Starter) plus $0.04/MAU above the plan threshold. Enterprise plans negotiate flat rates but commonly reach $50,000–$200,000/year at 5M+ MAU with 50+ seats.

**Flagsmith pricing basis:** Open-source self-hosted is infrastructure cost only. Flagsmith Cloud tiers at ~$45/month (Startup, 1M API calls/month) scaling to enterprise custom pricing.

**Self-built infrastructure basis:** Single-region deployment. Two application server instances (management API + SSE), Redis t3.medium, PostgreSQL db.t3.medium (RDS). Does not include engineering time for initial build or ongoing maintenance.

---

## Build vs. Buy Decision Framework

### LaunchDarkly is economical when:

- Time-to-value matters more than total cost of ownership. You can ship progressive delivery in days instead of 3–4 engineer-weeks.
- MAU is below 500K. At this scale, the per-MAU cost is moderate and the engineering time saved clearly exceeds the subscription.
- Your engineering team lacks prior flag platform experience. LaunchDarkly's SDK quality and targeting rule tooling are production-hardened in ways that a first self-build typically is not.
- You need multi-language SDK support immediately (Go, Java, Python, Node, iOS, Android). Maintaining SDK parity across 4+ runtimes is 0.5–1 FTE/year in self-build.
- Statistical experiment analysis is required. LaunchDarkly includes experiment result analysis; self-built requires a separate analytics investment.

**Typical break-even:** LaunchDarkly vs. self-built breaks even when MAU × $0.04 + seats × $10 > $1,500/month (approximately 30K MAU + 20 engineers). Below this threshold, LaunchDarkly wins on time-to-value. Above this threshold, self-build economics improve substantially.

### Self-built is economical when:

- MAU exceeds 2M. LaunchDarkly at $0.04/MAU becomes $80,000+/year for the MAU component alone.
- You need tight control over the data plane. Targeting rules for multi-tenant SaaS with complex entitlement logic may exceed what managed platforms support cleanly.
- Your SDK footprint is narrow (one or two languages). Maintenance burden is manageable.
- You have existing Redis and PostgreSQL infrastructure — marginal cost of adding flag tables and cache namespace is low.
- Compliance requirements prevent sending user context to a third-party managed service (healthcare, government, regulated financial services).

### Flagsmith is a strong option when:

- You want managed hosting economics without per-MAU pricing exposure.
- You need open-source auditability (SOC 2, security review requirements).
- Budget is a primary constraint and LaunchDarkly pricing is not justifiable at current scale.

---

## Hidden Costs

These costs are real but frequently omitted from build vs. buy comparisons.

### 1. Flag Debt Cleanup

Without lifecycle tooling, each stale flag is a hidden testing burden that compounds quarterly. A release flag left in the codebase doubles the code path matrix for the affected feature area. At 50 stale flags across a codebase, integration test coverage gaps accumulate silently.

**Quantified:** One stale flag cleanup (find flag, verify safety to remove, remove code branch, update tests, deploy) averages 2–4 engineer-hours. 50 stale flags = 100–200 engineer-hours per cleanup cycle. This cost does not appear in infrastructure bills but is real engineering capacity consumed.

**Mitigation:** TTL enforcement and automated cleanup alerts in the platform. This is a feature of LaunchDarkly, must be built in self-hosted Flagsmith, and is a build item in self-built.

### 2. A/B Test Statistical Analysis

LaunchDarkly Pro/Enterprise includes experiment result analysis. Self-built requires a separate analytics investment. Options range from $0 (Statsig OSS, Eppo community tier) to $50,000–$80,000/year (Amplitude Experiment, Statsig enterprise). This cost is often invisible in the initial build vs. buy comparison and surfaces 6–12 months after launch when the growth team needs reliable experiment results.

### 3. Multi-Language SDK Maintenance

Supporting Go, Java, Python, and Node SDK clients with consistent evaluation semantics, safe caching behavior, and SSE reconnection logic across language runtimes is **0.5–1.0 FTE/year** in a self-built system. LaunchDarkly and Flagsmith provide these SDKs as part of the subscription. Self-build proposals that do not account for this maintenance cost are underestimating total cost of ownership by 50% or more.

### 4. SSE Connection Infrastructure

1,000 SDK instances each holding a persistent SSE connection requires a load balancer configured for long-lived HTTP connections (not the default TCP timeout). At AWS ALB pricing, 1,000 persistent connections add approximately $100–300/month in load balancer costs that do not appear in flag platform pricing. This scales linearly with SDK instance count, not user count.

---

## Cost Anti-Patterns

### Anti-Pattern 1: Using LaunchDarkly for Ops Configuration Without Targeting

Ops configuration flags that control timeouts, rate limits, and thresholds do not use user context for targeting — they are environment-level values. LaunchDarkly charges per-MAU for evaluations, but these evaluations never use the user targeting features the per-MAU pricing pays for. Ops configuration without user targeting should use environment-defaulted flags or, better, a simple remote configuration system (AWS AppConfig, LaunchDarkly contexts with environment-only targeting). The cost impact at 5M MAU: $200,000/year to serve configuration values that could be served for $1,000/year.

### Anti-Pattern 2: 100% Evaluation Event Sampling for High-Volume Flags

Logging every flag evaluation for a flag evaluated 50 million times per day at $0.10/GB log ingestion cost is $1,500–$3,000/month in log storage alone. The structured evaluation event (flagKey, variant, ruleMatched, tenantId, userId, timestamp) is approximately 200 bytes. At 100% sampling and 50M evaluations/day, that is 10GB/day. The correct sampling strategy is 0.1% or 1% for high-volume flags, 100% for kill switch activations and low-volume flags where statistical coverage requires full sampling.

### Anti-Pattern 3: Separate Flag Deployments per Environment

Standing up a separate flag management API, Redis instance, and PostgreSQL database per environment (dev, staging, production) triples infrastructure costs and creates three separate systems to operate, monitor, and upgrade. The correct architecture uses a single management API with environment namespaces. Flags have values per environment; a single flag definition exists in one database with per-environment targeting rules. This reduces management API costs by 2/3 and eliminates cross-environment configuration drift.

---

## Cost Summary

| Decision | Recommendation |
|----------|---------------|
| Scale < 500K MAU, need to ship quickly | LaunchDarkly — time-to-value exceeds subscription cost |
| Scale 500K–2M MAU | Model total cost including SDK maintenance and analytics; LaunchDarkly vs. self-build is roughly equivalent |
| Scale > 2M MAU | Self-built or Flagsmith self-hosted wins on infrastructure economics |
| Narrow language footprint (1–2 SDKs) | Self-built is viable at any scale |
| Regulated industry, data residency requirements | Self-built or Flagsmith self-hosted required |
| Need experiment statistics analysis | Factor in analytics platform cost for self-build |

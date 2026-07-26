# Executive Brief: Feature Flags and Remote Configuration

**Audience:** CPO, CFO, VP Engineering
**Reading time:** 4 minutes

---

## The Problem We Are Solving

Today, releasing a new feature means deploying code to production for all users at once. If the feature has a bug that only appears at production load — under real user behavior, real data volumes, real concurrent access patterns — we discover it when 100% of users are affected.

Our response to that discovery is a full rollback: reverting the deployment, which takes 30–60 minutes and may also revert unrelated changes from other teams who deployed in the same window. Engineering is paged, users see errors or degraded behavior, customer support handles the volume spike, and we spend the next several days in incident review.

Our last three major production incidents followed this exact pattern. The features that caused them worked correctly in testing. They failed at production scale, under conditions we cannot fully replicate in a lower environment.

The root problem: we have no mechanism to release a feature to 1% of users first.

---

## What Feature Flags Do

Feature flags allow code to ship to production in a disabled state. The feature exists in production — it is deployed, it has passed all tests — but no user sees it yet. We activate it for a controlled group:

- 1% of users for the first 24 hours
- If no errors, expand to 10%
- If no errors, expand to 50%, then 100%

At each stage, we are monitoring error rates, response times, and business metrics specific to that feature. A problem detected at 1% affects 1% of users. The same problem detected at 100% — our current default — is a major incident.

The rollback mechanism changes entirely. Instead of reverting a deployment (30–60 minutes, high coordination overhead, risk of reverting other changes), we flip a flag to disabled. This takes seconds. No deployment, no cross-team coordination, no on-call escalation chain. The on-call engineer does it directly from the incident management dashboard.

---

## What We Are Investing

**Option 1: Self-built** — 2–4 engineer-weeks to build the core flag evaluation system (management API, SDK, flag delivery infrastructure). Approximately $150–500/month in ongoing infrastructure cost. Requires 0.1 FTE ongoing maintenance.

**Option 2: LaunchDarkly (managed service)** — Operational within days. At our current scale, approximately $15,000–40,000/year depending on user volume. Includes experiment analysis tooling.

**Option 3: Flagsmith (open-source, self-hosted)** — Lower cost than LaunchDarkly at our scale; open-source auditability; requires more infrastructure setup than the managed option.

The investment in any of these options is approximately the cost of one major incident response — engineer time, user impact, and customer support combined.

---

## What We Gain

**Zero-downtime rollback.** Disabling a feature flag takes seconds. No deployment, no coordination, no 3am deployment pipeline access. Our on-call rotation can respond to a bad feature without paging the deployment team.

**Release cadence decoupled from deployment cadence.** Teams deploy code whenever it is ready. They release it to users when the business is ready — after a specific date, after a specific market opens, coordinated with a marketing campaign, or after a partner integration is confirmed. Code ships continuously; user-visible releases happen on the business schedule.

**A/B testing without code changes.** Product experiments that previously required a full feature build, deployment, and measurement cycle can be configured at the flag level. A new checkout flow, a pricing change, a content variant — these become targeting rule changes, not deployment events. Experiment cycle time drops from weeks to hours.

**On-call empowerment.** An engineer on call at 2am can disable any failing feature without needing access to the deployment pipeline, without waking up the release team, and without risking an unrelated rollback. This is an operational capability we do not currently have.

**Per-tenant and per-plan feature tiers.** For SaaS products, feature flags enable clean per-plan entitlement: enterprise customers get a feature, starter customers do not, and the control is a flag targeting rule, not a code path per plan.

---

## What the Risk of Inaction Looks Like

Our next major incident caused by a bad release will follow the same pattern as the last three. The cost of each incident includes:

- Engineering time (incident response, rollback execution, post-mortem, remediation): 40–80 engineer-hours
- User impact (error rates, degraded experience, lost transactions): variable, but measurable in customer support tickets and churn signals
- Customer support spike: 20–50 support hours per incident
- Fully loaded cost per major incident: approximately $15,000–30,000

The break-even on feature flag investment is a single prevented major incident. We do not need to prevent ten incidents per year to justify the investment. We need to prevent one.

---

## What We Are Not Changing

- **Not replacing our deployment pipeline.** Code still goes through CI, testing, and deployment review. Feature flags operate after deployment, not instead of it.
- **Not changing how code is written.** The code change per feature is small: one flag evaluation call at the feature entry point. No architectural changes to existing services.
- **Not requiring all features to use flags.** Internal tools, database migrations, infrastructure changes, and low-risk configuration changes do not need flags. The overhead of flag creation and cleanup is not justified for every change. Teams apply flags to features with meaningful user exposure and rollback risk.
- **Not granting unrestricted production access.** Flag operations are RBAC-controlled. Not every engineer can disable any feature. Kill switch access for operational flags is provisioned per role, with a full audit trail of every flag change.

---

## Decision

We are recommending the self-built approach if our language footprint is narrow (two runtimes or fewer), or LaunchDarkly if we need to be operational within days and require multi-language SDK support from day one.

The investment is a one-time build of 2–4 weeks (self-built) or subscription setup of a few days (managed). The operational benefit begins on the first release that uses a feature flag instead of a full deployment.

The ask: engineering capacity to build or procure the flag platform, and organizational alignment that progressive delivery — not full-rollout deploys — becomes the default for features with meaningful user exposure risk.

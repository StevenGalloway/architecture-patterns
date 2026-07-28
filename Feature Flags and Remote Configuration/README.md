# Feature Flags and Remote Configuration

## Summary
Feature flags (feature toggles) decouple **deployment** from **release**. Code ships to
production disabled; it is activated for a controlled cohort when ready. Remote
configuration extends this to allow **runtime-tunable parameters** (timeouts, limits,
thresholds, copy) to change without a code deploy.

Together they enable:
- **Dark launches** — ship code to production before any user sees it
- **Progressive delivery** — expose changes to 1% → 10% → 100% with health gates
- **Kill switches** — disable a feature instantly without a rollback deploy
- **A/B testing** — serve different variants to defined cohorts
- **Per-tenant entitlement** — activate features per plan or tenant

---

## Problem
- Long-lived feature branches accumulate merge conflicts and integration debt
- Releases require cross-team coordination to avoid breaking changes
- Rolling back a bad release requires a full redeployment (slow, high-risk)
- Behavior changes in production require a complete release cycle
- A/B experiments require code changes per variant — no decoupling of experiment from deploy

---

## Constraints & Forces
- Flag **evaluation must be sub-millisecond** — cannot make a network call per request
- Flags must be **observable** — every change must have an actor, timestamp, and diff
- **Flag sprawl** is the primary long-term risk; without lifecycle governance, flags become permanent
- Multi-tenant SaaS requires **per-tenant and per-plan overrides** at targeting rule level
- Flags must **never replace RBAC** or proper authorization — they control visibility, not access
- SDK adds a dependency; must define behavior when SDK cache is stale or management API is unavailable

---

## Solution

### Flag Taxonomy (four types)
| Type | Purpose | Max TTL | Owner |
|------|---------|---------|-------|
| **Release** | Gate incomplete features during trunk-based development | 30 days | Feature team |
| **Experiment** | A/B test variant assignment | 90 days | Product/growth team |
| **Ops / Kill Switch** | Emergency disable, circuit breaker | Permanent (annual review) | Platform/on-call |
| **Permission** | Per-tenant or per-plan feature entitlement | Permanent | Billing/entitlement team |

### Local Evaluation SDK Model
1. On startup, SDK fetches all flags from the management API and seeds an in-process cache
2. Per-request evaluation: SDK evaluates targeting rules against user/tenant context entirely in-process — **no network call**
3. Background: management API pushes flag updates via **SSE (Server-Sent Events)** to all connected SDK instances
4. On management API unavailability: SDK continues using last-known-good cache; each flag defines a **safe default**

### Targeting Rule Evaluation Order
First matching rule wins:
1. Explicit override (specific user or tenant ID)
2. Tenant rule (by tenant ID or plan)
3. Cohort/segment rule (by user attribute)
4. Percentage rollout (deterministic hash on `flagKey + userId`, sticky per user)
5. Environment default
6. Global default

### Remote Configuration
Typed key-value store (boolean, string, number, JSON) with:
- JSON Schema validation on write
- Versioned values with change diff in audit log
- Same SDK delivery as feature flags (SSE push + local cache)

---

## When to Use
- Trunk-based development: incomplete features need to live in production safely
- Progressive delivery with health-gated rollout stages
- Operational kill switches required by on-call runbooks
- A/B testing and product experimentation without separate code deploys
- SaaS products with per-tenant or per-plan feature tiers

---

## When Not to Use
- **Replacing RBAC:** Flags control exposure, not authorization. A hidden feature can still be accessed directly if authorization isn't enforced separately.
- **Hiding known vulnerabilities:** Flagging a feature off while fixing a bug is acceptable briefly. Flags are not a substitute for a security fix.
- **Permanent code conditionals:** If a flag has been on for > 1 year with no plan to remove the branch, it is configuration, not a flag. Move it to a proper configuration system.
- **Systems without observability:** Flags without an audit log and evaluation metrics are untrustworthy in production.

---

## Tradeoffs

### Benefits
- Zero-downtime rollback (disable flag, no deploy required)
- Reduced release risk via progressive exposure
- Faster experimentation cycle (no deploy per A/B variant)
- On-call empowerment (kill switches operable without deploy access)
- Clean separation of deployment and release concerns

### Costs / Risks
- **Flag debt:** Without lifecycle enforcement, flags accumulate and become implicit permanent configuration
- **Testing complexity:** Each flag doubles the code path matrix; thorough testing requires covering all variants
- **SDK dependency:** In-process SDK must be kept current; SDK bugs can affect all flag evaluations
- **Targeting rule complexity:** Overlapping rules create hard-to-predict evaluation behavior; requires preview tooling

---

## Failure Modes & Mitigations

1. **Flag evaluation service unavailable**
   Mitigation: In-process SDK cache continues serving last-known-good state. Each flag definition includes a `safeDefault` used when the key is absent from cache. Document the safe default clearly (default-on vs. default-off per flag type).

2. **Flag targeting misconfiguration (wrong cohort exposed)**
   Mitigation: Provide a dry-run/preview API showing which variant a given user context would receive before applying. Require peer review for targeting rule changes in production. Alert on unexpected variant distribution changes (e.g., 10% flag suddenly evaluating to 100%).

3. **Flag sprawl / stale flags**
   Mitigation: Enforce `expiresAt` field at flag creation time (required for Release and Experiment types). Automated staleness alerts when age exceeds type TTL. Ownership assigned to a team at creation. Quarterly cleanup sprint.

4. **Inconsistent flag state across instances during sync**
   Mitigation: SSE pushes updates to all SDK instances within < 5 seconds (max staleness SLO). During the sync window, instances may evaluate the same flag differently — this is acceptable for most features. For strict consistency requirements, use the old value of a flag (pre-change) as an invariant until full sync is confirmed.

5. **Remote configuration schema drift**
   Mitigation: All remote config values have a JSON Schema definition stored in the registry. Writes are validated at the API layer before storage. CI-time schema diff check on any changes to config definitions.

---

## Security Considerations
- Flag management plane requires **RBAC**: read (view flags), write (create/update flags), admin (delete, manage access)
- **Immutable audit log**: every flag change records actor (user/system), timestamp, and full before/after value diff. Log must not be modifiable.
- **No PII in targeting rules**: use opaque tenant IDs and user IDs, never email addresses or names. Targeting rules are logged and visible to engineering; PII must not appear there.
- **Kill switch access**: on-call engineers must be able to disable any kill-switch flag without requiring a code deploy or elevated production access. Provision this access before incidents occur.
- **SDK API keys**: manage SDK read-only API keys via a secrets manager. Rotate on schedule. SDK keys should have read-only access to flag state only.

Unauthorized flag writes can disable active security controls or expose unreleased features. SDK key compromise reveals the full flag state including tenant entitlement structure. PII must never appear in targeting rules — the audit log is visible to all engineers with read access. Kill switch access must be pre-provisioned before incidents occur; emergency access requests take too long during outages.

→ See [SECURITY.md](SECURITY.md)

---

## Observability Considerations

| Signal | SLO / Alert |
|--------|-------------|
| Flag evaluation errors | Alert on any evaluation error (flag not found is a code bug) |
| SDK sync lag (time from change to all instances updated) | SLO: < 5s; alert if > 30s |
| Variant distribution per flag | Alert on unexpected distribution shift > 20% relative change |
| Stale flag count (age > type TTL) | Alert if count > 0 (cleanup debt accumulating) |
| Management API availability | SLO: 99.9% (SDK degrades gracefully, but new deployments need it) |

Emit a structured evaluation event for each flag check (sampled at 1% for high-volume flags):
`{ flagKey, variant, ruleMatched, tenantId, userId (opaque), timestamp }`

Flag evaluation is in-process, so latency observability focuses on SDK cache staleness and SSE propagation lag rather than evaluation call timing. Variant distribution monitoring is the primary signal for targeting rule misconfiguration — an unexpected shift > 20% indicates a rule is matching the wrong cohort. Stale flag count (flags whose age exceeds their type TTL) is a leading indicator of governance debt: each stale flag is a testing burden that compounds quarterly until cleaned up.

→ See [OBSERVABILITY.md](OBSERVABILITY.md)

---

## Team Topology

The platform team owns the flag infrastructure (management API, SSE push, SDK, audit log, schema registry) and publishes it as an X-as-a-service capability to stream-aligned teams. Stream-aligned teams own their own flags under enforced lifecycle contracts — flag creation is self-service, but TTL, owner assignment, and safe default are required fields. An experimentation enabling team provides statistical analysis capability for A/B test and model variant experiments without owning the flag platform itself.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md)

---

## Cost Analysis

The primary build vs. buy decision point is MAU volume and language footprint. LaunchDarkly is economical at small scale (fast time-to-value, multi-language SDKs included, experiment analysis built in); self-built wins at > 2M MAU or when data residency requirements prevent using a managed service.

| Option | Small (10 SDK instances, 100K MAU) | Medium (50 instances, 1M MAU) | Large (200 instances, 10M MAU) |
|--------|------------------------------------|-------------------------------|--------------------------------|
| Self-built (Node.js + Redis + PostgreSQL) | $150/mo infra + 3 wk build | $400/mo + 0.1 FTE | $900/mo + 0.1 FTE |
| LaunchDarkly | ~$400/mo | ~$2,500/mo | ~$8,000–15,000/mo |
| Flagsmith (cloud) | ~$45/mo | ~$300/mo | ~$1,000/mo |

Hidden costs frequently omitted from comparisons: flag debt cleanup (each stale flag is 2–4 hours of cleanup work), multi-language SDK maintenance (0.5–1 FTE/year for self-built), and experiment statistical analysis tooling ($0–$80K/year depending on approach).

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md)

---

## AI Integration

Feature flag infrastructure maps directly onto the challenges of safe AI model deployment:

- **Model version flags**: progressive rollout (1% → 10% → 100%) for new model versions using release flag type; same percentage rollout and sticky hashing as software features
- **Shadow mode evaluation**: flag-gated shadow inference runs the new model against live traffic with responses discarded — offline quality assessment before any user sees the new model's output
- **Kill switches for AI safety**: ops-type kill switch that instantly reverts to the previous model or rule-based fallback when a model produces harmful or degraded output; accessible to non-engineers (ML safety team, legal) without a code deploy
- **Model variant experiments**: experiment flags A/B test between model versions with statistical analysis on quality metrics (accuracy, latency, user rating) rather than engagement metrics
- **Remote configuration for inference parameters**: temperature, top-p, max_tokens, and system prompt version managed as typed remote configuration — runtime tuning without redeployment, full audit trail of every parameter change

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md)

---

## Platform Engineering

The flag platform is a paved road: a team that creates a feature flag gets lifecycle enforcement, self-service targeting rules, an immutable audit log, kill switch infrastructure, and evaluation analytics without building any of this themselves. The test of platform success is not flag adoption rate — it is whether teams have stopped building dirt roads (environment variables for A/B test control, per-service database config tables, deployment-based canary splits). Flag creation must be self-service in under 10 minutes; any flag creation that requires a platform team ticket is a platform team failure.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md)

---

## Business Case

Feature flags transform bad releases from major incidents (30–60 minute full rollbacks, wide user impact) into minor incidents (flag disabled in seconds, 1% user exposure); the break-even on investment is a single prevented major incident.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md)

---

## Diagrams

### C4 Model
- [`diagrams/c4-context.mmd`](diagrams/c4-context.mmd) — C4 system context: feature engineers, product managers, on-call engineers, application services, identity provider, observability, analytics, secrets manager
- [`diagrams/c4-container.mmd`](diagrams/c4-container.mmd) — C4 container: management API, flag config store, audit log store, SSE push service, flag state cache, in-process SDK, management UI

### Sequence and Lifecycle Diagrams
- [`diagrams/01-context.mmd`](diagrams/01-context.mmd) — System context: management plane, SSE sync, in-process SDK instances, observability
- [`diagrams/02-flag-evaluation-sequence.mmd`](diagrams/02-flag-evaluation-sequence.mmd) — Startup seed, local evaluation, background SSE sync, kill switch flow
- [`diagrams/03-flag-lifecycle-and-ops.mmd`](diagrams/03-flag-lifecycle-and-ops.mmd) — Release flag lifecycle and kill switch operational path

## ADRs
- [`adrs/ADR-001-adopt-feature-flags-and-remote-config.md`](adrs/ADR-001-adopt-feature-flags-and-remote-config.md) — Adopt feature flags and remote configuration for progressive delivery
- [`adrs/ADR-002-flag-taxonomy-and-lifecycle-policy.md`](adrs/ADR-002-flag-taxonomy-and-lifecycle-policy.md) — Four-type taxonomy with mandatory TTLs and ownership
- [`adrs/ADR-003-local-evaluation-sdk-model.md`](adrs/ADR-003-local-evaluation-sdk-model.md) — In-process SDK with local cache and SSE streaming
- [`adrs/ADR-004-targeting-rules-and-multitenancy.md`](adrs/ADR-004-targeting-rules-and-multitenancy.md) — Targeting rule evaluation order for deterministic, sticky rollouts
- [`adrs/ADR-005-observability-audit-and-cleanup-automation.md`](adrs/ADR-005-observability-audit-and-cleanup-automation.md) — Immutable audit log, evaluation metrics, and automated cleanup alerts

## Example Implementation
See [`examples/node-flagd-style/`](examples/node-flagd-style/)

Demonstrates:
- `FlagClient` with in-process cache + SSE sync
- Targeting engine evaluating rules in priority order
- Management API (Express + Redis) with SSE push on flag update
- Kill switch demo: disable a flag via API, observe all connected instances update within SLO
- Structured evaluation event logging

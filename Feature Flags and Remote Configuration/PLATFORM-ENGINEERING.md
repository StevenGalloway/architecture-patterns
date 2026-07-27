# Platform Engineering: Feature Flags and Remote Configuration

## The Problem the Platform Replaces

Before a flag platform exists, teams build their own mechanisms to control production behavior:

- **Environment variables** set per deployment for feature control (no targeting, no audit, no runtime change, no cleanup)
- **Database configuration tables** per service (no cross-service consistency, no emergency disable capability, no schema validation)
- **Hard-coded if statements** with `TODO: remove after launch` comments that are never removed
- **Deployment-based canary releases** via traffic splitting in the load balancer (infrastructure coupling, slow feedback loop, no per-user targeting)

Each of these is a "dirt road" — a local solution to a local problem that does not compose. The dirt road lacks the properties that make flag systems safe: audit trail, kill switch capability, SDK-distributed evaluation, lifecycle enforcement. A flag platform paves the road: teams get a better solution without building the infrastructure themselves.

The test of whether the platform has succeeded is not whether teams use it — it is whether teams have stopped building dirt roads. If 30% of recent feature releases use environment variables for behavior control, the platform has not succeeded even if 70% adoption looks good on a dashboard.

---

## The Paved Road: What Teams Get for Free

A team that creates a feature flag through the platform self-service portal receives the following without building any infrastructure:

| Capability | Team builds it (dirt road) | Platform provides (paved road) |
|------------|---------------------------|-------------------------------|
| Lifecycle enforcement (TTL + owner) | Manual, if at all | Automated alerts, escalation workflow |
| Self-service targeting rules | Not possible with env vars | UI + API, no ticket required |
| Immutable audit log | Not present | Every change recorded with actor and diff |
| Kill switch infrastructure | Redeploy required | SSE propagation in < 5 seconds |
| Evaluation analytics (variant distribution) | Not present | Automatic from structured evaluation events |
| Schema validation | Not present | JSON Schema enforced at write time |
| Safe default behavior | Application crashes or returns null | Defined per flag, served from in-process cache |
| Multi-language SDK | Build per language | Platform provides Go, Java, Python, Node SDKs |
| Dry-run / preview | Not possible | API returns which variant a given context would receive |

The platform does not require teams to understand SSE infrastructure, Redis topology, or audit log storage. These are implementation details of the platform, not the team's concern. The team's interface is the management API and the in-process SDK.

---

## Platform Contract

The platform team publishes and is accountable for the following service-level contracts:

| Contract | Commitment | Measurement |
|----------|-----------|-------------|
| Flag evaluation latency (in-process, p99) | ≤ 1ms | Measured at SDK level, reported in evaluation events |
| SSE propagation (change to all connected SDK instances, p95) | ≤ 5 seconds | Time from management API write to last SDK instance confirmation |
| Management API availability | 99.9% (43 min/month downtime budget) | Uptime monitoring on all write and read endpoints |
| Audit log immutability | 100% — no exceptions | Periodic verification of write-once storage configuration |
| SDK version support window | Current major + previous major | Documented deprecation timeline; at least 6 months notice |
| Stale flag alert delivery | Within 24 hours of TTL breach | Alert pipeline uptime |

**Degraded mode behavior (part of the contract):**

The management API can be unavailable without breaking production flag evaluation. The in-process SDK cache continues serving last-known-good state. Each flag's `safeDefault` is served when the cache does not contain the flag key. Teams can depend on this behavior — production services must not fail when the management API is unavailable.

What degrades: new flag changes do not propagate during management API outage. Kill switch activations are queued and apply when the API recovers. New SDK instances starting during an outage cannot seed their cache (they use all safe defaults). These behaviors are documented and expected.

---

## Self-Service Model

The flag platform is not a managed service where teams submit requests. It is infrastructure that teams drive themselves.

**Flag creation flow (no ticket required):**

1. Team engineer opens the self-service portal (or calls the management API)
2. Selects flag type (Release, Experiment, Ops, Permission)
3. Defines variants and their values
4. Sets TTL (required for Release and Experiment types; API rejects if absent)
5. Assigns owner team (required; API rejects if absent)
6. Defines safe default (required; API rejects if absent)
7. Flag is created and immediately available to SDK instances within the SSE propagation SLO

**What the platform enforces automatically:**

- TTL required for Release and Experiment flags (400 response if missing)
- Owner team required for all flag types (400 response if missing)
- Safe default required for all flag types (400 response if missing)
- PII validation on targeting rule fields (400 response on email pattern, known PII field names)
- JSON Schema validation on remote configuration values (400 response on schema violation)
- Duplicate flag key rejection (409 response)

**What the platform does not control:**

- Which variant teams assign to which cohort (targeting rule content is the team's decision)
- Whether teams create a flag for the right reason (platform enforces lifecycle contract, not flag purpose)
- Experiment design quality (the enabling team supports this; the platform does not enforce it)

---

## Anti-Patterns That Signal Platform Failure

These behaviors indicate the platform is not serving teams well. Each anti-pattern has a root cause in platform design.

### Anti-Pattern 1: Environment Variables for A/B Test Control

**Observation:** A feature team controls an A/B test by deploying two service instances with different environment variables, using a load balancer to split traffic.

**Root cause:** Flag creation requires too many steps, targeting rules are too complex to configure, or the platform team is a bottleneck for flag creation.

**Consequence:** No per-user targeting (users see different variants on different requests depending on which instance handles the request), no audit trail, no kill switch, no cleanup. The A/B test results are statistically invalid.

**Fix:** Reduce flag creation to under 5 minutes via self-service portal. Ensure the platform team does not sit in the critical path for flag creation.

---

### Anti-Pattern 2: Per-Service Database Config Tables

**Observation:** Service A has a `feature_config` table with rows like `("new_checkout_flow_enabled", "true")`. Service B has a `service_config` table with similar rows. These are managed separately, have no audit trail, and cannot be changed at runtime without a database write.

**Root cause:** The flag platform does not support the configuration use case well (only supports boolean flags, lacks remote config for typed values) or the platform is unknown to the team.

**Consequence:** Configuration drift between services, no emergency disable path without a DBA operation, no audit log, no validation.

**Fix:** Ensure the platform supports typed remote configuration (boolean, string, number, JSON) with schema validation. Broadcast the platform capability to new teams during onboarding.

---

### Anti-Pattern 3: Canary Deploys Instead of Flag Rollouts

**Observation:** Teams request a second Kubernetes deployment with 1% traffic weight for each canary release, using the load balancer to control traffic split.

**Root cause:** The flag platform's progressive delivery tooling is less convenient than the deployment pipeline's existing canary support, or teams do not understand that feature flags offer a faster feedback loop.

**Consequence:** Canary deploys are slow (deployment pipeline, not flag flip), cannot target specific users (traffic split is by request, not by user identity), and require infrastructure team involvement to configure.

**Fix:** Document the performance difference: flag rollout changes (1% → 10%) take seconds with SSE propagation and require no infrastructure change; deployment-based canary changes take minutes and require infrastructure configuration. The flag rollout is strictly faster with better targeting.

---

### Anti-Pattern 4: Flag Creation Blocked by Platform Team Queue

**Observation:** Teams submit tickets to the platform team to create flags. Average lead time is 2-3 days. Teams with urgent release needs route around the system.

**Root cause:** The platform team has made flag creation a managed operation instead of a self-service one. This may be intentional (desire for quality control) or accidental (API is complex; teams find it easier to ask the platform team).

**Consequence:** Platform becomes a bottleneck, not a paved road. Teams build dirt roads. Flag adoption stalls.

**Fix:** Platform team's job is to build the self-service portal, not to be the operator of flag creation. If the platform team is processing more than 5 flag creation requests per week via ticket, the self-service tooling is insufficient and must be improved.

---

## Developer Experience Requirements

The platform is a product with internal users. Developer experience investment is not optional.

**Required DX capabilities:**

- **Self-service portal:** Web UI for flag CRUD, targeting rule management, variant preview. Must be usable by product managers and ML safety team members, not only engineers.
- **Dry-run / preview API:** Given a user context `{ userId, tenantId, plan, attributes }`, return which variant each flag would evaluate to. Prevents targeting rule misconfiguration in production.
- **Local development mode:** SDK in local dev mode reads from a local flags file instead of the management API. Teams do not need network access to the flag system to run their service locally.
- **IDE integration (optional but high-value):** Flag key autocomplete in the IDE, inline display of current flag variants, direct link to the flag definition from the code callsite.
- **Evaluation analytics dashboard:** Per-flag view showing evaluation rate, variant distribution over time, error rate. Teams can self-diagnose targeting rule misconfiguration without asking the platform team.
- **Lifecycle dashboard:** Shows each team's flags, their age vs. TTL, and which flags are approaching or past their expiry. Teams manage their own cleanup without waiting for platform team reports.

**The platform team's success metric:** Teams should be able to go from "I need a feature flag" to "flag is live in production with targeting rules" in under 10 minutes, without assistance from the platform team.

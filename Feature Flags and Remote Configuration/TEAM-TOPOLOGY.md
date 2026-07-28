# Team Topology: Feature Flags and Remote Configuration

## Overview

Feature flag systems exist at the intersection of infrastructure and product delivery. The team structure around the flag platform determines whether flags accelerate experimentation velocity or become a governance theater artifact that teams route around with environment variables and database tables.

The central ownership question is not "who builds the flag system?" — it is "who owns flag lifecycle?" Flags without a named owner rot. A release flag created for a sprint with no owner field is a flag that will still be in the codebase twelve months later, doubling test matrix complexity and quietly gating behavior that no one remembers.

---

## Team Types and Responsibilities

### Platform Team: Flag Infrastructure

The platform team owns the shared infrastructure that all stream-aligned teams consume as a service.

**Owns:**
- Management API (flag CRUD, targeting rule validation, RBAC)
- SSE push infrastructure (flag state streaming to SDK instances)
- In-process SDK (released as a versioned library per language runtime)
- Redis flag state cache (hot cache serving SSE broadcasts)
- Audit log pipeline (immutable write-once storage, SIEM export)
- JSON Schema registry (validation contracts for remote configuration values)
- Self-service portal (UI for flag creation, targeting rule management, lifecycle dashboard)
- Automated lifecycle tooling (TTL enforcement alerts, stale flag reporting, cleanup automation)

**Does not own:**
- Individual flag definitions (those belong to the team that creates them)
- Targeting rule decisions (which cohort gets which variant is a product/feature team decision)
- Experiment design (A/B test design belongs to the experimentation/growth team)

**Interaction mode with stream-aligned teams:** X-as-a-service. Stream-aligned teams consume the platform via management API or UI without needing to understand SSE infrastructure or Redis topology. The platform team's SLOs define the service contract.

**Platform SLOs the team is accountable for:**
| Contract | Target |
|----------|--------|
| Flag evaluation latency (in-process) | p99 ≤ 1ms |
| SSE propagation (change to all SDK instances) | p95 ≤ 5s |
| Management API availability | 99.9% |
| Audit log immutability | 100% (no exceptions) |
| SDK version support window | Current + 1 major version |

---

### Stream-Aligned Teams: Flag Ownership

Each product or feature team owns the flags it creates. Ownership is assigned at flag creation and stored in the flag definition. It is not transferable without an explicit ownership transfer in the audit log.

**Owns:**
- Flag definitions within their service domain
- Targeting rule decisions (which cohort, what percentage, what tenant)
- Flag cleanup (removal of release flags after code path is stable, removal of experiment flags after analysis)
- Safe default definitions (what does the flag evaluate to when the SDK cache is stale?)
- Instrumentation (the team's service emits evaluation events; the platform provides the SDK, not the business-logic telemetry)

**Does not own:**
- SSE infrastructure
- SDK internals
- Audit log storage

**Flag lifecycle contract teams must honor:**

| Flag Type | TTL | Cleanup Obligation |
|-----------|-----|-------------------|
| Release | 30 days | Code path merged or removed; flag deleted |
| Experiment | 90 days | Winning variant shipped; losing variant removed; flag deleted |
| Ops / Kill Switch | Permanent | Annual review; documented justification for retention |
| Permission | Permanent | Annual review; entitlement model governs |

Automated enforcement: platform sends a staleness alert to the flag owner's team channel when a flag exceeds its type TTL. After 14 days without cleanup action, flag is escalated to team lead. After 30 days, platform team adds it to the tech debt dashboard.

---

### Enabling Team: Experimentation / Growth

In organizations that run a high volume of product experiments, an enabling team provides statistical analysis expertise that stream-aligned teams lack.

**Provides:**
- Experiment design review (sample size calculation, primary metric selection, guardrail metrics)
- Statistical analysis infrastructure (connects to evaluation event stream, computes significance)
- Result interpretation support (avoiding multiple comparison problems, novelty effects, SRM detection)
- Training on experiment flag usage patterns

**Interaction mode with stream-aligned teams:** Collaboration. The enabling team embeds temporarily into a stream-aligned team for experiment design, then steps back. It does not own experiment flags — the stream-aligned team does.

**What this team does not do:** Operate the flag platform (that is the platform team). Write feature code. Own experiment results beyond the analysis window.

---

## Conway's Law Analysis

The flag platform architecture must match the organizational structure, or teams will build around it.

### Failure Mode: Centralized Flag Control

**Structure:** A single DevOps or platform team controls all flag creation. Stream-aligned teams submit tickets to create flags.

**Result:**
- Release flags for 12 feature teams require DevOps tickets — average lead time: 2-3 days
- Experiment flags blocked behind a queue → product teams stop running experiments
- Teams route around the flag system: environment variables for feature control, database tables per service for configuration, hard-coded if statements with TODO comments
- Flag system becomes a governance artifact used for compliance appearances while real feature control happens in unaudited environment config

**Signal that this failure mode is occurring:** Flag creation tickets represent more than 5% of platform team's workload. More than 20% of recently shipped features used environment variables for feature control rather than flags.

---

### Failure Mode: Unlimited Self-Service with No Governance

**Structure:** Teams create unlimited flags with no TTL enforcement, no ownership requirement, no cleanup obligation.

**Result:**
- Flag count crosses 200 within 18 months of platform adoption
- 40-60% of flags are stale (no evaluations in 30+ days but still in codebase)
- SDK cache size grows; startup initialization time increases
- Testing matrix explodes — 50 active release flags means 2^50 theoretical code path combinations
- No one will delete a flag they didn't create; accumulation is irreversible without a dedicated cleanup effort

**Signal that this failure mode is occurring:** Stale flag count > 15% of total flags. Engineers report uncertainty about whether a flag is safe to delete. SDK initialization time increases quarter over quarter.

---

### Correct Model: Self-Service Within Enforced Lifecycle Contracts

Teams create flags without a ticket. The platform enforces the lifecycle contract automatically.

- Flag creation requires: type selection, TTL (required for Release/Experiment types), owner team assignment, safe default value
- Platform rejects flags that do not satisfy the schema (missing TTL for Release type = API returns 400)
- Teams are accountable for their own flags; platform team is accountable for the infrastructure
- Enabling team supports experiment quality without blocking flag creation

This model scales because governance is encoded in the platform, not dependent on human review queues.

---

## Scaling Model by Organization Size

### 1–3 Teams (Early Stage)

- **Structure:** Informal. One or two engineers own the flag infrastructure as a side responsibility.
- **Flag governance:** Informal cleanup. One person knows the history of every flag.
- **Risk:** When the team grows past 5 engineers, institutional knowledge of flag history becomes a liability. Start enforcing owner field and TTL now, before scale makes it impossible to retrofit.
- **Recommendation:** Use a managed service (LaunchDarkly, Flagsmith) rather than building. Engineering time is better spent on product.

### 4–10 Teams (Growth Stage)

- **Structure:** Dedicated platform team owns flag infrastructure (typically embedded in a larger platform/DevEx team). Each product team owns its own flags.
- **Flag governance:** TTL enforcement via automated alerts. Stale flag reports delivered to team channels weekly. Quarterly cleanup sprint.
- **Risk:** Experimentation team doesn't exist yet; experiment design quality is inconsistent. Statistical validity of A/B results is uncertain.
- **Recommendation:** Build or adopt a self-service portal. Define the lifecycle contract formally. Hire or designate one person as the experimentation design resource (even part-time).

### 10+ Teams (Enterprise Scale)

- **Structure:** Dedicated platform team (3–5 engineers). Stream-aligned teams fully self-serve. Dedicated experimentation team (2–4 data scientists + growth engineers).
- **Flag governance:** Automated lifecycle enforcement with escalation workflows. Self-service portal with analytics dashboard showing evaluation volume, variant distribution, flag age. Compliance reporting (SOC 2 audit log exports, stale flag SLA tracking).
- **Risk:** Platform becomes a bottleneck if it does not invest in self-service tooling. Teams will build shadow flag systems in their own services.
- **Recommendation:** Invest in developer experience around the flag platform. The self-service portal, preview/dry-run tooling, and IDE integrations are as important as the flag evaluation infrastructure itself.

---

## Interaction Mode Summary

```
Platform Team ──────(X-as-a-Service)──────► Stream-Aligned Team A
     │                                        (owns flags A1, A2, A3)
     │           ──────(X-as-a-Service)──────► Stream-Aligned Team B
     │                                        (owns flags B1, B2)
     │           ──────(X-as-a-Service)──────► Stream-Aligned Team C
     │                                        (owns flags C1, C2, C3, C4)
     │
Enabling Team ───(Collaboration)──────────► Stream-Aligned Teams
(Experimentation)                           (for experiment design
                                             and statistical analysis)
```

The platform team never collaborates on individual flag content decisions. The enabling team never owns flag infrastructure. Stream-aligned teams never build their own flag systems.

# Team Topology — API Gateway Pattern

## Who Owns the Gateway?

The API Gateway is a **platform team** asset. It provides cross-cutting capabilities — auth, rate limiting, routing, observability — that stream-aligned teams consume but should not rebuild individually.

This matters because the ownership model directly determines whether the gateway accelerates or blocks delivery.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | Gateway infrastructure, HA, upgrades, baseline policies, developer tooling |
| **Security** | Enabling team | Auth policy standards, JWT requirements, WAF rule review |
| **Stream-aligned teams** | Stream-aligned | Route registration, upstream service SLOs, traffic contract ownership |

The gateway itself belongs to the platform team. Route configurations for individual services belong to the stream-aligned team that owns that service.

---

## Conway's Law Implications

The gateway's routing table is a mirror of your team structure. Nine services with nine teams produces nine routing rules, nine sets of upstream health requirements, and nine sources of config drift if the process isn't self-service.

**What the org structure predicts about your gateway:**

- **Centralized platform team owns all config** → Every new service route requires a platform team ticket. Delivery velocity dies at ~6 services. Platform team becomes a permanent bottleneck and starts saying no to things they don't understand.
- **Stream-aligned teams own all config with no governance** → Config sprawl, inconsistent rate limit policies, undocumented routes, gateway becomes unauditable.
- **Hybrid: platform team owns infrastructure + policy templates; stream-aligned teams own route declarations via PR** → Scales. Teams are autonomous within guardrails. This is the recommended model.

The hybrid model requires the platform team to invest in making self-service safe: schema validation on route configs, automated policy checks in CI, a staging gateway environment for teams to test against.

---

## Failure Mode: Org Mismatch

The most common failure pattern: the gateway starts as a platform asset but gradually accumulates business logic (request body transforms, aggregation calls, conditional routing based on user tier). Each addition made sense locally. Collectively, they mean the platform team now owns code it doesn't understand and stream-aligned teams can't release without a platform team review.

**Signal to watch for:** Any PR to the gateway that touches request or response body content rather than headers and routing rules. This is where business logic leaks in. A review gate on this class of change, enforced in CI, prevents the drift.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform team → stream-aligned | **X-as-a-service** | Teams consume routing, auth, and rate limiting as a platform service. No direct collaboration required for standard use. |
| Security → platform team | **Enabling** | Security team sets standards (JWT requirements, WAF rules, audit logging schema) that platform team implements. Quarterly review cycle. |
| Stream-aligned → platform team | **Collaboration** | Required only for non-standard needs: custom auth flows, protocol translation, new rate limit tiers. Time-box these to prevent dependency. |

---

## Cognitive Load Considerations

The gateway concentrates risk. A misconfigured route or policy rule affects all clients simultaneously. This creates cognitive load on the platform team disproportionate to the size of the codebase.

Mitigations:
- Route configs are declarative (YAML/JSON), not imperative code. Reduces the expertise required to own a route.
- Automated validation catches most config errors before they reach production.
- Canary deployment for all gateway config changes (see `diagrams/03-deploy-release-canary.mmd`).
- Runbook for every failure mode in `README.md` means incident response doesn't require a senior engineer.

---

## Scaling the Team Model

| Scale | Recommended model |
|---|---|
| 1–5 services, 1–2 teams | One team owns everything. Gateway is low complexity. |
| 6–15 services, 3–8 teams | Platform team owns gateway infra + policy. Stream-aligned teams own route config via PR with CI validation. |
| 15+ services, 8+ teams | Self-service gateway portal or GitOps pipeline. Route registration is fully automated. Platform team owns the platform, not individual routes. |

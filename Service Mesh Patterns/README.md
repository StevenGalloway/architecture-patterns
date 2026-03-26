# Service Mesh Pattern

## Summary
A **Service Mesh** provides a dedicated infrastructure layer for **service-to-service communication** in microservice environments.
It typically delivers consistent, platform-level capabilities without requiring each application to re-implement them:

- **mTLS** between services (identity + encryption in transit)
- **Traffic policy**: retries, timeouts, load balancing, rate limits
- **Traffic shaping**: splits, mirroring, canaries (mesh-level routing)
- **Observability**: golden signals (RPS, errors, latency, saturation), topology graphs, per-route metrics
- **Policy**: identity-based authorization (mesh-dependent)

A mesh is often implemented via **sidecar proxies** injected into pods. The app talks over localhost; the sidecar handles networking concerns.

---

## Problem
In a microservices architecture, each team tends to solve cross-cutting networking concerns differently:
- inconsistent retries and timeouts
- uneven TLS standards and certificate management
- brittle, duplicated instrumentation
- hard-to-debug inter-service failures
- high operational toil during incidents (no shared view of dependencies)

---

## Constraints & Forces
- You must balance **platform control** vs **app autonomy**
- Sidecars increase resource usage (CPU/mem) and operational surface area
- Policy and observability need consistent naming and route definitions
- Not all features are free: traffic splitting/mirroring may require mesh add-ons

---

## Solution
Deploy a mesh to standardize the “service-to-service” layer:
1) **Inject sidecars** into workloads (automatic or per-namespace)
2) Enable **mTLS** by default and use service identities
3) Define **route-level policy** (timeouts, retries) via mesh resources
4) Use mesh telemetry for **dependency graphs** and golden signals
5) Apply **traffic shaping** (splits) to reduce rollout risk and support progressive delivery

---

## When to Use
- Many microservices with frequent inter-service calls
- Teams need consistent security and operational standards
- SRE/platform teams can own shared networking policy
- You need visibility into “east-west” traffic and dependencies

## When Not to Use (or be careful)
- Very small systems (mesh overhead may exceed benefits)
- Latency-sensitive systems with extremely tight budgets (measure proxy cost)
- Organizations without platform ownership (mesh needs strong operational discipline)

---

## Tradeoffs
### Benefits
- consistent mTLS and identity across services
- centralized policy (timeouts/retries) without app code
- rich telemetry and topology visibility
- supports safer changes via traffic shaping

### Costs / Risks
- operational complexity (mesh lifecycle, upgrades, certs)
- sidecar resource overhead
- debugging requires mesh fluency
- misconfigured retries/timeouts can amplify incidents (retry storms)

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-request-path-sidecar.mmd`
- `diagrams/03-traffic-split-and-observability.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-service-mesh.md`
- `adrs/ADR-002-linkerd-vs-istio.md`
- `adrs/ADR-003-mtls-by-default.md`
- `adrs/ADR-004-route-policy-retries-timeouts.md`
- `adrs/ADR-005-operational-ownership-and-slos.md`

---

## Example (Different Tech)
This example uses **Kubernetes + Linkerd** with apps written in **Bun (TypeScript)**:
- `frontend` calls `backend` through mesh sidecars
- **ServiceProfile** configures retries and timeouts for routes
- **TrafficSplit** demonstrates 90/10 split between backend v1 and v2
- Docs include commands to view mesh metrics and topology

See: `examples/kubernetes-linkerd-bun/`.

> Note: the manifests assume Linkerd is installed in the cluster. The included scripts provide a quickstart for Kind and guidance for installing Linkerd.

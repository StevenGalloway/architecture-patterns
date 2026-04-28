# ADR-002: Use traffic splitting at the ingress/gateway layer

## Status
Accepted

## Date
2025-07-16

## Context
Once canary releases were adopted as the deployment strategy (ADR-001), we needed to decide where in the request path traffic splitting would occur. The options were: at the ingress/load balancer layer (before requests reach service instances), at the application layer (inside the service code), or at the service mesh layer (in sidecar proxies).

The first attempt at traffic splitting was application-layer: the service itself inspected a header injected by the deployment system and used it to route to the canary code path. This worked functionally but created a problem: the "canary" and "stable" code paths were running in the same process. If the canary code path had a memory leak or a deadlock, it affected the stable code path's process resources. The blast radius was 100% of the pod, not 5% of traffic.

True canary isolation requires the canary version to run in separate pods or instances from the stable version, with traffic split between the two replica sets. That split must happen before requests reach any instance, which means it belongs at the ingress layer.

## Decision
Traffic splitting for canary deployments is implemented at the ingress layer using Argo Rollouts with the NGINX ingress controller. Argo Rollouts manages the canary and stable replica sets as distinct deployments and controls the traffic weight by updating the ingress canary annotation (`nginx.ingress.kubernetes.io/canary-weight`) at each rollout step.

The rollout configuration specifies:
- Canary replica count: 2 pods minimum during canary phase (to avoid single-pod noise in metrics)
- Stable replica count: unchanged from pre-deployment count
- Traffic weight progression: 5% → 20% → 50% → 100%
- Pause duration between steps: 15 minutes (configurable per service)

Header-based routing is supported for testing: requests with the header `X-Canary: true` are always routed to the canary replica set regardless of traffic weight, allowing QA to validate the canary version directly.

## Alternatives Considered

**Application-layer traffic splitting (code-based routing):** The service code routes requests to canary or stable behavior based on a header or feature flag. Rejected because it does not provide true process isolation between canary and stable behavior; a canary bug affects the entire pod rather than only canary traffic.

**Service mesh traffic splitting (Istio VirtualService):** Istio's VirtualService resource manages traffic weight between canary and stable Kubernetes services. This is a valid approach but rejected for the initial implementation because the team does not yet have an Istio installation. The NGINX ingress approach achieves the same traffic splitting with the infrastructure already in place. This decision is revisited in the Review Trigger.

**DNS-level routing (weighted DNS records):** Separate canary and stable service endpoints at the DNS level, with weighted DNS records directing a fraction of traffic to the canary endpoint. Rejected because DNS-level routing has TTL propagation delays that make rapid weight adjustments (needed for fast rollback) unreliable. A 5-minute DNS TTL means a rollback weight change takes up to 5 minutes to propagate globally.

## Consequences

### Positive
- Canary pods are fully isolated from stable pods; a crash, memory leak, or performance regression in the canary only affects the traffic percentage routed to canary pods
- Traffic weight changes take effect immediately when ingress annotations are updated, enabling fast rollback (under 30 seconds to drop canary weight to 0%)
- Header-based canary routing allows the QA team to validate the canary version with production data without waiting for organic traffic to reach it

### Negative
- Requires Argo Rollouts (or equivalent) to be installed and maintained as part of the platform; services cannot do independent canary deployments without platform tooling support
- The minimum 2-pod canary requirement means each canary deployment consumes additional cluster resources; at high deployment frequency this adds to cluster resource costs

### Risks
- **Ingress controller version compatibility.** Canary weight annotations have changed syntax between NGINX ingress controller versions. Mitigation: the platform team pins the ingress controller version and validates canary behavior in a staging environment before upgrading.

## Review Trigger
Revisit when the team deploys Istio or Linkerd service mesh, which provides traffic splitting at the sidecar layer with richer routing capabilities (header-based routing, fault injection, retries) without requiring ingress annotation management.

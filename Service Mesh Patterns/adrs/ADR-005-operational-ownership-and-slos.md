# ADR-005: Establish platform ownership and SLOs for the mesh

## Status
Accepted

## Date
2026-03-18

## Context
The service mesh is shared infrastructure that affects every service enrolled in it. A mesh control plane outage or misconfiguration has blast radius proportional to the number of enrolled services. Unlike a single-service outage, a mesh failure can simultaneously affect all east-west communication across the entire platform.

This blast radius requires clear ownership and operational accountability that differs from how individual service ownership works. The mesh spans team boundaries: the Orders team, the Fulfillment team, and the Platform team all have services enrolled. When a mesh-related incident occurs, ambiguity about who owns the mesh leads to slow triage.

An incident in the second month of mesh operation demonstrated this: a Linkerd control plane issue caused certificate rotation to fail silently. Leaf certificates for three services expired. Those services started refusing incoming connections from other services (correctly, because the certificates were expired). The services' health checks were passing (HTTP 200 from the health endpoint). The connection failures appeared as network errors in the calling services, which initially investigated their own code for the root cause. It took 45 minutes to identify that the issue was the mesh control plane, not the calling services' code. During that time, three different teams were independently investigating the same root cause.

## Decision
**Platform team ownership (SRE):**
- Linkerd control plane lifecycle: upgrades, patch deployments, rollback procedures
- Trust anchor (root CA) certificate rotation
- Mesh observability infrastructure (Prometheus metrics collection, Grafana dashboards for mesh golden signals)
- Incident response for control plane failures and certificate issues
- Defined on-call rotation for mesh infrastructure alerts

**Service team ownership:**
- ServiceProfile definitions for their own service routes (timeouts, retry opt-in)
- Service-level SLOs and error budgets (defined using mesh metrics where appropriate)
- Mesh enrollment of new services (guided by platform team documentation)

**Platform SLOs for the mesh:**
- Control plane availability: 99.9% (measured as the percentage of time the destination and identity components are healthy and accepting traffic)
- Certificate rotation success rate: 100% of leaf certificate rotations must complete before certificate expiry; an alert fires when a certificate is within 6 hours of expiry
- Dataplane latency overhead: the mesh proxy must add less than 3ms p99 to service-to-service calls; an alert fires if measured overhead exceeds this threshold for any service pair

**Escalation path:** A mesh-related incident that cannot be resolved by the on-call engineer within 30 minutes is escalated to the platform team lead, with a pre-written incident template that includes: which services are affected, what the mesh metrics show for the affected routes, and the control plane health status.

**Responsibility matrix:** A published RACI document distinguishes mesh infrastructure (Platform) from application traffic policy (service teams). This document is linked from the incident response runbook and is reviewed quarterly.

## Alternatives Considered

**Each service team owns their own mesh configuration (no central platform ownership):** Service teams are responsible for their own ServiceProfiles and for understanding the mesh control plane when issues occur. Rejected because the control plane is not service-specific; a control plane issue affects all services simultaneously and requires someone with platform-wide context to diagnose.

**Shared ownership (all teams share mesh operations responsibility):** All teams contribute to mesh on-call rotations and all teams are expected to have mesh operational knowledge. Rejected because acquiring mesh operational expertise (control plane internals, certificate management, Linkerd-specific debugging) across all teams dilutes the depth of expertise. The platform team maintains deep mesh expertise and all other teams benefit from it without needing to maintain it themselves.

**Third-party managed mesh (SaaS service mesh):** Offload mesh operations to a managed service provider. No internal team owns the control plane. Rejected because a managed mesh adds vendor dependency and data governance complexity (all inter-service traffic metadata flows through the managed service). Self-operated mesh provides full visibility and control.

## Consequences

### Positive
- The 45-minute certificate expiry diagnosis time would be reduced significantly with clear ownership: the on-call engineer has a defined escalation path and the platform team has the tools and runbooks to diagnose control plane issues
- Platform-level SLOs for the mesh provide measurable accountability for the platform team's infrastructure reliability commitment
- Service teams have clear boundaries: they own their ServiceProfiles but do not need to understand control plane internals

### Negative
- The platform team's on-call rotation covers mesh infrastructure in addition to other platform responsibilities; mesh incidents add to their paging load
- Service teams may be less motivated to understand mesh behavior if all mesh issues are escalated to the platform team, creating dependency

### Risks
- **Platform team key-person risk.** If the platform team has only one engineer with deep Linkerd knowledge, that engineer's absence creates an operational gap for complex mesh incidents. Mitigation: mesh operational knowledge is documented in runbooks and at least two platform team engineers are required to be trained on Linkerd control plane operations before the mesh is considered fully operational.

## Review Trigger
Revisit the ownership model if the number of services enrolled in the mesh grows beyond 50, at which point the platform team's capacity to support mesh operations for all teams may require additional staffing or a more distributed operational model.

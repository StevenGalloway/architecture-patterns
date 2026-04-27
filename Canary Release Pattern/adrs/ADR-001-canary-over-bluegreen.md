# ADR-001: Prefer Canary releases over Blue/Green for high-traffic services

## Status
Accepted

## Date
2025-05-07

## Context
Our deployment frequency for the Orders service had reached 8-12 deployments per week by the time this decision was made. At that cadence, we needed a deployment strategy that could validate changes against real production traffic without requiring human approval at each step and without committing the full user base to a change before its behavior in production was confirmed.

The previous approach was blue/green deployment: a full parallel environment was spun up with the new version, a health check was run, and traffic was cut over 100% in a single step. This worked well for validating infrastructure correctness (does the new version start, does it pass health checks) but it provided no protection against changes that were functionally correct but degraded user experience at scale. One deployment that introduced a 40ms regression in a key database query passed all health checks -- the regression only appeared under production query volume and distribution, which the pre-cutover health check did not replicate. The 40ms regression was live for 22 minutes before it was detected and rolled back.

We needed a deployment strategy that allowed us to expose a small percentage of real traffic to the new version, observe its behavior under realistic load, and promote or abort based on measured outcomes rather than pre-deployment validation.

## Decision
Use **Canary releases** as the default deployment strategy for all high-traffic services (those receiving more than 100 requests per second in production). Canary rollouts follow a progressive traffic shifting schedule: 5% → 20% → 50% → 100%, with an analysis interval at each step.

Blue/Green deployments are retained for specific use cases:
- Deployments that require testing the full production environment configuration before any traffic is served (e.g., database migration validations)
- Deployments to low-traffic services where canary sample sizes would be too small to produce statistically meaningful analysis results

## Alternatives Considered

**Blue/Green for all deployments:** Simple operational model: two environments, cutover on approval. Rejected for high-traffic services because the 40ms regression incident demonstrated that 100% cutover provides no progressive blast radius reduction and no production-traffic validation before full exposure.

**Feature flags as the primary deployment safety mechanism:** Deploy new code to all instances simultaneously, but gate the new behavior behind a feature flag. Gradually increase the flag rollout percentage. Rejected as the sole deployment mechanism because feature flags validate behavior but not infrastructure concerns (memory usage, connection pool exhaustion, startup time). A canary deployment validates both the behavior and the infrastructure characteristics of the new version.

**Manual canary with operator-controlled traffic shifts:** An operator manually adjusts the traffic weight at each step and decides whether to proceed based on dashboard review. Rejected in favor of automated analysis because manual canary introduces human latency at each step (deployments take hours instead of minutes) and creates inconsistent decisions when different operators apply different judgment standards to the same metrics.

## Consequences

### Positive
- A regression affecting canary traffic (5% of users) is detectable and rollback-able before it affects the remaining 95%
- The progressive promotion schedule provides a natural forcing function for monitoring: teams must define what success looks like (the analysis contract) before deploying
- Automated promotion reduces deployment ceremony; a healthy canary progresses to full traffic without manual steps

### Negative
- Canary deployments require traffic splitting infrastructure and analysis automation, which adds operational complexity compared to blue/green
- During a canary rollout, two versions of the service are running simultaneously; any behavior that is incompatible between versions (e.g., different interpretations of a shared cache key format) can cause correctness issues for the subset of requests that interact with both versions

### Risks
- **Version incompatibility during the canary window.** If the new version changes a message format or cache key structure, requests routed to the old version may misinterpret data written by the new version and vice versa. Mitigation: schema changes must be backward and forward compatible before canary deployment; incompatible changes require a two-phase deployment (deploy compatibility first, then the feature).

## Review Trigger
Revisit if the team moves to a service mesh that provides native canary capabilities at the sidecar level, which would reduce the dependency on ingress-layer traffic splitting. Also revisit if the deployment frequency decreases significantly, at which point the overhead of canary infrastructure may not be justified.

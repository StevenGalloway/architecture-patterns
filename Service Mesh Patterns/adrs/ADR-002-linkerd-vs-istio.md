# ADR-002: Choose Linkerd for a lightweight, operationally simple mesh

## Status
Accepted

## Date
2025-10-01

## Context
After deciding to adopt a service mesh (ADR-001), the mesh implementation choice was evaluated. The two primary candidates were Istio and Linkerd. A third option, Consul Connect, was evaluated briefly but rejected early because the team has no existing HashiCorp infrastructure investment and Consul Connect's primary strength (service discovery integration) was not a gap in our Kubernetes-based setup.

The team ran a two-week proof of concept with both Istio and Linkerd on a staging environment with 5 services enrolled. The evaluation criteria were:

**Operational complexity:** How much ongoing operational work is required to maintain, upgrade, and troubleshoot the mesh?

**Sidecar overhead:** What is the CPU and memory overhead per service pod, and what is the added network latency per call?

**Default security posture:** How much configuration is required to achieve mTLS for all enrolled services?

**Team operational capability:** Does the team have the expertise to operate this mesh at the level required, or would it require significant new training?

## Decision
Select **Linkerd** as the service mesh for the platform.

Reasons specific to this choice:

**Operational simplicity:** Linkerd's control plane is 3 components (destination, identity, proxy-injector). Istio's control plane has more configuration surface area (VirtualService, DestinationRule, PeerAuthentication, AuthorizationPolicy, etc.). In the proof of concept, the Linkerd installation was operational in 45 minutes for the first 5 services; the Istio equivalent took 3 hours including policy configuration.

**Sidecar overhead:** Linkerd's Rust-based proxy (linkerd2-proxy) measured at 4MB memory and under 0.5ms added latency per call in load testing. Istio's Envoy proxy measured at 40MB memory and 0.8ms added latency per call. At 18 services × 3 pods each, the memory difference is (40MB - 4MB) × 54 pods = approximately 2GB additional memory cluster-wide.

**Automatic mTLS:** Linkerd enables mTLS by default for all meshed services without any policy configuration. Istio requires PeerAuthentication policies to be applied per namespace to enforce mTLS; the default (PERMISSIVE mode) accepts both TLS and plaintext. In the Istio proof of concept, two services communicated in plaintext for 30 minutes before the PeerAuthentication policy was applied.

**Evaluation of trade-offs:** Linkerd does not support advanced L7 traffic management (traffic splitting by header, fault injection, gRPC-specific routing) at the same level as Istio. These capabilities were evaluated against current and near-term requirements: they are not needed for the current 18-service deployment. The trade-off of fewer advanced features for significantly lower operational overhead is appropriate for the current team size and capability.

## Alternatives Considered

**Istio:** The most widely deployed service mesh with the largest ecosystem and most advanced L7 capabilities. Rejected as the primary choice because the operational complexity was substantially higher than Linkerd in the proof of concept, and the advanced capabilities it provides are not currently required. Revisit if advanced traffic management (A/B testing at the mesh layer, gRPC load balancing, WASM-based policy) becomes a requirement.

**Consul Connect:** HashiCorp's service mesh, tightly integrated with Consul for service discovery. Rejected because we use Kubernetes DNS for service discovery, not Consul, and Consul Connect's primary differentiator (Consul integration) does not apply to our setup. The proof of concept was not run for Consul Connect.

**AWS App Mesh:** AWS-managed service mesh integrated with ECS and EKS. Rejected because our Kubernetes cluster runs on-premises, not on AWS. App Mesh is tightly coupled to AWS infrastructure and would require AWS-specific configuration that is incompatible with our on-premises cluster.

## Consequences

### Positive
- The 45-minute time-to-operational for Linkerd (vs. 3 hours for Istio) translates to faster enrollment of the remaining 13 services and lower operational burden for platform team
- Automatic mTLS without explicit policy configuration prevents the "accidentally operating in plaintext" failure mode seen in the Istio proof of concept
- Lower per-pod memory overhead means the cluster does not require capacity expansion for mesh overhead

### Negative
- Advanced L7 capabilities (traffic splitting by header, gRPC-specific routing) are not available in Linkerd at the same level as Istio; use cases that require these features need a separate solution
- Linkerd's smaller ecosystem means fewer third-party integrations and less community documentation than Istio for edge cases

### Risks
- **Future requirement mismatch.** A future requirement that genuinely needs Istio's advanced capabilities (e.g., canary deployments at the mesh layer with header-based routing) would require migrating from Linkerd to Istio, which is a significant operational undertaking. Mitigation: the Review Trigger is set to evaluate this explicitly if such requirements emerge.

## Review Trigger
Revisit the Linkerd vs. Istio choice if a production use case requires L7 traffic management capabilities (weighted routing, fault injection, header-based routing, gRPC traffic management) that Linkerd cannot provide. Document the specific requirement before initiating the evaluation.

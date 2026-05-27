# ADR-003: Enforce mTLS-by-default for meshed workloads

## Status
Accepted

## Date
2025-11-26

## Context
One of the primary motivations for adopting the service mesh was to eliminate plaintext inter-service communication. The penetration test had identified that internal network traffic was observable because services communicated over HTTP without TLS, and authentication tokens passed in headers were visible to any process with network access to the pod's network namespace.

The enforcement question was how strictly to apply mTLS. A permissive approach would allow services to accept both TLS and plaintext connections, ensuring backward compatibility during the mesh rollout. A strict approach would reject plaintext connections and require all communicating services to be meshed.

The permissive approach was piloted for the first 8 weeks of mesh enrollment. During that period, the penetration test identified that two services were still communicating in plaintext because a developer had misconfigured the sidecar injection annotation. The permissive mode accepted these plaintext connections without warning. The services were enrolled in the mesh (the sidecar was injected) but the mTLS was not being used because the client service was not configured to use TLS. In permissive mode, this is a silent failure: both services appear healthy and the connection works, but it is not encrypted.

## Decision
Linkerd's mTLS is **enabled by default** for all services enrolled in the mesh. No application configuration is required; the Linkerd sidecar proxy handles certificate provisioning, rotation, and mTLS enforcement automatically.

Linkerd operates in **strict mode** for meshed workloads: traffic between two meshed services is always mTLS. There is no permissive mode that accepts plaintext. If a service is not yet meshed (no sidecar proxy), it communicates with meshed services in plaintext -- this is expected during the rollout window and is acceptable until enrollment is complete.

**Service identity:** Each service's identity in mTLS is derived from its Kubernetes service account. The Linkerd control plane (identity component) issues certificates bound to service account identities. An authorization policy that says "only the Orders service may call the Inventory service" is expressed in terms of service account identities, not IP addresses or service names.

**Certificate rotation:** Linkerd automatically rotates leaf certificates every 24 hours. Root certificate rotation follows the platform team's CA rotation schedule (annually). Certificate expiry alerts fire 30 days before root certificate expiry.

**Non-meshed traffic:** Services that are not enrolled in the mesh (e.g., a legacy job that has not yet been migrated to the current pod template) communicate with meshed services in plaintext. These connections are visible in Linkerd's traffic metrics as plaintext connections. The platform team tracks a "mesh enrollment completion" metric and alerts when non-meshed traffic exceeds 5% of total inter-service traffic.

## Alternatives Considered

**Permissive mTLS (accept both TLS and plaintext):** Services in the mesh accept both mTLS and plaintext connections during the rollout period, transitioning to strict mode after all services are enrolled. Rejected after the proof of concept demonstrated that permissive mode silently accepts misconfigured plaintext connections. A service that is enrolled in the mesh but has a sidecar configuration issue should fail noisily so the issue is detected, not silently fall back to plaintext.

**Application-managed TLS (services manage their own certificates):** Services handle TLS certificate management using a shared library or Vault's PKI secrets engine. Rejected because this approach was in place for 8 of the 18 services before the mesh, and certificate expiry caused two incidents in one quarter. Automatic certificate management by the mesh proxy removes the operational burden from application teams.

**Network-level encryption only (IPSec or WireGuard):** Encrypt all traffic at the network layer using node-to-node encryption, without application or service-level certificate management. Provides confidentiality but not mutual authentication: any service can communicate with any other service without demonstrating its identity. Rejected because the authorization use case (only Orders may call Inventory) requires service-level identity that network-level encryption does not provide.

## Consequences

### Positive
- All inter-service communication between meshed services is encrypted and mutually authenticated from the day of enrollment, with no application code changes required
- Certificate expiry incidents are eliminated for meshed services; automatic rotation means certificates never expire without renewal
- Authorization policies based on service account identity provide a stronger trust model than IP-based allowlists (IPs change; service identities are stable across pod restarts and scaling events)

### Negative
- Non-meshed services communicating with meshed services are visible as plaintext connections in metrics, creating a visible security gap during the enrollment period
- The strict mTLS mode means that a service with a sidecar injection issue fails to communicate with other meshed services, causing a hard failure rather than a degraded plaintext connection; this is intentional but requires rapid incident response capability

### Risks
- **Root certificate expiry.** If the root CA certificate expires without rotation, all leaf certificates issued by that root become untrusted and all meshed service-to-service communication fails simultaneously. Mitigation: automated 30-day warning alert before root CA expiry; the CA rotation runbook is tested annually.

## Review Trigger
Revisit the authorization policy model if the team needs cross-cluster service communication (services in different Kubernetes clusters communicating via mesh), which may require a multi-cluster mTLS configuration not yet evaluated.

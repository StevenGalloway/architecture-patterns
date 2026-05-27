# ADR-001: Adopt a Service Mesh for east-west traffic

## Status
Accepted

## Date
2025-07-23

## Context
The microservices platform had grown to 18 services communicating over east-west (service-to-service) HTTP and gRPC connections. Four operational problems had accumulated over the preceding year:

**Inconsistent service-to-service security:** Eight services used TLS for inter-service calls; ten used plaintext HTTP on the internal network, operating under the assumption that the internal network was trusted. A penetration test identified that compromising any node in the cluster would allow passive observation of unencrypted service-to-service traffic, including authentication tokens passed in headers.

**No east-west observability:** The API gateway provided metrics for inbound traffic (request rate, latency, error rate by route). But for service-to-service calls (Orders calling Inventory, Inventory calling Fulfillment), there were no uniform metrics. When an Orders service degradation was reported, diagnosing whether the bottleneck was in Orders itself or in one of its downstream dependencies required adding ad-hoc logging to each service.

**Inconsistent timeout and retry behavior:** Each service implemented its own timeout and retry logic for downstream calls, using different libraries, different timeout values, and different retry conditions. Services that did not implement timeouts at all caused cascading failures when a slow dependency held connections open.

**Certificate management overhead:** Services that did implement TLS for inter-service communication managed their own certificates. Certificate expiry caused service authentication failures twice in one quarter; each incident required manual certificate renewal and service restarts.

## Decision
Adopt a **service mesh** to standardize mTLS, observability, and traffic policy for all east-west service-to-service communication. The mesh operates at the infrastructure layer (sidecar proxies injected into each service pod) without requiring application code changes for baseline capabilities.

The mesh provides:
- Automatic mTLS between all meshed services (see ADR-003)
- Uniform golden-signal metrics (request rate, error rate, latency) for all service-to-service routes
- Certificate lifecycle management (automatic rotation, no manual certificate management)
- Route-level retry and timeout policies (see ADR-004)

The mesh does not replace application-layer resilience (Resilience4j circuit breakers remain in place) -- it complements it with network-layer policy.

## Alternatives Considered

**Implement security and observability in each service using shared libraries:** Distribute shared libraries for mTLS, metrics, and timeout handling. Each service updates to the shared library for the capabilities it needs. Rejected because library-based approaches require application changes for each service (increasing adoption latency and migration effort), do not cover services that are not yet updated, and require library versioning coordination across 18 services.

**Kubernetes NetworkPolicy for security, application-level metrics for observability:** Use Kubernetes NetworkPolicy for network-level access control (which service can call which service) and rely on application-level Prometheus metrics for observability. Rejected because NetworkPolicy provides L3/L4 (IP and port) controls but not L7 (HTTP route, mTLS certificate identity) controls. Application-level metrics exist only where they have been explicitly instrumented; a new service starts with no metrics.

**Service mesh for greenfield services only:** Adopt the mesh for new services going forward; do not retrofit existing services. Rejected because the security problem (plaintext HTTP on the internal network) affects existing services, and waiting for natural turnover to achieve full mesh coverage would take years. The mesh's sidecar injection model means retrofitting existing services requires no application code changes, only pod annotation and restart.

## Consequences

### Positive
- mTLS is applied uniformly to all 18 services within the mesh enrollment window (approximately 2 months for all services to be enrolled), eliminating the plaintext HTTP vulnerability
- East-west metrics are available for every service-to-service route from the day of enrollment, without application code changes; the Orders → Inventory dependency graph becomes visible immediately
- Certificate rotation is automatic; the certificate expiry incidents become impossible

### Negative
- The mesh sidecar proxy adds a network hop latency overhead to every service-to-service call. Measured at approximately 1-2ms per call for the chosen mesh (see ADR-002 for the selection). At 10 hops in a deep call chain, the overhead accumulates to 10-20ms.
- Mesh control plane is a new critical shared infrastructure component. Control plane availability affects all services' ability to receive updated policies and certificates.

### Risks
- **Mesh misconfiguration causing service-to-service outage.** An incorrect mTLS policy that is rolled out to all services simultaneously could break all inter-service communication. Mitigation: mesh configuration changes are rolled out progressively (one namespace at a time) with automated traffic health checks before proceeding to the next namespace.

## Review Trigger
Revisit if the 1-2ms sidecar overhead becomes significant relative to service-to-service call latency SLOs as call chains grow. Revisit the mesh choice (ADR-002) if advanced L7 routing requirements emerge that Linkerd cannot address.

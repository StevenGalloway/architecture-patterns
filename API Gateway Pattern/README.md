# API Gateway Pattern

## Summary
An **API Gateway** is a single entry point for clients (web, mobile, partner APIs) that provides **cross-cutting concerns**—auth, rate limiting, routing, request/response shaping, observability—while forwarding requests to internal services.

This pattern is common in enterprise microservice environments and is frequently used alongside:
- BFF (Backend-for-Frontend)
- Service Mesh
- Zero Trust / mTLS
- Canary/Blue-Green releases

---

## Problem
As systems evolve into multiple services, clients often face:
- **Too many endpoints** (service sprawl)
- **Inconsistent authentication/authorization**
- **Chatty client behavior** (many round trips)
- **No consistent rate limiting** and DDoS protection
- **Difficult releases** (routing + versioning + deprecation)
- **Inconsistent telemetry** (logs/metrics/traces differ by service)

---

## Constraints & Forces
- Must support **multiple client types** (mobile, web, partner integrations)
- Must enforce **security controls** (OIDC/JWT, mTLS, WAF, IP allowlists)
- Must handle **traffic spikes** and abusive patterns
- Must provide **reliable routing** (versioning, canary)
- Must avoid becoming a **single point of failure**
- Must keep latency overhead minimal (edge processing adds hops)

---

## Solution
Introduce an **API Gateway** as the system’s edge layer.

### Responsibilities (typical)
1. **Routing**: Map public endpoints to internal services
2. **Authentication**: Validate JWT/OIDC tokens; enforce client identity
3. **Authorization**: Enforce coarse-grained access policies (often RBAC/ABAC at edge)
4. **Rate limiting**: Global and per-tenant enforcement (token bucket / leaky bucket)
5. **Request transformation**: Header normalization, protocol translation, payload shaping
6. **Response transformation**: Consistent error format, pagination/headers
7. **Aggregation** (use carefully): Combine multiple internal calls into one client response
8. **Observability**: Correlation IDs, distributed tracing propagation, access logging

### Recommended architecture
- **Gateway at the edge** (internet-facing) + **internal service-to-service auth**
- Gateway should remain **thin**:
  - Prefer policy and routing over business logic
  - Push complex aggregation into **BFF** or dedicated “composition” services

---

## When to Use
- Multiple client types need stable, consistent APIs
- Microservices require unified edge security controls
- You need consistent versioning, throttling, and telemetry
- You must support gradual releases (canary, blue/green) at the edge

---

## When Not to Use
- Small monolith with few endpoints and low traffic
- Teams lack operational maturity (gateway is a critical control plane)
- Extremely low-latency systems where additional hop is unacceptable
- When a Service Mesh alone fulfills most needs and clients are internal only

---

## Tradeoffs
### Benefits
- Centralized **security**, **rate limiting**, **routing**
- Simplifies clients and reduces duplication across services
- Enables consistent **deprecation/versioning** strategy
- Improves **operability** with unified logging/tracing

### Costs / Risks
- Gateway can become a **bottleneck** or SPOF if not HA
- Risk of “**fat gateway**” accumulating business logic
- Misconfigurations have large blast radius
- Additional latency per request

---

## Failure Modes & Mitigations
1. **Gateway outage**
   - Mitigation: multi-AZ, autoscaling, health checks, failover DNS, circuit breakers
2. **Misrouted traffic / bad rules**
   - Mitigation: config validation, staged rollout, canary rules, automated tests
3. **Auth bypass / policy gaps**
   - Mitigation: default-deny, policy-as-code, security reviews, strong observability
4. **Rate limit misconfiguration**
   - Mitigation: per-tenant limit definitions, safe defaults, alerting on 429 spikes
5. **Gateway becomes “fat”**
   - Mitigation: governance, code ownership, ADRs, enforce “thin gateway” principles

---

## Security Considerations
- Validate JWT signature + issuer + audience + exp
- Enforce TLS termination with modern cipher suites
- Consider WAF rules for common attacks
- Use **least privilege** and separation of duties for gateway config
- Maintain an allowlist for internal upstreams

---

## Observability Considerations
- Emit access logs (structured JSON) with:
  - request_id / correlation_id
  - route name, upstream, status, latency
  - tenant/client ID (non-PII)
- Propagate tracing headers (W3C Trace Context)
- Create SLOs for:
  - p95 latency
  - 5xx rate
  - auth failures
  - throttling rate (429)

---

## Example Implementation
See: `examples/node-express-gateway/`

This example demonstrates:
- Route-based forwarding to multiple services
- JWT validation (simple example)
- Per-tenant token-bucket rate limiting
- Request ID propagation
- A lightweight aggregation endpoint (and guidance on when not to do it)

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-request-flow-sequence.mmd`
- `diagrams/03-deploy-release-canary.mmd`

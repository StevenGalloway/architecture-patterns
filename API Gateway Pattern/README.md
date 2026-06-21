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
Introduce an **API Gateway** as the system's edge layer.

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
  - Push complex aggregation into **BFF** or dedicated "composition" services

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
- Risk of "**fat gateway**" accumulating business logic
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
5. **Gateway becomes "fat"**
   - Mitigation: governance, code ownership, ADRs, enforce "thin gateway" principles

---

## Security Considerations

The gateway is the externally-facing boundary of your system — every security control that fails here fails for all services simultaneously.

**Core controls required at the gateway:**
- Validate JWT `alg`, `iss`, `aud`, `exp`, and signature on every request. Explicitly reject `alg: none`. Never delegate this to upstream services inconsistently.
- Strip inbound identity headers (`X-User-ID`, `X-Tenant-ID`) before forwarding — clients must not be able to inject these. The gateway adds them from the validated JWT.
- Upstream services must be unreachable except through the gateway (private subnet + security group enforcement). The identity header trust model breaks entirely if this perimeter is not enforced.
- WAF handles OWASP CRS (SQLi, XSS, path traversal) before traffic reaches the gateway. WAF does not replace gateway-level JWT validation.
- Access logs must exclude PII in plaintext — no raw IPs, no email addresses. Hash for abuse detection; omit otherwise (GDPR Art. 32, SOC 2 CC6.1).

**Compliance relevance:** SOC 2 CC6.1 (unified access audit log), PCI DSS Req 6.4 (WAF required for CHD environments), GDPR Art. 32 (PII in logs).

→ See [SECURITY.md](SECURITY.md) for the full threat model, JWT validation requirements, secrets management strategy, and pre-deployment security checklist.

---

## Observability Considerations

The gateway sees 100% of external traffic, making it the highest-value observability point in the system.

**Golden signals for the API Gateway:**
- **Latency:** Track `gateway.processing_overhead` (total latency minus upstream latency) separately from end-to-end latency. A growing overhead means the gateway itself is the problem, not the upstream.
- **Traffic:** Monitor requests/second by tenant. Spikes in a single tenant signal abuse or a misconfigured retry loop — both require different responses.
- **Errors:** Distinguish gateway-generated errors (401, 429, 502) from upstream errors (5xx forwarded). A 502 spike means a service is unreachable; a 429 spike means a client is in a retry storm.
- **Saturation:** Track Redis latency for rate limit checks separately. If the rate limit store is slow, every request pays that cost.

**SLO targets (reference):** 99.9% availability (non-502/503 responses), p95 latency < 500ms end-to-end, 99.99% valid JWTs authenticated correctly.

**Structured access log** emitted for every request: `request_id`, `trace_id`, `route_name`, `upstream_service`, `status_code`, `latency_ms`, `tenant_id`, `auth_result`, `rate_limit_remaining`. No PII fields.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, SLI/SLO definitions with error budget math, access log schema, dashboard designs, and 7 chaos engineering test scenarios with pass criteria.

---

## Team Topology

The API Gateway is a **platform team** asset — it provides capabilities (auth, rate limiting, routing, tracing) that stream-aligned teams consume but should not rebuild per service.

**The critical ownership question** is not who owns the gateway, but who owns the routing config. Two failure modes:
- Platform team owns all config → every new route requires a platform ticket → velocity dies at ~6 services
- Teams own all config with no governance → policy sprawl, undocumented routes, gateway becomes unauditable

The recommended model: platform team owns gateway infrastructure and policy schema; stream-aligned teams own their route declarations via GitOps PR, validated in CI against the schema. Teams are autonomous within guardrails.

**Conway's Law signal:** If your gateway routing table has grown to include domain-specific logic (conditional routing based on user tier, request body inspection), your team structure has leaked into your infrastructure layer. This is a leading indicator of a "fat gateway."

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for team type classifications, interaction modes, cognitive load mitigations, and the scaling model from 1–5 services to 15+ services.

---

## Cost Analysis

The core cost decision for an API Gateway is **managed vs. self-hosted**, and the answer is almost always managed until you exceed ~100M requests/month.

| Option | ~10M req/month | ~100M req/month | ~1B req/month |
|---|---|---|---|
| Self-hosted (ECS Fargate) | ~$87 | ~$231 | ~$1,520 |
| AWS API Gateway (HTTP API) | ~$19 | ~$190 | ~$1,900 |
| AWS API Gateway (REST API) | ~$44 | ~$440 | ~$4,400 |

Self-hosted infrastructure cost becomes competitive with managed at scale, but the table excludes the operational burden (0.1–0.25 FTE/year for upgrades, on-call, HA configuration) which tilts the decision toward managed at most traffic levels.

**Largest hidden costs:**
- Aggregation logic in the gateway holds connections longer and multiplies compute cost at scale. Push to BFF.
- Full request/response body logging can cost $2,000–$8,000/month in log storage at 10K req/second. Log the envelope only.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full pricing comparison across 5 options, break-even analysis, hidden cost breakdown, and a cost-by-decision-point guide.

---

## AI Integration

The API Gateway pattern is the direct architectural ancestor of the **LLM Gateway** — one of the most important patterns in enterprise AI platform design. The same problems that drove gateway adoption for microservices (inconsistent auth, no rate limiting, no observability across teams) reappear when teams start calling LLM APIs independently.

**Key ways this pattern extends for AI workloads:**
- **Token-budget rate limiting:** Request-count limits are meaningless for LLMs. A single request can consume 1 or 128,000 tokens. Rate limiting must operate on token budgets per tenant, measured from the model's usage response.
- **Model routing:** Route requests to different models based on task type, tenant tier, cost constraints, or latency SLO — the same routing logic the gateway already applies to services.
- **Semantic caching:** Instead of exact URL matching, cache LLM responses using prompt embedding similarity. Semantically equivalent questions return cached answers. Direct cost reduction.
- **Prompt injection defense:** A new attack surface with no traditional gateway equivalent. The gateway can pattern-match known injection signatures and enforce prompt envelopes, but defense-in-depth requires model-side prompt design as well.
- **Streaming (SSE):** LLM responses stream token-by-token. The gateway must hold connections open for seconds to minutes per request, which changes connection pool sizing and timeout configuration fundamentally.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full LLM Gateway architecture, pattern mapping from traditional to AI workloads, and how existing ADRs apply to model-serving infrastructure.

---

## Platform Engineering

The API Gateway should be the first capability a platform engineering team offers. It eliminates a category of work — auth, rate limiting, tracing, TLS — that every service team would otherwise reimplement.

**The paved road model:** A team that registers a new service should receive JWT validation, rate limiting, structured access logging, and distributed trace propagation automatically — without reading any security documentation or writing any auth code. This is the value proposition. If teams find it easier to bypass the gateway, the platform has failed.

**Self-service route registration** is the operational key. Teams own a `gateway-route.yaml` in their service repo declaring their path, upstream, auth requirements, and rate limit tier. CI validates the schema. A sync job applies it on deploy. The platform team reviews policy violations, not individual routes.

**Platform contract:** The platform team commits to 99.9% gateway availability, ≤10ms processing overhead, and 30-day notice for any breaking schema change. Service teams commit to maintaining upstream health checks and SLOs for their own services.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the self-service route config schema, platform contract definition, developer experience requirements, and signals that the gateway has become a platform anti-pattern.

---

## Business Case

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for non-technical stakeholders (CPO, CFO, VP Engineering): the problem in plain language, what implementation costs in engineer-weeks and monthly infrastructure, what the business gains, and the risk of inaction.

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

## Architecture Decision Records
- [ADR-001: Adopt an API Gateway as the external entry point](adrs/adr-001-use-api-gateway.md)
- [ADR-002: Validate JWT at the gateway; keep fine-grained authorization in services](adrs/adr-002-auth-at-edge.md)
- [ADR-003: Rate limiting strategy](adrs/adr-003-rate-limiting-strategy.md)
- [ADR-004: Aggregation vs. BFF](adrs/adr-004-aggregation-vs-bff.md)
- [ADR-005: Standardize request IDs, structured access logs, and distributed trace propagation](adrs/adr-005-observability-and-tracing.md)

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (external actors, systems, and relationships)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (gateway process, rate limit store, JWKS cache, config store, load balancer)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-request-flow-sequence.mmd](diagrams/02-request-flow-sequence.mmd) — Request flow through auth, rate limiting, and upstream routing
- [03-deploy-release-canary.mmd](diagrams/03-deploy-release-canary.mmd) — Canary release routing at the gateway

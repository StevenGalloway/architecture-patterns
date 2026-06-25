# Backend-for-Frontend (BFF) Pattern

## Summary
A **Backend-for-Frontend (BFF)** is a backend service built specifically for a **single user experience** (e.g., mobile, web, TV, partner portal). Instead of having clients call many domain services directly, the BFF provides:
- **UI-optimized endpoints**
- **Aggregation & orchestration**
- **Payload shaping** (avoid over/under-fetching)
- **Client-specific caching and resilience**
- **A stable contract owned by the UI team**

BFF is commonly used with an API Gateway and microservices, and is a strong enterprise pattern for reducing coupling between UI and domain services.

---

## Problem
As you scale services and clients, you often see:
- Clients calling many services → **chatty networks**
- Different clients need different shapes (mobile vs web) → **over/under-fetching**
- UI teams forced to coordinate changes across many service owners → **slow delivery**
- Increased risk of breaking changes exposed to clients
- Inconsistent caching and fallback behaviors implemented in each client

---

## Constraints & Forces
- Multiple clients with different needs: **mobile, web, tablet, partner portal**
- Need stable UI contracts with independent release cycles
- Minimize round trips and payload sizes (especially for mobile)
- Ensure security and compliance (PII safe, least privilege)
- Preserve domain boundaries (avoid pulling business logic into UI layer)
- Avoid “BFF sprawl” and duplicated logic across BFFs

---

## Solution
Create **one BFF per frontend experience**:
- **Mobile BFF** owns mobile endpoints and response shapes
- **Web BFF** owns web endpoints and response shapes

The BFF:
- Aggregates data from domain services
- Applies presentation-level shaping and “view composition”
- Implements caching and resilience tuned for the client experience
- Provides a stable contract the frontend depends on

### What belongs in a BFF
- Aggregation / composition (“home page view”)
- Presentation shaping (flattening nested structures, small payloads)
- Client-tuned caching (short TTL for home feed, longer for static catalog)
- Feature-flag evaluation and experiment assignment (if owned by UI)

### What does NOT belong in a BFF
- Core business logic or invariants (pricing rules, entitlement logic)
- Data ownership (BFF should not become system-of-record)
- “Shared enterprise APIs” used by many teams (that’s not a BFF; that’s a domain API)

---

## When to Use
- You have multiple client experiences with different data needs
- UI teams need to ship independently from many backend teams
- Mobile performance requires fewer calls and smaller payloads
- You need a stable UI contract that shields clients from backend churn

---

## When Not to Use
- Single client experience with simple data needs
- Monolith or small service count where direct calls are manageable
- Organization cannot operate multiple BFFs
- If BFFs will duplicate complex business rules (strong smell)

---

## Tradeoffs
### Benefits
- Better performance: fewer round trips, smaller payloads
- Faster product iteration: UI team controls contract
- Reduced coupling: domain APIs can evolve independently
- Centralized client-specific caching and fallbacks

### Costs / Risks
- More services to operate (“BFF sprawl”)
- Potential duplication across BFFs
- Risk of “fat BFF” accumulating domain logic
- Requires strong API governance and contract testing

---

## Failure Modes & Mitigations
1. **BFF becomes a monolith**
   - Mitigation: enforce “presentation-only” scope, ADRs, code review rules
2. **Backend dependency slowness makes UX bad**
   - Mitigation: timeouts, partial responses, caching, bulkheads
3. **Contract drift breaks clients**
   - Mitigation: explicit versioning, consumer-driven contract tests, deprecation policy
4. **Duplicated logic across BFFs**
   - Mitigation: shared libraries for cross-cutting (auth, telemetry), not business rules
5. **Security leakage (PII overexposure)**
   - Mitigation: response allowlists, schema validation, field-level policies

---

## Security Considerations

The BFF holds two trust contexts simultaneously: it is a trusted internal caller to domain services, and an externally-facing service to end users. Getting either context wrong creates vulnerabilities that neither the API Gateway nor the domain services will catch.

**Key controls at the BFF:**
- The BFF must validate the JWT itself before forwarding identity claims to domain services. Forwarding without validation means an attacker who can influence BFF outbound requests can forge identity headers, because domain services trust BFF network addresses.
- Each BFF should have a distinct `aud` claim in the JWT. A token issued for the mobile BFF cannot be replayed against the web BFF.
- Response allowlists per client surface are mandatory. Mobile clients should not receive payment method details, full addresses, or domain fields they never render. Allowlist approach (explicit inclusion) is safer than blocklist — new domain service fields are not automatically returned to clients.
- Amplification attack surface: one BFF request triggers 5–8 domain calls. Per-user rate limiting must account for fanout, not just raw request rate.
- Each BFF uses a distinct service identity (separate mTLS certificate, separate credentials) for domain service calls. A compromised mobile BFF cannot access admin-only domain service endpoints.

**Compliance relevance:** GDPR Art. 5(1)(c) (BFF response allowlists are the data minimization mechanism), SOC 2 CC6.1 (per-BFF access logs show which user accessed which data via which client surface), PCI DSS Req 3.3 (cardholder data masked at BFF layer before delivery to mobile clients).

→ See [SECURITY.md](SECURITY.md) for the full threat model, JWT validation requirements per BFF, PII overexposure controls, amplification attack mitigations, cross-client data leakage prevention, and the pre-deployment security checklist.

---

## Observability Considerations

The BFF is the highest-value observability point for user-perceived performance. Gateway-level observability tells you a request was routed to the mobile BFF and returned 200. BFF-level observability tells you the 200 was assembled from three parallel domain calls, the Recommendations call took 340ms (83% of total latency), and the payload was projected from 4.2KB to 1.1KB before delivery.

**Golden signals for the BFF:**
- **Latency:** Track `composition_overhead` (total latency minus the slowest upstream call latency) separately. If composition overhead is growing, the BFF’s own code is the problem. If the slowest upstream call is growing, a specific domain service is the problem.
- **Traffic:** Monitor `partial_response_rate` per BFF per endpoint. Partial responses are expected graceful degradation — but a rising partial rate is a silent indicator of upstream service health degradation.
- **Errors:** Distinguish BFF-generated 401/429 from total composition failures (503) from partial degradation (206). A 503 spike means all upstreams failed; a 206 spike means one upstream failed gracefully.
- **Saturation:** Track connection pool utilization to each domain service independently. The BFF holds N simultaneous connections per request (one per parallel call), so connection exhaustion happens at a fraction of the request concurrency that would exhaust a simple proxy.

**SLO targets (reference):** 99.9% availability per BFF (partial responses count as available), p95 mobile latency < 400ms, p95 web latency < 600ms, partial response rate < 2% per endpoint per hour.

**Structured log** emitted per request: `client_type`, `bff_name`, `endpoint`, `status_code`, `total_latency_ms`, `composition_overhead_ms`, `cache_hit`, `partial_response`, `upstream_calls[]` with per-service latency and status. No PII field values.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, per-BFF and cross-BFF dashboard designs, SLI/SLO definitions with error budget math, structured log schema, and 6 chaos engineering test scenarios with pass criteria.

---

## Team Topology

The BFF is the rare pattern where Conway’s Law works in your favor: one BFF per client experience means one team owns the full stack for that client — the mobile team owns the mobile BFF, the web team owns the web BFF. There is no cross-team coordination required for every product change. This is the primary velocity benefit of the pattern.

The failure mode is not the BFF itself but "BFF sprawl" without governance: five BFFs each duplicating the same aggregation logic for the same domain services, with no shared library to absorb domain service schema changes. When the Orders service changes its response schema, five teams must each update their BFF — or one shared library update propagates to all five. The platform decision between these two models must be made before the third BFF is built.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for team type classifications, the Conway’s Law implication of one-BFF-per-team, the shared library governance model, and the scaling model from 1–2 BFFs to 5+ BFFs.

---

## Cost Analysis

The BFF’s primary cost driver at medium and large scale is not compute — it is the engineering overhead of maintaining multiple diverging contracts as domain services evolve. At 4 BFFs × 5 domain services, there are 20 consumer-side contract relationships to maintain.

| Scale | BFF count | Monthly infrastructure | Notes |
|---|---|---|---|
| Small (<1M sessions/day) | 1–2 BFFs | ~$156 | Fargate (4 tasks) + ALB + Redis per BFF |
| Medium (10M sessions/day) | 3–4 BFFs | ~$1,062 | Compute scales with BFF count; engineering overhead is dominant cost |
| Large (100M+ sessions/day) | 5+ BFFs, multi-region | ~$22,660 | Shared library ROI is clearly positive at this scale |

The break-even for a shared composition library vs. per-BFF duplication is approximately the second domain service schema change that affects 3+ BFFs simultaneously. After that point, the shared library pays for itself in reduced engineering coordination overhead.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full cost analysis across three scale tiers, option comparison (single BFF vs. dedicated per client, shared composition library), and the five hidden costs that do not appear in cloud billing.

---

## AI Integration

The BFF is a natural server-side boundary for AI integration — it holds the session context, user profile, and client-type metadata needed to construct high-quality prompts, and it is the correct place to adapt AI responses for each client’s rendering capabilities.

**Key ways this pattern extends for AI workloads:**
- **Server-side prompt construction:** The BFF assembles context-rich prompts from session state, user tier, recent activity, and client-specific parameters before calling an LLM. Prompt logic stays server-side and invisible to clients — no prompt injection surface in the client app.
- **Streaming AI response adaptation per client:** LLM responses stream token-by-token. Mobile BFFs should buffer and batch stream chunks before forwarding (token-by-token streaming is too chatty for mobile data connections); web BFFs can stream directly. The BFF handles this per-client adaptation that the model API itself cannot.
- **AI content hydration:** BFF enriches AI-generated text with structured data appropriate for each client: links for web, deep links for mobile, simplified markup for TV. The model produces text; the BFF adds client-appropriate structure.
- **AI response caching per client type:** The mobile BFF can cache a model response shaped for mobile separately from the same content shaped for web. One model call, two cached shapes — the BFF prevents duplicate model calls for the same underlying content.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full LLM integration patterns, streaming response handling per client type, server-side prompt construction architecture, and AI content caching strategy.

---

## Platform Engineering

The BFF is a platform engineering challenge at the boundary between service infrastructure and client delivery. The platform team provides the paved road: shared auth middleware, request ID propagation, connection pool management, and contract test harness. Teams own the composition logic and response projection for their client.

**The paved road model:** A new BFF should receive JWT validation, structured access logging, distributed trace propagation, and domain service connection pool management automatically — without the team implementing any of these. The platform team provides a BFF scaffold that generates a working service with all cross-cutting concerns pre-wired. Teams implement the endpoint handlers and response projections.

**Platform contract:** The platform team commits to the shared library providing correct JWT validation, 30-day notice for breaking changes to the auth library interface, and domain service client templates for each internal service. BFF teams commit to response allowlists, per-endpoint rate limit configuration, and maintaining their contract test suite.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the BFF scaffold design, shared library contract, developer experience requirements, and signals that the BFF has accumulated too much shared business logic.

---

## Business Case

Separate BFF per client type eliminates cross-client coordination overhead, enables client-specific performance tuning, and provides a clear audit surface for PII minimization per client experience.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for non-technical stakeholders (CPO, CFO, VP Engineering): the problem in plain language, what implementation costs in engineer-weeks and monthly infrastructure, what the business gains, and the risk of inaction.

---

## Example Implementation
See: `examples/node-bff/`

This example demonstrates:
- Mobile BFF endpoint `/mobile/home` optimized for mobile payload
- Web BFF endpoint `/web/home` optimized for web payload
- Shared domain services: profile, catalog, recommendations
- Simple resilience behavior: timeouts + partial response
- Request ID propagation

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (mobile user, web user, API Gateway, BFFs, domain services, observability platform)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (mobile BFF and web BFF with auth middleware, composition layer, response cache, and request ID propagator)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-request-flow-sequence.mmd](diagrams/02-request-flow-sequence.mmd) — Request flow through BFF composition and domain services
- [03-contract-versioning.mmd](diagrams/03-contract-versioning.mmd) — Contract versioning strategy

---

## Architecture Decision Records
- [ADR-001: Adopt Backend-for-Frontend pattern](adrs/adr-001-adopt-bff.md)
- [ADR-002: BFF ownership and boundaries](adrs/adr-002-bff-ownership-and-boundaries.md)
- [ADR-003: Authentication strategy at BFF layer](adrs/adr-003-auth-strategy.md)
- [ADR-004: Aggregation and resilience patterns](adrs/adr-004-aggregation-and-resilience.md)
- [ADR-005: Contract management and versioning](adrs/adr-005-contracts-and-versioning.md)

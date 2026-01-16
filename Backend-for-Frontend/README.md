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
- Authenticate users (JWT/OIDC) and propagate identity to domain services
- Enforce least privilege: BFF should not query data it shouldn’t expose
- Redact or suppress sensitive fields (PII) by default
- Audit access patterns via structured logs

---

## Observability Considerations
- Request IDs and distributed tracing across:
  Client → BFF → domain services
- Measure UX-impacting SLOs:
  - p95 endpoint latency per client
  - partial response rates
  - upstream timeout rates
  - cache hit ratio

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
- `diagrams/01-context.mmd`
- `diagrams/02-request-flow-sequence.mmd`
- `diagrams/03-contract-versioning.mmd`

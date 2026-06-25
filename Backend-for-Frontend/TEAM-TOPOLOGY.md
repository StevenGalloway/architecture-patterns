# Team Topology — Backend-for-Frontend Pattern

## The Critical Distinction: Stream-Aligned Asset, Not Platform Asset

The API Gateway is a platform asset. The BFF is not. This distinction is the most important architectural statement about the BFF pattern, and getting it wrong is the most common organizational failure mode.

A BFF exists to serve one frontend team's one client experience. It is built, owned, operated, and deprecated by the team that builds the UI it serves. When ownership is handed to a platform team or a backend team, the BFF immediately begins to fail at its primary purpose: allowing the frontend team to ship independently.

The platform team's job in a BFF architecture is to provide the capabilities BFFs consume — auth middleware, observability instrumentation, shared request ID propagation, contract test scaffolding — not to own or review the BFF itself.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Mobile Frontend Team** | Stream-aligned | Mobile BFF: owns endpoints, response shape, caching config, resilience policy, mobile client contract |
| **Web Frontend Team** | Stream-aligned | Web BFF: owns endpoints, response shape, caching config, resilience policy, web client contract |
| **Partner Portal Team** | Stream-aligned | Partner BFF (if exists): partner-specific aggregation and contract |
| **Platform Engineering** | Platform team | Auth middleware library, request ID propagation, structured logging schema, observability auto-instrumentation, contract test framework, BFF scaffold |
| **Domain Service Teams** (Orders, Catalog, Profile, etc.) | Stream-aligned | Domain API contracts; consume BFF requests as a downstream caller like any other |
| **Security** | Enabling team | JWT validation standards, PII field policy, response allowlist requirements, security review checklist for new BFF launch |

The BFF teams consume platform capabilities via X-as-a-service interaction. They do not collaborate with the platform team for routine changes. Platform team interaction is reserved for: adding a new BFF (use the scaffold), adopting a new cross-cutting library, or non-standard resilience requirements.

---

## Conway's Law Implications

The number of BFFs in your system is a direct reflection of your organizational structure. This is not a side effect — it is the point.

**What the org chart predicts:**

| Org structure | Expected BFF structure | Health signal |
|---|---|---|
| 3 frontend teams, 3 client experiences | 3 BFFs, one per team | Correct alignment |
| 3 frontend teams, 1 shared "UI platform" team | 1 BFF owned by UI platform, 3 consumers | Bottleneck forming — platform team becomes the gating dependency |
| 1 frontend team, 3 client experiences | 1 team responsible for 3 BFF contracts | Acceptable at small scale; watch for overload as contracts diverge |
| Backend team owns the BFF | BFF accumulates domain logic, UX constraints ignored | Anti-pattern — ownership mismatch produces a wrong BFF |

The BFF boundary should match the team boundary. If the mobile team owns the mobile app and the mobile BFF, Conway's Law works for you: the contract between client and BFF is internal to the team, and the team can change it with zero coordination cost. If ownership is split across teams, every endpoint change requires cross-team negotiation.

---

## Failure Mode: One Team Owns Multiple BFF Contracts

When a single team owns BFFs for multiple client experiences, the team becomes a bottleneck for all of them. The mobile team files a request to change the mobile home screen payload; the web team has a request queued ahead of it; both wait.

This bottleneck produces the same coordination overhead the BFF pattern was adopted to eliminate. The team is doing what a backend domain team does — managing contracts for multiple consumers — rather than what a frontend team should do: building the best possible experience for one client.

**Signal to watch:** A team's sprint backlog contains change requests from multiple external client teams. If it does, that team has become a shared service team, not a stream-aligned BFF team. The structural fix is to split ownership, not to hire more engineers.

---

## Failure Mode: Backend Teams Own the BFF

Backend engineers default to domain-oriented thinking. Given ownership of a BFF, they build what they know: a thinner domain service with a slightly different response shape. They do not apply mobile-specific payload constraints, client-specific caching strategies, or UX-driven fallback policies, because those concerns are invisible to someone who has never shipped a mobile app.

The result is a BFF that passes the full domain response to the mobile client with a minor projection applied. Mobile performance does not improve. Frontend teams are still blocked on backend schedule for changes.

**Signal to watch:** BFF endpoints return full domain objects with nested structures greater than 2 levels deep. This means domain response shapes are leaking through without client-specific shaping.

---

## Team Interaction Modes

| Interaction | Mode | Cadence | Description |
|---|---|---|---|
| BFF team → domain service teams | **X-as-a-service** | Async, ticket-based or API contract | BFF team calls domain APIs as a consumer. Standard SLAs apply. No joint sprints. |
| BFF team → platform team (auth) | **X-as-a-service** | Self-service | BFF team imports auth middleware library. Platform team maintains the library. BFF team does not write JWT validation logic. |
| BFF team → platform team (new BFF) | **Collaboration** | Time-boxed (1 sprint max) | First BFF for a new client type: platform team provides scaffold, reviews architecture, then disengages. |
| Platform team → BFF teams | **Enabling** | Quarterly library updates | Platform team ships new shared library version. BFF teams adopt on their own schedule. Breaking changes require 30-day notice. |
| Security → BFF teams | **Enabling** | At BFF launch, then annually | Security team reviews PII field exposure, response allowlist completeness, JWT validation implementation. Not a per-PR gate. |
| BFF team → BFF team | **Rare collaboration** | Ad hoc | When BFFs share a pattern problem (e.g., a domain service change affects all BFFs simultaneously). Form a temporary working group; do not create a shared BFF. |

---

## Cognitive Load and Team Scope

The BFF pattern keeps cognitive load manageable by limiting each team's responsibility surface:

- The mobile BFF team knows the mobile app's data needs deeply. They do not need to understand the web app, the partner portal, or the B2B API surface.
- The domain service teams know their domain model. They do not need to understand mobile payload constraints or web rendering requirements.
- The platform team knows the shared infrastructure. They do not need to understand any specific business composition.

This separation is the BFF's primary value. Any arrangement that causes a team to hold two of these concerns simultaneously degrades performance.

**Cognitive load warning signs:**

| Symptom | Cause | Fix |
|---|---|---|
| Mobile BFF team constantly waiting on Orders team | BFF lacks caching layer for read-heavy endpoints | Add TTL-appropriate cache to BFF composition layer |
| BFF PRs require domain team approval | BFF contains domain logic | Extract to domain service; BFF should only orchestrate |
| Platform team reviewing BFF PRs weekly | Ownership confusion | Clarify that BFF belongs to stream-aligned team; platform team owns only shared library updates |

---

## Scaling the BFF Model: From One Client to Many

| Scale | Structure | Governance model |
|---|---|---|
| 1 client, 1 team | 1 BFF, team owns everything | No formal governance needed. Document the pattern before you add a second client. |
| 2–3 clients, 2–3 teams | 1 BFF per team | Establish shared library for auth and request ID. Contract test framework from day one. |
| 4–6 clients, 4+ teams | 1 BFF per team, platform team emerges | Platform team formalizes shared library ownership. BFF scaffold created. Security team conducts launch reviews. |
| 7+ clients or multi-region | BFFs per client per region (or BFF per client with multi-region deployment) | GitOps-based BFF configuration. Platform team provides self-service scaffold that is CI-validated. Architecture review for new BFF types. |

---

## The BFF Sprawl Problem and Governance Response

BFF sprawl occurs when the number of BFFs exceeds the organization's capacity to maintain them distinctly. Two failure modes:

**Sprawl by duplication:** Three BFFs each implement their own version of cart aggregation, user profile shaping, and recommendation formatting. When the Catalog service changes its response schema, three BFF teams must each update independently, and they do it at different times with different error handling.

**Sprawl by proliferation:** An organization creates a BFF for every minor UI variation — a "tablet BFF," a "kiosk BFF," a "dark mode BFF" — rather than using a single BFF to handle device-specific variations in the response layer.

**Governance response — what belongs where:**

| Concern | Belongs in | Rationale |
|---|---|---|
| JWT validation logic | Platform-owned shared library | Identical across all BFFs; security-critical; must not diverge |
| Request ID generation and propagation | Platform-owned shared library | Tracing infrastructure; must be consistent |
| Error response formatting | Platform-owned shared library | Consistent client experience; reduced per-client error handling |
| Structured logging schema | Platform-owned shared library | Observability requires uniform log structure across BFFs |
| Home screen composition (which services to call) | Per-BFF | Client-specific; mobile and web home screens have different data needs |
| Response payload shape | Per-BFF | Mobile needs 60% smaller payloads than web; schema must diverge |
| Cache TTLs | Per-BFF | Mobile caches aggressively (battery/bandwidth); web caches less |
| Fallback / partial response behavior | Per-BFF | Mobile degrades gracefully; web may show richer error states |
| Domain business rules (pricing, entitlement) | Domain services only | Never in BFF |

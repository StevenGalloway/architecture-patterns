# ADR-001: Adopt Backend-for-Frontend (BFF) per client experience

## Status
Accepted

## Date
2025-04-16

## Context
As the product grew, the mobile and web clients were both calling domain services directly: Orders, Catalog, Recommendations, User Profile, and Inventory were each exposed as independent APIs. The mobile client required smaller payloads with pre-computed summaries because users on 4G connections measured load times in seconds. The web client required richer, denormalized data structures that composed catalog and inventory inline for the product detail page.

Both clients were making 6-9 parallel requests to assemble a single screen. When any one of those services was slow, the screen was slow. When the Orders team changed the orders API response shape to support a new B2B feature, both the mobile and web apps broke simultaneously even though neither needed the B2B fields.

The domain service teams were spending roughly 30% of their sprint capacity responding to UI-specific requests: add this field to the response, expose this flag, change the sort order of this list. Domain services were accumulating UI-specific logic that had no place there, and frontend engineers were blocked on backend teams for changes that should have been entirely in frontend control.

## Decision
Introduce dedicated Backend-for-Frontend services:
- **Mobile BFF** owns the API contract for iOS and Android clients, handles composition of upstream data, and shapes payloads for mobile performance constraints
- **Web BFF** owns the API contract for the web application, handles richer composition and supports the web app's more data-heavy patterns

Each BFF is owned and deployed by the frontend team that consumes it. Domain services remain unaware of client-specific requirements and expose stable, client-agnostic APIs.

## Alternatives Considered

**API Gateway with response shaping middleware:** The API gateway handles field filtering and basic payload transformations, eliminating the need for dedicated BFF services. Rejected because gateway middleware has no team owner, no bounded context, and no way to test presentation logic independently. The "product detail requires catalog + inventory" composition problem cannot be solved with field filtering alone.

**GraphQL at the API layer:** A single GraphQL endpoint allows clients to specify exactly the fields they need, eliminating over-fetching without dedicated BFF services. Deferred rather than rejected. GraphQL is a viable long-term path but requires schema federation tooling and client-side query discipline that the team is not ready to adopt. The BFF pattern achieves similar goals with more operational simplicity at current team size.

**Client-side composition with a thin proxy:** Clients make individual calls to domain services through a lightweight proxy that handles authentication but no composition. Rejected because the 6-9 parallel requests per screen were already causing performance problems, and the approach gives clients no protection from domain API changes.

## Consequences

### Positive
- UI teams can change mobile and web contracts without coordinating with domain service teams
- Mobile payload sizes reduced by approximately 60% by stripping fields that were required by domain APIs but unused by mobile clients
- Domain services receive stable, semantically consistent requests without UI-specific shape requirements

### Negative
- Two new services to deploy, monitor, and operate with their own availability targets
- If both BFFs need the same aggregation logic (e.g., user profile + recent orders is needed by both mobile home and web dashboard), the logic is written twice unless extracted into a shared composition library

### Risks
- **BFF becomes a mini-monolith.** Without clear scope boundaries, BFFs accumulate domain logic, business rules, and data ownership that should live in domain services. Mitigation: see ADR-002 for explicit scope constraints and review gate enforcement.

## Review Trigger
Revisit if a third client type (e.g., partner API consumers, TV/connected device apps) requires a third BFF with significant composition overlap with the existing two. At that point, evaluate whether a shared composition layer or GraphQL federation would reduce duplication more efficiently than a third dedicated BFF.

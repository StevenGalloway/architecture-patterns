# ADR-004: Keep aggregation minimal at the gateway; push heavy composition to BFF services

## Status
Accepted

## Date
2025-10-08

## Context
After the gateway was deployed, frontend engineers started requesting aggregation endpoints that could combine data from multiple services into a single response, reducing the number of round trips for mobile clients on high-latency networks. The first request was reasonable: a single `/mobile/home` call that fetched user profile, recent orders, and recommendations. We added it to the gateway as a fan-out handler.

The second request was more complex: a combined product detail view that needed catalog data, inventory status, pricing rules, and personalized recommendations with fallback logic if recommendations were unavailable. Writing this in the gateway meant putting domain-aware fallback logic and payload transformation into gateway middleware. After implementing it, we had two services' worth of business logic inside the gateway and no clean way to test it independently.

## Decision
The gateway allows only lightweight aggregation: a simple fan-out to two or three services with independent timeout handling per upstream call, where the response is a structural merge of upstream payloads with no domain transformation. The timeout per upstream call is 500ms; the overall aggregation endpoint has a 1,000ms hard timeout.

Any aggregation that involves domain logic, complex fallback behavior, significant payload reshaping, or more than three upstream dependencies must be implemented in a dedicated BFF or composition service. The gateway routes those calls to the BFF rather than handling them inline.

The rule of thumb: if you need to write an `if` statement that references a business concept (product availability, user tier, recommendation strategy), it belongs in a service.

## Alternatives Considered

**Allow all aggregation in the gateway:** Maximum round-trip reduction for clients. Rejected because the product detail incident made clear that domain logic in gateway middleware is hard to test, version, and operate. Gateway middleware has no bounded context, no service owner, and no clear place in the architecture.

**No aggregation in the gateway -- all composition in BFFs:** Pure routing only at the gateway. Rejected because some aggregation is genuinely lightweight and adding a BFF service for every minor composition adds deployment and operational overhead for small returns.

**GraphQL federation at the gateway:** The gateway acts as a GraphQL supergraph that federates subgraphs per service. Deferred rather than rejected. This is a viable long-term path but requires the team to adopt GraphQL tooling (Apollo Federation or similar), which is a significant investment that we are not ready to make before validating the BFF pattern first.

## Consequences

### Positive
- The gateway stays thin and focused on routing and policy, which makes it easier to reason about, test, and operate
- Domain logic in BFF services is independently deployable, testable, and owned by the team closest to the feature
- The line between "gateway aggregation" and "BFF logic" is clear and enforceable during code review

### Negative
- Every new client type that needs a distinct composition may require a new BFF service, which adds operational surface area
- The 500ms upstream timeout in gateway aggregation is a hard constraint; slow upstreams cause partial responses that clients must handle

## Review Trigger
Revisit if more than three BFF services emerge that contain similar aggregation logic, as that may indicate the gateway timeout constraints are too strict or that a more flexible composition layer (GraphQL, tRPC) is warranted.

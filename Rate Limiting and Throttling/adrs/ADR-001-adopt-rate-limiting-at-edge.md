# ADR-001: Enforce rate limiting at the edge

## Status
Accepted

## Date
2025-07-02

## Context
Two production incidents, occurring within three weeks of each other, made the absence of systematic rate limiting untenable.

The first involved a partner integration. The partner's backend had a misconfiguration that caused it to retry a failed authentication request in a tight loop. The retry loop generated approximately 8,000 authentication requests per minute against our Auth service. The Auth service's database connection pool was exhausted within 90 seconds, causing login failures for all users -- including users completely unrelated to the partner's integration -- for 4 minutes.

The second involved a scraper that was systematically downloading the entire product catalog. The scraper used a rotating IP pool to avoid IP-based blocking and made requests at a rate of approximately 600 per minute spread across 40 IP addresses. Because catalog pages were not cached at the API layer, each request hit the Catalog service's database. The scraper ran for 14 hours before it was detected through an infrastructure cost anomaly (database query costs were 3x higher than the previous day). By that point, it had downloaded the complete catalog twice.

Both incidents would have been prevented by rate limiting applied before traffic reached internal services. The Auth service and Catalog service had no protection of their own because they assumed all traffic arrived via the API gateway, which was trusted. Adding rate limiting to each service individually would have required duplicating the limit configuration and enforcement logic across all services.

## Decision
Rate limiting is enforced at the **edge/API gateway layer**, before any request reaches internal services. The gateway is the single point where rate limiting policy is defined and enforced. Internal services do not implement their own rate limiting.

Rate limiting is applied at two levels:
- **Request-level limits:** Applied per request before routing decisions are made. Used for IP-based and API-key-based limits.
- **Route-level limits:** Applied after routing. Different limits for different endpoint groups (authentication endpoints have stricter limits than catalog endpoints).

The decision about what rate limits exist and how they are enforced is the gateway's responsibility. Internal services trust that traffic reaching them has already passed the edge limits.

## Alternatives Considered

**Rate limiting at each service:** Each service implements its own rate limiting using a shared library. Services are autonomous in setting their own limits. Rejected because it requires every service to maintain limit configuration, and the partner authentication incident was caused by a service (Auth) that had no limit protection. Centralized limits ensure uniform protection without requiring each service team to independently add limit logic.

**Rate limiting via a dedicated proxy sidecar (service mesh):** Envoy or Linkerd sidecars apply rate limits at the network layer for each service, using a central rate limit service for shared state. More granular than edge-only limiting (each service gets isolated limits). Rejected as the primary approach because sidecar rate limiting is complex to configure and cannot enforce limits before routing decisions (e.g., blocking a bot before it even reaches a service's network boundary).

**Third-party rate limiting service (AWS WAF, Cloudflare):** Offload rate limiting to a managed cloud service that handles distributed enforcement. Provides DDoS protection in addition to application-level limits. Deferred rather than rejected: this is the long-term target if traffic volume grows significantly, but the operational cost and vendor dependency are not justified at current traffic levels. The gateway's Redis-backed rate limiting is sufficient for current needs.

## Consequences

### Positive
- A repeat of the partner authentication loop would be caught at the edge: the partner's API key would hit the authentication endpoint limit and receive 429s instead of exhausting the Auth service's connection pool
- Scrapers are throttled before they reach the Catalog service's database; the rotating-IP scraper would still be caught by the API-key-level limit (the scraper used a single API key despite rotating IPs)
- All services are protected uniformly without each service team independently adding rate limiting code

### Negative
- The gateway becomes a more critical component: it was already critical for routing, and now it is also critical for security. A misconfigured rate limit rule can block legitimate traffic at scale.
- Edge-only rate limiting does not protect internal service-to-service traffic. If a service is compromised or buggy and starts generating excessive internal calls, edge rate limiting does not help.

### Risks
- **Limit configuration error blocks legitimate traffic.** A rate limit set too low blocks paying customers. Mitigation: limit changes are deployed via a canary process (see ADR-005 runbook) and validated against production traffic before full rollout.

## Review Trigger
Revisit if internal service-to-service traffic emerges as a rate limiting concern, at which point service mesh sidecar limits may be warranted in addition to edge limits. Revisit the build-vs.-managed decision if edge traffic volume grows by 10x and the operational cost of self-managed Redis-backed rate limiting becomes significant.

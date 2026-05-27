# ADR-002: Establish a routing seam using an Edge Router

## Status
Accepted

## Date
2025-10-08

## Context
The first extraction target was the Billing service. The monolith handled billing at the URL paths `/billing/*` -- invoice creation, payment processing, subscription management, and billing history. Clients (the web app, the mobile app, and partner integrations) all called these paths directly against the monolith's hostname.

To extract Billing without requiring clients to change their integration points, we needed an intermediary that could receive all requests at the monolith's hostname and selectively route some paths to the new Billing service while routing everything else to the monolith. The clients' URL structure would remain unchanged. The routing decision would be invisible to them.

The alternative -- having clients update their URLs to call the new Billing service directly -- was rejected because it would require coordinated updates across three client types (web app, mobile app, partner integrations), partner integrations often cannot be updated on short notice, and any client that had not updated would still need to reach the monolith, requiring the monolith to continue serving billing traffic in parallel anyway.

The routing seam approach decouples the client-facing API contract from the internal routing topology. Once the seam is in place, routing changes require only gateway configuration changes, not client deployments.

## Decision
Deploy an **Edge Router** (NGINX-based reverse proxy, already in use for SSL termination) as the routing seam. The Edge Router sits in front of both the monolith and all new extraction services, receiving all client traffic at the existing hostname.

**Initial routing configuration:**
- `/billing/*` → New Billing Service (after cutover)
- `/billing/*` → Monolith (during shadow/canary phases)
- All other paths → Monolith (unchanged)

**Routing progression per slice:**
1. All traffic → Monolith (baseline)
2. Shadow mode: billing traffic → Monolith (authoritative) + shadow copy → New Billing Service (no side effects)
3. Canary: 5% billing traffic → New Billing Service, 95% → Monolith
4. Progressive: 5% → 25% → 50% → 100%
5. Full cutover: 100% billing traffic → New Billing Service

**Header-based routing for internal testing:** Requests with header `X-Route-Override: billing-new` are always routed to the new Billing Service regardless of the current traffic percentage. This allows the Billing team to test the new service with production data before any canary traffic is enabled.

**Client contract stability:** The API paths, response shapes, and error codes presented to clients remain identical throughout the migration. The routing seam is transparent to clients.

## Alternatives Considered

**Client-side routing updates:** Each client is updated to call the new Billing Service's URL directly. The monolith routes to the new service for internal cross-domain calls. Rejected because it requires coordinated client updates across web app, mobile app, and partner integrations, and partner integrations have independent deployment cycles that cannot be controlled.

**Strangler Fig via API proxy within the monolith:** The monolith receives all requests and internally proxies billing calls to the new service. The monolith becomes a thin router. Rejected because this requires the monolith to be modified (adding proxy logic) for each extraction, perpetuating the monolith's deployment coupling and defeating the purpose of incremental extraction.

**DNS-based routing (separate subdomain for new services):** New services are available at a new subdomain (`billing-api.company.com`). Clients are updated to use the new subdomain. Rejected for the same reason as client-side routing updates: requires coordinated client changes.

## Consequences

### Positive
- Clients make no changes during any phase of the migration; the routing seam is transparent to all client types
- The routing configuration is versioned and reviewable; traffic percentage changes are code review events, not ad-hoc changes
- Rollback is a router configuration change (reduce canary percentage to 0%), not a service deployment

### Negative
- The Edge Router is now a critical path component for all traffic; its availability and configuration correctness affect the entire platform
- Router configuration for multiple simultaneous extractions (if Billing and Notification are both in flight) adds complexity to the routing rules

### Risks
- **Router configuration error routes traffic to wrong target.** An incorrect routing rule could send billing traffic to the wrong service, causing visible errors. Mitigation: router configuration changes are validated in a staging environment before production deployment; a shadow traffic comparison shows the new routing behavior against the expected output before any production traffic shifts.

## Review Trigger
Revisit the routing seam approach if the Edge Router's routing rule complexity grows to the point where managing multiple simultaneous extractions becomes error-prone. At that point, a purpose-built API gateway with declarative routing configuration may be more appropriate than a general-purpose reverse proxy.

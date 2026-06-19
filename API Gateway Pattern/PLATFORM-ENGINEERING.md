# Platform Engineering — API Gateway Pattern

## The Gateway as a Platform Primitive

The API Gateway is one of the first capabilities a platform engineering team should offer. It eliminates a category of work — auth, rate limiting, request tracing, TLS termination — that stream-aligned teams should never need to implement themselves.

Done well, the gateway is invisible to service teams: they register a route, the platform handles the rest. Done poorly, it becomes a bureaucratic gate that slows delivery more than the inconsistency it was meant to fix.

---

## The Paved Road Model

A paved road is a supported path through the platform that is faster and safer than building your own. The API Gateway creates a paved road for every external API:

| Without gateway (dirt road) | With gateway (paved road) |
|---|---|
| Each service implements JWT validation | JWT validation is automatic for every registered route |
| Each service writes its own rate limiting | Rate limiting is a configuration parameter, not code |
| Each service defines its own error format | Error responses are normalized at the gateway |
| Each service sets up distributed tracing | Trace propagation is automatic; services receive a `traceparent` header |
| Incident triage spans 4 services with different log formats | One structured access log covers the edge for every service |

The platform team's job is to make the paved road the path of least resistance. If it's easier to skip the gateway and call a service directly, teams will — and the platform loses its value.

---

## Self-Service Route Registration

The gateway only scales as a platform capability if teams can register routes without filing a ticket with the platform team.

### Approach: GitOps Route Config

Each service team owns a route configuration file in their repository:

```yaml
# services/orders/gateway-route.yaml
route:
  name: orders-v1
  match:
    path: /api/v1/orders
    methods: [GET, POST, PATCH]
  upstream:
    service: orders-service
    port: 8080
    health_check: /health
  auth:
    required: true
    scopes: [orders:read, orders:write]
  rate_limit:
    tier: standard          # platform-defined tiers: minimal / standard / elevated / unlimited
    burst_multiplier: 2
  timeout_ms: 5000
```

Platform team maintains the schema. CI validates route configs against the schema before merge. A gateway sync job reads all `gateway-route.yaml` files from registered services and applies them to the gateway config on each deploy.

**What teams control:** their route path, upstream, auth requirements, rate limit tier, timeout.

**What teams do not control:** the rate limit tier's actual token counts (platform-defined), WAF rules, TLS config, log schema, or the gateway runtime itself.

---

## Platform Contract

The platform team should publish and maintain a formal contract for the gateway capability:

### What the platform provides

| Capability | SLA |
|---|---|
| Gateway availability | 99.9% monthly uptime |
| P99 latency overhead | ≤ 10ms added by gateway processing (excluding upstream) |
| Route config propagation | New routes deployed within 1 deploy cycle (~5 minutes) |
| Security patches | Critical CVEs patched within 72 hours |
| Breaking change notice | Minimum 30 days notice for any breaking change to route config schema |

### What service teams are responsible for

| Responsibility | Owner |
|---|---|
| Upstream service availability | Stream-aligned team |
| Route config correctness | Stream-aligned team |
| Upstream health check endpoint | Stream-aligned team |
| SLO for upstream response time | Stream-aligned team |
| Auth scope definitions | Stream-aligned team + Security team |

---

## Developer Experience

A gateway platform that is hard to develop against creates shadow IT: teams build their own reverse proxies, Nginx configs, or direct-to-service client integrations that bypass the platform entirely.

### Local Development

Teams need a local gateway they can run without accessing the production platform:

```bash
# Run a local gateway with your service's route config
docker compose up --build

# Local gateway reads your gateway-route.yaml and runs with:
# - JWT validation disabled (or using a test IdP)
# - Rate limiting disabled
# - Full access logging to stdout
```

The example in `examples/node-express-gateway/` serves as the local development gateway. Teams can run it with their own service alongside it.

### Documentation Requirements

The platform team must maintain:
- Route config schema with examples (not just JSON Schema — real examples)
- Rate limit tier definitions (what does "standard" mean in requests/minute?)
- Error response catalog (what does a 401 vs 403 look like and what causes each?)
- Runbook for "my service is returning 502/504 through the gateway"
- Changelog for gateway config schema versions

---

## Golden Path Integration Points

The API Gateway connects to other platform capabilities:

```
Service Registry ──► Gateway Route Sync
      │                     │
      ▼                     ▼
Identity Platform ──► JWT Validation Config
      │                     │
      ▼                     ▼
Observability Platform ◄── Access Logs + Traces
      │                     │
      ▼                     ▼
Secret Management ──► JWKS + TLS Cert Delivery
```

Each of these integrations should be automatic from the service team's perspective. A team that registers a new service should not need to separately configure their service in the identity platform, the observability platform, and the gateway — the golden path does it.

---

## When the Gateway Becomes a Platform Anti-Pattern

Watch for these signals that the gateway has drifted from platform asset to platform bottleneck:

| Signal | Root cause | Fix |
|---|---|---|
| Teams file gateway tickets more than once a week | Route changes require platform team action | Move to self-service GitOps route registration |
| Gateway PRs take more than 1 day to review | Platform team is gating on correctness of service-owned config | Give teams more ownership; platform team reviews policy violations only |
| More than 20% of gateway code contains business domain terms | Business logic has leaked into the gateway | Extract to BFF or composition service; enforce via code review gate |
| Teams run their own Nginx/Traefik in front of their service | Gateway doesn't support their use case or is too slow to change | Extend the platform contract, not the workaround |
| New service onboarding takes more than 1 day for gateway setup | Onboarding is manual and platform-team-dependent | Automate: scaffold route config as part of service creation template |

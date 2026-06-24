# Cost Analysis — Backend-for-Frontend Pattern

## Cost Drivers

A BFF architecture introduces distinct cost drivers that differ from both a direct-to-domain-service model and an API Gateway model. The BFF sits between clients and domain services, which means it pays data transfer costs on both sides of every request. It also introduces compute costs for the BFF processes themselves, caching infrastructure, and the engineering time to maintain multiple diverging contracts.

| Dimension | Description |
|---|---|
| **BFF compute** | One deployable service per client type. Each must be provisioned for HA (minimum 2 instances), autoscaling, and the composition overhead of parallel upstream calls. |
| **Double data transfer** | Inbound: client → BFF (smaller, client-optimized payloads). Outbound: BFF → domain services (multiple calls per BFF request). The BFF pays egress on the domain service side and ingress on the client side. |
| **Caching infrastructure** | Each BFF maintains its own cache layer with client-specific TTLs. Mobile BFF cache is larger and longer-lived; web BFF cache is smaller with shorter TTLs. Shared cache infrastructure is possible but creates coupling. |
| **Engineering time (ongoing)** | Multiple BFF contracts must be maintained as domain service schemas evolve. Without shared libraries, duplicated logic multiplies the cost of each upstream change. |
| **Contract test infrastructure** | Consumer-driven contract tests (e.g., Pact) run per BFF per domain service pair. At 3 BFFs × 5 domain services, that is 15 contract test suites to maintain. |

---

## Option Comparison at Common Scale Tiers

### Tier 1: Small — 1–2 BFFs, under 1 million sessions/day

Typical scenario: mobile app and web app, early-stage product, one engineering team owns both BFFs.

Assumes: 2 BFFs deployed as Fargate tasks (2 tasks each for HA, 0.5 vCPU / 1GB RAM per task), Application Load Balancer per BFF, ElastiCache Redis (cache.t3.micro) per BFF.

| Item | Monthly cost |
|---|---|
| Fargate compute (2 BFFs × 4 tasks × 0.5 vCPU / 1GB) | ~$70 |
| ALB (2 load balancers) | ~$36 |
| ElastiCache Redis (2 × cache.t3.micro) | ~$25 |
| Data transfer (egress to clients + BFF → domain services) | ~$15 |
| CloudWatch logs and metrics | ~$10 |
| **Total** | **~$156/month** |

Engineering overhead at this tier is minimal. One team can maintain both BFFs. The primary risk is that shared ownership creates the same bottleneck the BFF pattern was meant to eliminate.

### Tier 2: Medium — 3–4 BFFs, 10 million sessions/day

Typical scenario: mobile, web, TV app, and partner portal BFF. Each owned by a dedicated frontend team. Domain services: Profile, Catalog, Orders, Recommendations, Inventory.

Assumes: 4 BFFs on Fargate (4 tasks each for HA, 1 vCPU / 2GB per task), ALB per BFF, ElastiCache Redis (cache.t3.medium) per BFF, higher egress volume.

| Item | Monthly cost |
|---|---|
| Fargate compute (4 BFFs × 4 tasks × 1 vCPU / 2GB) | ~$560 |
| ALBs (4 load balancers) | ~$72 |
| ElastiCache Redis (4 × cache.t3.medium) | ~$120 |
| Data transfer (egress: ~3TB/month total) | ~$270 |
| CloudWatch logs and metrics | ~$40 |
| **Total** | **~$1,062/month** |

At this tier, engineering overhead becomes the dominant cost. 4 BFF teams × the time cost of responding to upstream domain service changes. Without shared libraries, this scales poorly.

### Tier 3: Large — 5+ BFFs or BFFs with high aggregation complexity, 100 million+ sessions/day

Typical scenario: global product with mobile, web, TV, partner, and internal admin BFFs. High-fanout composition: each BFF request triggers 5–8 domain calls in parallel. Regional deployments for latency.

Assumes: 5 BFFs, 2 regions, Fargate with autoscaling (8–20 tasks per BFF per region at peak), ElastiCache Redis (cache.r6g.large) per BFF per region, significant egress.

| Item | Monthly cost |
|---|---|
| Fargate compute (5 BFFs × 2 regions × ~14 avg tasks × 2 vCPU / 4GB) | ~$14,000 |
| ALBs (5 BFFs × 2 regions) | ~$360 |
| ElastiCache Redis (5 BFFs × 2 regions × cache.r6g.large) | ~$4,800 |
| Data transfer (egress: ~30TB/month total) | ~$2,700 |
| CloudWatch logs, metrics, traces | ~$800 |
| **Total** | **~$22,660/month** |

At this tier, the engineering investment in shared libraries pays off in direct cost reduction. Every domain service schema change that a shared library absorbs instead of propagating to 5 BFF teams saves 5× the engineering time.

---

## Option Comparison: Structural Choices

### Option A: Single BFF for All Clients

Assign one BFF to serve both mobile and web clients, differentiating behavior by request header (`User-Agent`, `X-Client-Type`).

**Why it is cheaper initially:**
- One service to deploy and operate instead of two
- One cache instance
- One team's worth of maintenance

**Why it fails:**
- Mobile and web payload requirements diverge immediately. The single BFF must maintain two response shapes per endpoint, duplicating the conditional logic that was supposed to live in separate services.
- A web team feature request requires a deployment that also affects mobile clients. The deployment gate widens.
- Cache TTLs must be the shortest of either client's requirement (mobile wants 5 minutes; web wants 30 seconds; result: 30 seconds, mobile gets no battery benefit).
- Contract testing requires testing two contracts per endpoint. The "single BFF" provides no simplification on the testing surface.

**True cost vs. separate BFFs:** The initial compute saving (~$70/month at small tier) is recovered within 2 sprints of cross-client coordination overhead.

### Option B: Dedicated BFF per Client (Recommended)

One BFF per client experience, owned by the team that builds that client. Each BFF independently optimizes payload shape, cache TTLs, and resilience behavior.

This is the correct model. Costs are as shown in the tier analysis above.

### Option C: BFF with Shared Composition Library

Separate BFF deployments, but with a shared library that implements common domain service aggregation patterns. The library is owned by the platform team or a designated BFF guild.

**When it is appropriate:** When 3+ BFFs all call the same domain services in the same sequence (e.g., every BFF's home screen calls Profile, then Catalog, then Recommendations). The shared library implements the parallel call pattern; each BFF implements its own response projection.

**Risk:** The shared library becomes a bottleneck if it contains any client-specific logic. The rule is: shared library handles the call pattern and error handling; per-BFF code handles the response shape. Any library PR that contains response field names is leaking per-BFF concerns into the shared layer.

---

## Hidden Costs

These costs do not appear in infrastructure bills but are significant at scale:

| Hidden cost | Description | Mitigation |
|---|---|---|
| **Duplicated aggregation logic** | Without a shared library, each BFF reimplements parallel calls to the same 5 domain services. When the Orders service adds a required header, all 4 BFF teams must each update their code in separate sprints. | Shared library for call orchestration patterns. Per-BFF response projection only. |
| **Mobile BFF caching infrastructure when TTLs are client-specific** | Mobile BFFs benefit from aggressive caching (5–15 minute TTLs) because mobile devices are bandwidth- and battery-constrained. This requires a larger and longer-retained cache than web. If the cache is shared across BFFs, the shortest TTL wins and the mobile benefit is lost. | Separate cache instances per BFF with independently configured TTLs. |
| **Contract test maintenance across BFF × domain service matrix** | At 4 BFFs × 5 domain services, there are 20 consumer-driven contract test suites. These suites must be updated every time a domain service changes its response schema. | Invest in contract test automation early. The cost of not having tests is higher: silent regressions that reach production mobile apps. |
| **On-call scope per BFF team** | Each BFF team carries on-call responsibility for their BFF. At 4 BFFs across 4 teams, this is 4 on-call rotations. Shared on-call for all BFFs would create knowledge gaps during incidents. | Accept the cost. The per-team on-call model is correct. Platform team carries on-call for shared infrastructure (auth library, observability). |
| **BFF version deprecation** | When a client app is deprecated (old mobile OS version), its BFF contract must be maintained until all clients have migrated. Old API versions in the BFF accumulate and are rarely cleaned up. | Explicit deprecation policy per BFF contract version. Client app version telemetry to know when old versions are below 1% usage. |

---

## Cost Anti-Patterns

**1. Sequential domain service calls instead of parallel**

A BFF that calls Profile, then waits, then calls Catalog, then waits, then calls Recommendations, accumulates the latency of all three calls. Each call holds an open connection to the domain service for its duration.

At 1000 req/second, with three 100ms calls sequentially: the BFF holds 3,000 simultaneous connections for 100ms each, consuming connection pool capacity as if there were 3,000 concurrent users. With parallel calls, the same 1000 req/second requires only 1,000 simultaneous connection sets, each lasting the duration of the slowest call (not all three).

Cost impact: sequential calls require larger Fargate instances and larger connection pools to the domain services, multiplying both compute cost and connection pool licensing cost at databases.

Fix: Promise.all() or equivalent parallel dispatch for all independent domain calls. Only introduce sequential ordering when a downstream call's input depends on the output of a prior call.

**2. No caching in the BFF**

A BFF without a cache layer forwards every client request directly to domain services. At 10 million sessions/day with an average of 5 domain calls per BFF request, this is 50 million domain service calls per day that could be substantially reduced with a cache hit rate of even 40%.

The Catalog and Recommendations services are particularly expensive to call at high frequency because they often involve database reads. If the BFF caches catalog data for 5 minutes with a 40% hit rate, domain service read load drops by 40% — a direct infrastructure cost reduction at the domain service layer.

**3. BFF response body logging**

Full response body logging at the BFF layer multiplies log cost by the number of domain responses assembled into each BFF response. A BFF that aggregates 5 domain responses and logs all of them generates 5× the log volume of logging only the final assembled response — and the final assembled response is itself often 5× larger than a gateway access log entry.

At 10 million sessions/day with 2KB average response bodies and 5 domain calls logged per request, full body logging generates approximately 100GB of log data per day. At $0.50/GB for CloudWatch Logs ingestion, this is $50/day or $1,500/month in logging costs alone — for data that is rarely read and cannot be indexed efficiently.

Fix: Log the assembled BFF response envelope (status, latency, endpoint, client type, upstream call summary) rather than response bodies. Enable body logging only for specific incident investigation windows via feature flag, not as the default configuration.

**4. Identical cache configuration across BFFs**

If the mobile BFF and web BFF use the same cache TTLs because cache configuration is shared, the mobile BFF loses its primary performance advantage. Mobile clients benefit from longer cache TTLs (battery cost of re-fetching data is significant; staleness is acceptable for catalog browsing). Web clients tolerate shorter TTLs because the browser handles the re-render.

Cost impact: mobile BFF with web-appropriate TTLs drives 3–5× higher domain service read volume than necessary. This cost accumulates across all domain services the BFF calls.

---

## Cost by Decision Point

| Decision | Lower cost option | Higher cost option | When to choose higher |
|---|---|---|---|
| Single BFF vs. dedicated per client | Single BFF (initially) | Dedicated per client | Always — single BFF incurs coordination cost that exceeds compute savings within 2 sprints |
| Self-managed Redis vs. ElastiCache | Self-managed (compute cost) | ElastiCache (managed cost) | Always at medium/large tier; operational overhead of self-managed Redis exceeds the cost delta |
| Shared composition library vs. per-BFF duplication | Shared library (higher upfront cost) | Per-BFF duplication (lower initial cost) | At 3+ BFFs calling the same domain services; shared library ROI is positive after first domain schema change |
| In-process cache vs. external Redis | In-process (no infrastructure cost) | External Redis | In-process cache is lost on pod restart; not viable for BFFs with aggressive TTLs; use Redis at any meaningful scale |
| Fargate vs. EC2 for BFF compute | Fargate (pay per use, no management) | EC2 reserved instances (lower unit cost) | EC2 reserved wins only when BFF load is flat and predictable — rare for mobile BFFs with peak/off-peak traffic patterns |

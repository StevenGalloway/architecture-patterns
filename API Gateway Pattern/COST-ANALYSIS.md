# Cost Analysis — API Gateway Pattern

## Cost Drivers

An API Gateway introduces costs across four dimensions:

| Dimension | Self-Hosted | Managed (Cloud) |
|---|---|---|
| **Compute** | EC2/Fargate for gateway processes | Included in per-request pricing |
| **Network** | Data transfer (ingress free, egress ~$0.09/GB on AWS) | Data transfer (same) |
| **Operations** | Engineer time for upgrades, on-call, HA config | Minimal; vendor-managed |
| **Licensing** | OSS = $0; Kong Enterprise/Apigee = $10K–$100K+/year | Included in per-request cost |

---

## Option Comparison at Common Traffic Levels

### Option A: Self-Hosted (Kong OSS or Express on ECS Fargate)

Assumes: 2 Fargate tasks (1 vCPU, 2GB RAM each) for HA, Application Load Balancer, CloudWatch logging.

| Traffic | Fargate (2 tasks) | ALB | Data Transfer (egress) | Total/month |
|---|---|---|---|---|
| 1M req/month | $58 | $18 | ~$1 | **~$77** |
| 10M req/month | $58 | $20 | ~$9 | **~$87** |
| 100M req/month | $116 (scale out) | $25 | ~$90 | **~$231** |
| 1B req/month | $580 (scaled fleet) | $40 | ~$900 | **~$1,520** |

Does not include: engineering time for on-call (~0.1 FTE), upgrades, and incident response.

### Option B: AWS API Gateway (HTTP API)

$1.00 per million API calls. Data transfer at standard AWS rates. No operational overhead.

| Traffic | API calls | Data Transfer | Total/month |
|---|---|---|---|
| 1M req/month | $1.00 | ~$1 | **~$2** |
| 10M req/month | $10.00 | ~$9 | **~$19** |
| 100M req/month | $100.00 | ~$90 | **~$190** |
| 1B req/month | $1,000.00 | ~$900 | **~$1,900** |

### Option C: AWS API Gateway (REST API)

$3.50 per million API calls. Use when you need request/response transformation, usage plans, or custom authorizers.

| Traffic | API calls | Data Transfer | Total/month |
|---|---|---|---|
| 10M req/month | $35.00 | ~$9 | **~$44** |
| 100M req/month | $350.00 | ~$90 | **~$440** |
| 1B req/month | $3,500.00 | ~$900 | **~$4,400** |

### Option D: Kong Konnect (Managed)

Starts at ~$0.20/million API calls (standard tier), scales to $2.00/million (enterprise tier with RBAC, analytics, dedicated nodes).

| Traffic | Standard tier | Enterprise tier |
|---|---|---|
| 10M req/month | ~$2 + $50 base | ~$20 + $500 base |
| 100M req/month | ~$20 + $50 base | ~$200 + $500 base |
| 1B req/month | ~$200 + $50 base | ~$2,000 + $500 base |

### Option E: Apigee (Google Cloud)

Enterprise-grade API management. Pricing starts at ~$1,500/month (Evaluation), scales to $10,000–$50,000+/year for production tiers. Suited for large enterprises with API monetization, developer portals, or strict compliance requirements.

---

## Break-Even Analysis

**Self-Hosted vs. AWS HTTP API:**

The infrastructure cost of self-hosting (~$77–87/month minimum) exceeds AWS HTTP API pricing until roughly **80–100M requests/month**. Below that threshold, managed is almost always the correct economic choice when you factor in operational burden.

At 1B+ requests/month, self-hosted becomes cost-competitive *only if* you have the engineering capacity to run it without meaningful on-call overhead.

**Rule of thumb:**
- Under 50M req/month → AWS HTTP API or equivalent managed service
- 50M–500M req/month → evaluate self-hosted vs. managed based on team capacity
- 500M+ req/month → self-hosted or enterprise contract typically wins on unit cost

---

## Hidden Costs

These are not in the table above but are often the deciding factor:

| Cost | Self-Hosted | Managed |
|---|---|---|
| **Engineering time (setup)** | 2–4 weeks | 1–3 days |
| **Engineering time (ongoing)** | 0.1–0.25 FTE/year | Near zero |
| **Incident response** | On your on-call rotation | Vendor SLA (check it carefully) |
| **Version upgrades** | Manual, requires testing | Automatic (verify zero-downtime guarantees) |
| **Feature gaps** | Fill them yourself | Pay for higher tier or accept limits |
| **Vendor lock-in** | Low (OSS) | Medium-High (proprietary config DSL) |

---

## Cost Anti-Patterns

**1. Aggregation logic in the gateway**
Every aggregation endpoint that calls 3 upstream services and waits for all responses holds a connection 3× longer than a pass-through route. At scale, this multiplies your compute cost. Push aggregation to a BFF or composition service.

**2. Logging all request/response bodies**
Full payload logging can generate 10–50× more log data than header-only access logs. At 10,000 req/second, full body logging on a typical API can cost $2,000–$8,000/month in log storage alone. Log the envelope (headers, status, latency, IDs), not the body, unless debugging a specific incident.

**3. Synchronous JWKS validation on every request**
Fetching the JWKS endpoint on every request adds 20–80ms and costs money in external HTTP calls. Cache the JWKS in memory with a 5-minute TTL. Rotate handling: on 401 from downstream, invalidate cache and re-fetch once.

**4. Underprovisioning the gateway for traffic spikes**
A single gateway outage during a traffic spike that affects all services costs far more than the extra Fargate capacity needed for autoscaling. Set autoscaling triggers at 60% CPU/memory, not 80%.

---

## Cost by Decision Point

| Decision | Lower cost option | Higher cost option | When to choose higher |
|---|---|---|---|
| Managed vs. self-hosted | Managed (at low traffic) | Self-hosted (at scale) | >500M req/month, strong ops team |
| HTTP API vs. REST API | HTTP API ($1/M) | REST API ($3.50/M) | Need usage plans, custom authorizers, request transforms |
| OSS vs. enterprise gateway | OSS (Kong, Traefik) | Enterprise (Apigee, Kong Enterprise) | Developer portal, API monetization, dedicated support SLA |
| Single gateway vs. multi-region | Single region | Multi-region ($2–4×) | Active-Active requirement, global customer base, >99.9% availability SLO |

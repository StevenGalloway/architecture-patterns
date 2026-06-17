# Cost Analysis — Anti-Corruption Layer Pattern

## Cost Drivers

An Anti-Corruption Layer introduces costs across five dimensions that differ meaningfully from other integration patterns:

| Dimension | Description |
|---|---|
| **Compute** | The ACL adapter service runs persistently (or as a sidecar) and processes every inbound vendor response. Translation logic is CPU-cheap for most workloads, but schema validation against large vendor payloads can be measurable at high volume. |
| **Data transfer** | Vendor API calls traverse the public internet. Inbound data (vendor response payloads) is typically free; outbound query calls and any webhook registrations may incur egress costs. |
| **Vendor API rate limits** | Many vendor APIs charge per-call or impose rate ceilings that require upstream request queuing, caching, or pagination logic — all of which have engineering and infrastructure cost. |
| **Mapping maintenance** | Every time a vendor updates their API schema, an engineer must update the translation function, update contract test fixtures, and validate the canonical output is still correct. This is the most consistently underestimated cost. |
| **Contract test infrastructure** | Running contract tests against the real vendor in a staging environment (preferred over mocks) requires a standing vendor sandbox account and may have usage costs. |

---

## Deployment Options

Three deployment options exist, with materially different cost profiles:

### Option A: Embedded ACL Library (no separate service)

The translation logic lives as a library imported directly into consuming domain services. No separate service, no network hop.

**Suitable for:** One consumer, one or two vendors, low-to-medium call volume, where the canonical model is not shared across teams.

**Cost implication:** Minimal infrastructure cost. The hidden cost is maintenance: when the library is updated for a vendor schema change, every consuming service must redeploy. At two services this is manageable. At six, it defeats the purpose.

### Option B: Sidecar ACL (co-deployed with consuming service)

The ACL runs as a container sidecar alongside each consuming service. No central choke point. Each service gets its own ACL instance.

**Suitable for:** Multi-team environments where blast radius isolation matters more than operational simplicity. If the Customer domain ACL has a bug, it does not affect the Order domain ACL.

**Cost implication:** Sidecar containers multiply compute cost (N services × sidecar memory/CPU overhead). At low volume this is negligible. At 20+ services, the sidecar compute can exceed the cost of a dedicated service.

### Option C: Dedicated ACL Service (recommended for three or more vendors)

A standalone service handles all vendor integrations. Domain services call the ACL over internal network; ACL calls vendor APIs and returns canonical models.

**Suitable for:** Multiple vendors, multiple consuming teams, shared canonical model governance, centralized credential management.

**Cost implication:** Higher baseline infrastructure cost (one always-on service), but lower total cost at scale due to shared caching, shared circuit breaker state, and single deployment target for mapping updates.

---

## Cost Comparison at Three Traffic Tiers

### Tier 1: Low Volume (1–2 vendor integrations, < 100K vendor API calls/day)

| Item | Embedded Library | Sidecar | Dedicated Service |
|---|---|---|---|
| Compute | $0 (absorbed by service) | ~$15/month (256MB sidecar × 1 service) | ~$30/month (0.5 vCPU, 512MB, Fargate) |
| Vendor API calls | $0–$50/month (vendor-dependent) | $0–$50/month | $0–$50/month |
| Response cache (Redis) | Not applicable | Optional, ~$15/month | ~$15/month (ElastiCache t3.micro) |
| Contract test infra | ~$0 (dev sandbox) | ~$0 | ~$0 |
| Engineering maintenance | 0.05 FTE/year | 0.05 FTE/year | 0.1 FTE/year |
| **Monthly infrastructure total** | **~$50** | **~$80** | **~$95** |

### Tier 2: Medium Volume (3–5 vendor integrations, 1M+ vendor API calls/day)

At 1M vendor API calls/day, caching becomes essential. A cache hit rate of 80% reduces vendor API calls (and any associated vendor per-call costs) by 4×.

| Item | Sidecar (per service) | Dedicated Service |
|---|---|---|
| Compute | ~$50/month × N services | ~$120/month (2 × 1 vCPU / 1GB Fargate tasks for HA) |
| Response cache (Redis) | ~$30/month per service | ~$30/month (shared, ElastiCache t3.small) |
| Vendor API charges | $100–$500/month depending on vendor pricing | Same, but cache is shared → lower effective call count |
| Contract test runner (CI) | ~$20/month CI minutes | ~$20/month CI minutes |
| Engineering maintenance | 0.2 FTE/year | 0.2 FTE/year |
| **Monthly infrastructure (3 services)** | **~$300–$500** | **~$170–$370** |

The dedicated service option becomes cost-competitive at 3+ consuming services because the cache and circuit breaker state are shared, reducing total vendor API calls significantly.

### Tier 3: High Volume (5+ vendor integrations, 10M+ vendor API calls/day)

At 10M vendor API calls/day, the ACL becomes a high-throughput service that requires autoscaling, multi-AZ deployment, and careful cache tuning.

| Item | Estimated Cost |
|---|---|
| ACL service compute (auto-scaled, 4–8 tasks, 2 vCPU / 2GB each) | ~$400–$800/month |
| Redis (ElastiCache r6g.large, multi-AZ) | ~$180/month |
| Data transfer (vendor API responses ingressed at ~1KB avg × 10M/day) | ~$80–$120/month |
| Contract test infrastructure (dedicated staging environment) | ~$100/month |
| Engineering maintenance | 0.4–0.5 FTE/year |
| **Monthly infrastructure total** | **~$760–$1,200** |

At this volume the dominant cost is engineering: 0.5 FTE dedicated to mapping maintenance, canonical model governance, and vendor relationship management exceeds all infrastructure costs combined.

---

## Break-Even: Dedicated Service vs. Embedded Library

The dedicated service has higher infrastructure cost but lower total cost of ownership once mapping maintenance burden is shared. Break-even occurs at approximately the second consuming team:

| Consumers | Embedded Library (maintenance cost) | Dedicated Service (infra + maintenance) |
|---|---|---|
| 1 team | Low | Higher infra, same maintenance |
| 2 teams | 2× maintenance (duplicate mapping PRs) | 1× maintenance (shared, deployed once) |
| 3+ teams | 3× maintenance + coordination cost | 1× maintenance, coordination is platform-managed |

The crossover point in practice is typically around 2–3 consuming teams or 3+ vendor integrations. Beyond that, the dedicated service pays for itself in reduced coordination overhead.

---

## Hidden Costs

These are not in the tables above, but frequently dominate the actual cost of the pattern:

**1. Mapping maintenance when vendor APIs change**

Every vendor schema change requires: identifying which fields changed, updating translation functions, updating contract test fixtures, running integration tests against the vendor sandbox, reviewing the canonical output for correctness, deploying. This is a minimum of 4–8 engineering hours per vendor schema change. Enterprise vendors change their APIs 2–6 times per year. With 5 vendors, this is 40–240 engineering hours per year — $8,000–$48,000 at a $200/hour blended rate.

**2. Canonical model governance**

As the number of consumers grows, changes to the canonical model require cross-team coordination. A rename of `accountId` to `customerId` in `CanonicalCustomer` requires PRs in every consuming service. Budget for canonical model change management as a recurring cost from the moment you have 3+ consumers.

**3. Contract test maintenance**

Contract tests that run against the real vendor require the vendor to maintain a stable sandbox environment. Many vendors do not. Engineering time spent keeping contract tests green against a flaky vendor sandbox is often invisible in cost estimates but significant in practice. Budget 0.05 FTE/year per vendor sandbox that requires active maintenance.

**4. Vendor sandbox accounts**

Each vendor typically requires a separate sandbox or staging account for contract testing. Vendor SaaS pricing for sandbox environments ranges from free to hundreds of dollars per month per vendor.

---

## Cost Anti-Patterns

**1. Calling the vendor API twice — once for validation, once for data**

Some implementations validate the vendor response schema in a separate call before fetching the full payload. This doubles vendor API call count, doubles egress cost, and halves effective rate limit headroom. Schema validate against the payload you already fetched; never fetch twice.

**2. Not caching vendor responses on read paths**

Vendor APIs typically expose data that changes slowly (customer profile, product catalog, account status). Calling the vendor API on every internal request for this data wastes money and consumes rate limit quota. A 5-minute TTL cache on a read-heavy path can reduce vendor API calls by 90%+. The rule: if the vendor data changes less frequently than your consumers read it, cache it.

**3. Synchronous ACL on hot read paths**

If the ACL is called synchronously on every request to a high-throughput read endpoint, the ACL's latency directly adds to your P99. At 10K requests/second, a 50ms ACL call adds 500 CPU-seconds of blocking latency per second. Pre-fetch and cache vendor data asynchronously; serve from cache on the hot path.

**4. Over-translating (mapping all vendor fields "just in case")**

Translating fields that no consumer uses today still requires maintenance when the vendor renames or removes those fields. Map only what is explicitly consumed. The unused-field maintenance cost is not zero — it is paid at every vendor schema change.

**5. Separate circuit breakers per consumer instead of shared state**

If each consuming service runs its own circuit breaker against the vendor API, each sees a different view of vendor health. One service may be hammering a degraded vendor while another has opened its circuit breaker. A shared circuit breaker state (Redis-backed) in the dedicated ACL service means all consumers see vendor health consistently and the vendor is not overwhelmed during partial outages.

---

## Cost by Decision Point

| Decision | Lower cost | Higher cost | When to choose higher |
|---|---|---|---|
| Embedded library vs. dedicated service | Library (no infra) | Dedicated service (~$95/month baseline) | 3+ vendors, 2+ consuming teams |
| Cache vs. no cache | No cache ($0) | Redis cache (~$15–$180/month) | Vendor data read more than once per TTL period |
| Strict schema validation vs. lenient | Lenient (no cost) | Strict (CPU overhead ~5%) | Regulated data, PCI/GDPR scope, vendor with history of silent schema changes |
| Shared canonical model package vs. per-team types | Per-team types (no coordination) | Shared package (~0.1 FTE governance) | 3+ consuming teams that reference the same vendor entity |
| Multi-AZ ACL vs. single-AZ | Single-AZ | Multi-AZ (1.5–2× compute cost) | ACL is on critical path for any feature with 99.9%+ availability SLO |

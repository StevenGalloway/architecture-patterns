# Executive Brief — Caching Strategies

**Audience:** CPO, CFO, VP Engineering
**Decision required:** Approve implementation of Redis caching layer for product catalog and high-frequency read paths

---

## The Problem We Have Today

Our database is answering the same questions thousands of times per day.

Product catalog reads account for 70% of all database queries. Of those reads, 85% are for the same 2,000 products — the most popular items in our catalog. Our database is answering the same question about the same products roughly 50,000 times a day.

This is not a database performance problem. It is an efficiency problem. We are doing expensive work (disk IO, query parsing, lock acquisition, result serialization) to produce results that haven't changed since the last time we produced them. A user loading the product page for "Blue Widget Pro" at 9:00am and a different user loading the same page at 9:01am each trigger a full database read, even though nothing changed in between.

At current traffic, the database handles this load. The problem is what happens as we grow. Database read capacity scales with hardware cost. Our current trajectory means we will need a larger, more expensive database tier in roughly 6 months to maintain acceptable page load times — not because our data is more complex, but because we're answering the same questions more times.

---

## What We're Proposing

We are adding a caching layer (Redis) that answers repeated reads from memory instead of the database.

The first time a product is requested, we query the database as today. The result is stored in Redis. Every subsequent request for that product within a 5-minute window is answered from Redis in under 1 millisecond — without touching the database.

From a user's perspective: the product page loads faster. From a database's perspective: 80% fewer queries arrive, and the ones that do arrive are for genuinely new or updated data.

This is not a new or experimental approach. Redis is used by Amazon, Twitter, GitHub, and the majority of companies at our scale for exactly this problem.

---

## What This Costs

| Item | Estimate |
|---|---|
| Engineering time (implementation + testing) | 1 engineer × 2 weeks |
| Redis infrastructure (monthly, current traffic) | $120–$300/month |
| Ongoing operational overhead | < 2 hours/month |
| **One-time total** | **~2 engineer-weeks** |
| **Recurring monthly** | **< $300** |

The $120–$300/month figure is for a managed Redis service (AWS ElastiCache) with automatic failover and no operational overhead. This is a known, predictable, fixed cost.

---

## What the Business Gets

**60–70% reduction in database read load**
The 2,000 hot products account for 85% of our catalog reads. Caching them reduces total database query volume by 60–70% at current traffic. This directly defers the database scaling cost we would otherwise face in 6 months.

**User-visible performance improvement**
P99 latency for product page loads drops from approximately 200ms (current database-backed read) to under 10ms for cache hits. A 190ms improvement at the 99th percentile is measurable in A/B tests and correlates with conversion rate improvements of 1–3% in published industry studies.

**Headroom to absorb 5–10× traffic growth**
With caching, our current database handles 5–10× today's traffic for the product catalog without requiring a hardware upgrade. We are buying time and flexibility, not just solving today's problem.

**Operational resilience during traffic spikes**
Flash sales, press coverage, and marketing campaigns create traffic spikes that are hard to predict. A database under 30% normal load has significant headroom to absorb a 5× spike. A database at 80% normal load does not. Caching creates the headroom.

---

## Risk of Inaction

Without caching, our database costs scale linearly with traffic. Every doubling of users roughly doubles the database query load, which requires a larger, more expensive database tier.

Current database tier (RDS r6g.2xlarge): ~$400/month
Next tier up (RDS r6g.4xlarge): ~$800/month
Tier after that (RDS r6g.8xlarge): ~$1,600/month

A $300/month Redis cache defers a $400/month database upgrade. If we require two tier upgrades before addressing the read efficiency problem, caching pays for itself within 3 months of avoiding the first upgrade — and continues to pay dividends at every subsequent traffic doubling.

Beyond cost: database performance degradation under load is user-visible. A product page that takes 3 seconds to load because the database is saturated is a lost sale. We will not get early warning on this degradation until it is already affecting conversion rates.

---

## What We Are Not Doing

To be clear about what this change does and does not involve:

- We are not changing the database schema
- We are not changing any customer-facing URLs or API contracts
- We are not requiring any client changes (this is backend infrastructure)
- We are not building a distributed cache cluster — we are starting with a single managed Redis instance that can be scaled when needed
- We are not caching everything — we are starting with the specific high-read, low-change data (product catalog) that provides the highest return

This is a targeted improvement to a known bottleneck with a clear cost model, a defined rollback path (remove the cache, reads fall back to the database), and no API contract changes.

---

## Recommendation

Approve implementation. The two-week engineering investment and $300/month infrastructure cost defer a near-term database scaling cost, deliver a user-visible performance improvement, and create the headroom to absorb substantial traffic growth. The risk of inaction is a predictable and near-term infrastructure cost increase with associated user experience degradation.

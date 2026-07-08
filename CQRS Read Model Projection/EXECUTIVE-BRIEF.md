# Executive Brief — CQRS Read Model Projection

**Audience:** CPO, CFO, VP Engineering, non-technical stakeholders
**Decision required:** Approve implementation of CQRS read model projections for the Orders service

---

## The Problem We Have Today

Our Orders database is doing three jobs that have become incompatible with each other.

**Job 1 — Customer-facing order history.** When a customer opens the app and views their past orders, the app queries our Orders database. This query must return in under 100 milliseconds or customers see a loading spinner. We have a contractual response time target.

**Job 2 — Fulfillment dashboard.** Our fulfillment operations team has a live dashboard showing open order counts by product and warehouse. This dashboard polls the database every 30 seconds. At peak hours, these polling queries hold database connections long enough that order creation operations time out waiting for a connection. Customers placing orders during these windows see errors.

**Job 3 — Business intelligence reporting.** The BI team runs daily reports on the orders table: revenue by product, order volume trends, cancellation rates. These are full-table scans. When they run, they consume enough I/O that customer-facing queries become slower for everyone.

**The failed fix we have tried:** Every time the BI team needs a new report, they request a new database index from the engineering team. Adding an index to a large table requires a maintenance window and causes 2–4 minutes of write degradation — meaning order creation is degraded or unavailable for that window. The engineering team has declined several BI requests because the index cost was too high. The BI team is blocked on their reporting roadmap.

These three problems are not independent. They share one root cause: the same database is trying to be optimized for row-level customer access, real-time aggregate counts, and full-table analytics simultaneously. These access patterns are physically incompatible. No amount of tuning resolves the conflict — as data volume grows, it gets worse.

---

## What We Are Proposing

We are separating "writing orders" from "reading orders" at the infrastructure level.

When an order is created or updated, that change is still written to the existing Orders database — nothing changes about how order data is created or stored authoritatively. Immediately after a write, the system emits a lightweight notification ("an order was just created"). A background service picks up these notifications and automatically maintains three separate, purpose-built views of the order data:

- **Customer order history database:** A copy of order data structured specifically for customer history queries. Optimized for fast pagination, sort by date, and status filtering. The customer-facing app reads from this, not the main database.
- **Fulfillment cache:** A live count of open orders by product and warehouse, updated automatically each time an order changes. The fulfillment dashboard reads this directly instead of polling the orders table. No more connection contention.
- **Analytics database:** A separate analytics-optimized store that the BI team queries. Running a full analytics scan on this store has zero impact on order creation or customer-facing performance. The BI team can add new analytics views without any engineering coordination.

The result: the main Orders database handles only writes. Each read use case has its own store, optimized for its own access pattern, isolated from every other consumer.

---

## What This Costs

| Item | Estimate |
|---|---|
| Engineering time (implementation) | 2 engineers × 4 weeks |
| Infrastructure (monthly, ongoing) | $500–$2,000/month additional |
| Ongoing operational overhead | ~3–5 hours/week at steady state |
| **One-time total** | **~8 engineer-weeks** |
| **Recurring monthly** | **$500–$2,000 depending on read model store choices** |

The infrastructure cost range reflects the choice of managed vs. self-hosted components. Using AWS managed services (ElastiCache for the fulfillment cache, Aurora for customer history) lands at the higher end but eliminates operational overhead for those stores.

---

## What We Gain

**Customer order history stops competing with BI.** Customer-facing pages read from a dedicated database that is never touched by analytics queries. BI queries can run at any time without affecting customers.

**Write operations stop timing out during dashboard polls.** The fulfillment dashboard reads from a Redis cache that is updated automatically. No more database connection contention between writes and dashboard polling.

**The BI team can self-serve new analytics views.** New reports are a configuration change to the analytics read model, not a database schema change requiring a maintenance window. The BI roadmap unblocks.

**The engineering team stops being the bottleneck for BI.** Currently, every BI request that requires a new index requires an engineering ticket, a review of index cost, and a maintenance window. Under this design, analytics views are the BI team's responsibility. Engineering focuses on the write path.

---

## What Happens If We Do Not Do This

The current situation degrades linearly with order volume. At current growth rates:

- Fulfillment dashboard polling will cause write timeouts more frequently as order volume increases. What is currently occasional will become regular.
- BI query runtime will grow as the orders table grows. Full-table scans that take 30 seconds today will take 3 minutes in 18 months. The BI team will increasingly compete with customer-facing traffic for the same I/O.
- The cost of adding any BI index to the orders table — already 2–4 minutes of degradation — grows with table size. We will eventually need to stop adding indexes entirely.

This is not a risk that might materialize. It is a linear trajectory we are already on.

---

## Recommendation

Approve implementation. The 8 engineer-weeks of investment eliminates a structural performance conflict that will otherwise require increasing engineering attention at every order volume milestone. The $500–2,000/month infrastructure cost is justified by the elimination of fulfillment write timeouts (measurable revenue impact), the reduction of customer-facing order history latency, and the unblocking of BI reporting that currently requires engineering coordination.

---

## What We Are Not Doing

To be clear about scope:

- **Not changing how orders are created.** The order creation flow, validation rules, and data model are unchanged.
- **Not rebuilding the existing system.** We are adding a background synchronization layer. The existing Orders database remains authoritative.
- **Not requiring real-time consistency where the business does not need it.** The customer order history and fulfillment dashboard will be updated within 1–2 seconds of a write. For a customer refreshing their order history or a fulfillment team viewing dashboard counts, this lag is imperceptible.
- **Not selecting a proprietary vendor that creates lock-in.** The projector service is custom code. The event bus and read model stores are commodity infrastructure (Kafka or AWS SNS, Redis, PostgreSQL).

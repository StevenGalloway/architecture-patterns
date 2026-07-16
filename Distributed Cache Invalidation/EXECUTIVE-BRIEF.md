# Executive Brief — Distributed Cache Invalidation

**Audience:** CPO, CFO, VP Engineering
**Decision required:** Approve implementation of distributed cache invalidation for the Product API fleet

---

## The Problem We Have Today

To handle our traffic volume, we run 8 copies of the Product API simultaneously. Each copy keeps its own local data cache to respond quickly — instead of asking the database for a product's price on every request, the server remembers the answer for 60 seconds.

This creates a consistency problem that gets worse as we scale.

When a product price changes for a flash sale, the server that applied the change updates its own cache — but the other 7 servers don't know the price changed. Customers are routed randomly between servers. So 7 out of 8 customers see the old price until each server's cache naturally expires, up to 60 seconds later.

**This is the inconsistency window:** the time between a data change and all servers reflecting it. Right now, that window is up to 60 seconds for every pricing and availability change.

**Concrete examples of the business impact:**
- A flash sale launches at 2:00 PM. For up to 60 seconds, 7 of 8 customers see the pre-sale price. Customers on the "wrong" server during that window lose the sale price, call support, or abandon the purchase.
- A product goes out of stock. The inventory system marks it unavailable, but 7 of 8 servers continue showing it as available for up to 60 seconds. Customers add it to their cart, complete checkout, and then receive an out-of-stock cancellation email.
- We add a 9th server to handle load during a peak event. The problem doesn't get better — it gets worse. More servers means more copies of stale data circulating simultaneously.

---

## What We're Doing

We are adding a lightweight notification system (NATS — an industry-standard message broker) that sends a signal to all 8 servers the moment data changes.

When a price changes, the notification goes out immediately. All 8 servers receive it, each drops the old price from their cache simultaneously, and the next customer request on any server loads the new price directly from the database. The inconsistency window shrinks from 60 seconds to **under 1 second**.

Nothing about the API changes. Nothing about the database changes. Customers don't experience any difference in speed or behavior — except that the prices and availability they see are accurate.

If the notification system were to fail entirely, the existing 60-second cache behavior resumes automatically as a fallback. This is a safe-to-fail addition.

---

## Cost

| Item | Estimate |
|---|---|
| Engineering time | 1 engineer × 2 weeks |
| Infrastructure (monthly, ongoing) | ~$120/month (3-node NATS cluster for reliability) |
| Changes to existing systems | None — existing API, database, and cache are unchanged |

---

## What the Business Gains

**Flash sale accuracy.** Price changes propagate to all servers in under 1 second. A flash sale launch at 2:00 PM means all 8 servers show the correct price at 2:00 PM, not at 2:01 PM. No customer sees the wrong price during a sale launch.

**Real-time inventory accuracy.** When a product goes out of stock, all servers reflect that status in under 1 second. No customer completes a purchase for an unavailable item based on a stale cache. The out-of-stock cancellation email goes from an operational reality to an edge case.

**Confidence to scale.** We can add more servers to handle growth without making the stale data problem worse. Invalidation events broadcast to all servers simultaneously — 8 servers or 80 servers, the consistency window stays under 1 second.

**Better database efficiency.** Because we can now trust the cache to be accurate, we can keep non-critical data in cache longer without worrying about stale reads. This reduces database query volume during peak periods.

---

## What Happens If We Don't Do This

The stale data problem scales with our infrastructure. Every server we add to handle traffic is another server that can serve stale prices and availability information. The more we scale to meet customer demand, the more customers are affected during change windows.

The customer-facing cost of a single price inconsistency incident — in support tickets, chargebacks, and brand trust — exceeds the $120/month infrastructure cost of preventing it. One customer support escalation during a flash sale launch takes more than two months of infrastructure cost to handle.

There is no cheaper fix. The alternative approaches — refreshing the cache more frequently, or not caching at all — either increase database load substantially (and require a larger, more expensive database tier) or eliminate the performance benefits the cache provides.

---

## What We Are Not Doing

To be clear about scope:
- We are not changing the database, the API contracts, or any customer-facing behavior
- We are not removing the existing cache — this extends it, not replaces it
- We are not introducing a vendor that creates lock-in (NATS is open-source)
- We are not increasing API response times — the notification infrastructure operates in the background, invisible to request latency

---

## Recommendation

Approve implementation. Two weeks of engineering time and $120/month in infrastructure closes a known consistency gap that worsens as we scale, protects the integrity of time-sensitive commercial events (flash sales, inventory updates), and enables us to grow the server fleet without growing the stale data problem proportionally.

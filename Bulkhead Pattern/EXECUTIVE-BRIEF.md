# Executive Brief — Bulkhead Pattern

**Audience:** CPO, CFO, VP Engineering, non-technical stakeholders
**Decision required:** Approve implementation of per-dependency resource isolation (Bulkhead pattern) in the Order Processing service

---

## The Problem We Discovered

During a Black Friday load test, the Fraud Detection service experienced a database performance problem. Its response time increased from 80ms to 1,400ms. This is the Fraud Detection team's problem to solve — and they will solve it separately.

But that problem should have stayed contained to Fraud Detection.

Instead, it caused 100% of all order creation to fail — including orders from established, known-good customers who had no fraud signals and whose orders never needed to touch Fraud Detection at all. A customer who had placed 50 orders with us over three years could not place order 51, not because anything about their order was problematic, but because a different service had a database problem.

**How this happened:** All of our outbound calls — to Payment, to Inventory, to Fraud Detection, and to Notification — shared a single pool of 200 connections. When Fraud Detection slowed down, its connections stayed open longer. Within 90 seconds, Fraud Detection was holding 160 of the 200 available connections. Payment processing and Inventory checks had only 40 connections left to share, which was not enough to handle normal order volume. Every order — even orders that had already completed their fraud check — failed for lack of connections to reach Payment and Inventory.

The Fraud Detection problem cascaded into a total outage through shared infrastructure.

---

## What We Are Proposing

We allocate a separate connection budget to each downstream service, so that one service's problems are contained to that service's budget and cannot consume the budget allocated to other services.

This is called a Bulkhead — the same principle as ship compartments that prevent a single hull breach from sinking the entire vessel.

**The specific allocations:**

| Service | Current (shared) | Proposed (dedicated) | Classification |
|---|---|---|---|
| Payment Service | Shared 200-connection pool | 80 dedicated connections | Critical path |
| Inventory Service | Shared 200-connection pool | 60 dedicated connections | Critical path |
| Fraud Detection | Shared 200-connection pool | 30 dedicated connections | Non-critical |
| Notification Service | Shared 200-connection pool | 20 dedicated connections | Non-critical |

Under this configuration, a repeat of the Black Friday incident would look like: Fraud Detection slows down, fills its 30-connection budget, and all additional Fraud Detection requests are immediately declined. Payment and Inventory each retain their dedicated budgets, completely unaffected. Orders from established customers — who do not require synchronous fraud checks — continue processing normally. Only new customers, whose orders require a synchronous fraud check, experience a degraded checkout until Fraud Detection recovers.

A problem that previously affected 100% of orders would affect approximately 5% of orders — the subset that require synchronous fraud checks.

---

## What This Costs

| Item | Estimate |
|---|---|
| Engineering time (implementation) | 1 engineer × 1 week per service |
| Infrastructure | $0 additional — uses existing compute |
| Ongoing maintenance | 2–4 hours/quarter (reviewing that limits remain correctly sized as traffic grows) |

The implementation adds software-level controls — semaphores — that consume no meaningful additional compute resources. There is no new infrastructure to provision, no new vendor to pay, and no change to the services we call.

---

## What We Gain

**Fault isolation, immediately.** A degraded non-critical service (Fraud Detection, Notifications) can no longer take down a critical-path service (Payment, Inventory). This is the primary benefit and it applies on day one.

**Faster incident triage.** When an incident occurs, engineers can immediately see which dependency's connection budget is exhausted. The current situation — where shared pool exhaustion requires manual log correlation to identify which dependency is the cause — produces triage times of 15–30 minutes. With dedicated budgets and per-dependency metrics, identification is immediate.

**Confidence during high-traffic events.** With this change in place, the team can enter Black Friday knowing that a single dependency problem cannot cause a full outage. This directly reduces on-call anxiety and enables a faster, more considered incident response.

**SOC 2 and PCI evidence.** Payment processing capacity is guaranteed to be protected from non-payment service failures. This is directly relevant to our PCI compliance posture and to the availability controls required for SOC 2.

---

## What Happens If We Don't Do This

Every high-traffic event — Black Friday, marketing campaigns, product launches — carries the same all-or-nothing risk. If any downstream service degrades during peak traffic, total order failure is the outcome.

This is not a theoretical risk. We observed it directly. The only reason it was a load test and not a live customer incident was timing. The next Black Friday is a live event.

The cost of one hour of total order failure during a peak event — in lost revenue, customer trust, and incident response — significantly exceeds the cost of this implementation.

---

## Recommendation

Approve implementation. One engineer-week, zero additional infrastructure cost, eliminates the class of cascading failure we demonstrated in load testing. The scope is contained, the cost is minimal, and the risk of inaction is documented and observed.

---

## What We Are Not Doing

To be clear about scope:

- We are not fixing the Fraud Detection database performance problem — that is the Fraud Detection team's responsibility
- We are not changing order processing logic or customer-facing behavior
- We are not changing the services we call or the APIs we use
- We are not introducing new infrastructure or vendors
- We are not reducing the capacity available to any individual dependency — in most cases, the dedicated budget is sufficient for that dependency's peak usage

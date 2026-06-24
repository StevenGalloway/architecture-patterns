# Executive Brief — Backend-for-Frontend Pattern

**Audience:** CPO, CFO, VP Engineering, VP Product, non-technical stakeholders
**Decision required:** Approve implementation of dedicated Backend-for-Frontend services for mobile and web client experiences

---

## The Problem We Have Today

Our mobile app and web app both make their own calls directly to our backend domain services. On the home screen alone, the mobile app makes 6 to 9 separate API calls — one to the Profile service, one to the Catalog service, one to the Recommendations service, one to the Orders service, and so on. These calls happen in sequence or in loosely coordinated parallel, and the mobile app cannot render the screen until all of them have returned.

The result: **mobile home screen load time is 3 to 4 seconds on a 4G connection**. We have measured this. Industry benchmarks put acceptable mobile page load time at under 2 seconds. We are losing users at load time.

There are two additional operational problems that affect our ability to ship:

**When any backend team changes their API, both mobile and web apps break simultaneously.** Earlier this year, the Orders team modified their response schema to add fields for a B2B feature. Neither the mobile app nor the web app used those new fields. Both apps broke anyway, because the schema change was not backward-compatible. Both frontend teams spent the better part of a sprint on an unplanned fix for a change they had no visibility into and no control over.

**Frontend teams cannot ship without waiting for backend teams.** When the mobile team needs a new field — say, showing the user's loyalty points on the home screen — they must file a request with the relevant backend team, wait for it to be prioritized, wait for it to be deployed, and then release the mobile feature. The mobile team's sprint velocity is partly determined by other teams' backlogs.

---

## What We Are Proposing

We create a dedicated backend service for each client experience — a Backend-for-Frontend, or BFF. The mobile team builds and owns the mobile BFF. The web team builds and owns the web BFF.

Instead of the mobile app making 6 API calls, the mobile app makes **one call to the mobile BFF**. The mobile BFF makes the 6 domain service calls in parallel, assembles the result, and returns a single optimized response to the mobile app. The mobile BFF is owned by the mobile team, so they control its contract, its deployment schedule, and its data shape.

The web app makes one call to the web BFF, which does the same for web.

Neither client ever directly calls a domain service again.

---

## What This Costs

| Item | Estimate |
|---|---|
| Engineering time to build mobile BFF | 2 engineers × 2 weeks |
| Engineering time to build web BFF | 2 engineers × 2 weeks |
| Infrastructure — mobile BFF (monthly, ongoing) | $100–$200/month |
| Infrastructure — web BFF (monthly, ongoing) | $100–$200/month |
| **One-time total engineering** | **~8 engineer-weeks** |
| **Recurring monthly infrastructure** | **~$200–$400/month** |

The infrastructure cost is negligible. The engineering cost is a one-time investment in two new services that our own frontend teams control. There is no new vendor, no new licensing cost, and no lock-in.

---

## What We Gain

**Mobile performance improvement — measurable within weeks of launch**

When the mobile app makes one optimized call instead of six sequential calls, and receives a payload that contains only the fields it actually renders (approximately 60% smaller than what the domain services return today), mobile home screen load time drops to under 1.5 seconds. We have a direct, measurable metric for this. Mobile retention is strongly correlated with load time. This improvement reduces churn.

**Frontend teams ship on their own schedule**

Once the mobile team owns the mobile BFF, they can add a new field to the home screen — loyalty points, promotional banners, personalized recommendations — without filing a request with a backend team. They add the field to the BFF's composition layer, call the relevant domain service, and ship. The backend team was not involved. The backend team's sprint is not affected.

**Backend teams stop receiving UI-specific feature requests**

Today, approximately 30% of domain team sprint capacity goes to UI-specific requests — "can you add this field to the response," "can you create a composite endpoint for this screen." After BFF adoption, these requests go to the BFF team, which is the same team as the frontend team. They are resolved internally, not as cross-team dependencies. Domain teams recover that capacity for domain-level work.

**Domain service changes no longer break client apps by default**

When the Orders team adds a new field to their response schema, the mobile BFF's response allowlist does not include that field. The mobile app receives exactly what it received before. The change is invisible to the client. The class of incident we experienced this year does not recur.

---

## What Happens If We Do Not Do This

The current model has a compounding cost. Each new domain service we add increases the number of calls the mobile app must make per screen. Each new feature that requires data from two services requires the mobile app to coordinate those two calls. Each backend API change is a potential breaking change for both clients.

The trajectory is: mobile load time continues to increase, frontend teams continue to be blocked on backend schedules, and backend teams continue spending capacity on UI-specific work. The cost of coordination overhead grows linearly with the number of services. We are currently at 6 domain services. Our roadmap adds 3 more in the next 12 months.

The cost of fixing this 12 months from now is the same as fixing it today, plus 12 months of lost frontend velocity and degraded mobile performance.

---

## What We Are Not Doing

To be precise about scope:

- We are not changing any domain services. Domain teams continue to build and own their APIs independently.
- We are not replacing the API Gateway. The BFF sits behind the API Gateway. The Gateway handles authentication and routing; the BFF handles aggregation and response shaping.
- We are not building a GraphQL layer. GraphQL is a valid alternative pattern. We chose dedicated BFFs because they align with our team structure (one team owns one client experience) and avoid the operational complexity of a shared GraphQL schema.
- We are not creating a shared BFF that serves both mobile and web. A shared BFF would require both frontend teams to coordinate on every change, recreating the cross-team dependency we are trying to eliminate.
- We are not moving business logic into the BFF. Pricing rules, entitlement decisions, and domain invariants stay in domain services. The BFF does aggregation and presentation shaping only.

---

## Recommendation

Approve implementation. The 8-engineer-week investment recovers itself within two product sprints through reduced cross-team coordination overhead. Mobile performance improvement is measurable and directly tied to retention metrics. Infrastructure cost is negligible. The alternative is continued compounding coordination cost as the number of domain services and client experiences grows.

# Executive Brief — Anti-Corruption Layer Pattern

**Audience:** CPO, CFO, VP Engineering, non-technical stakeholders
**Decision required:** Approve implementation of Anti-Corruption Layer for vendor integrations

---

## The Problem We Have Today

Last quarter, our vendor CRM released version 3 of their customer API. They renamed `customer_type` to `account_classification`, changed the address field from a flat string to a nested object, and quietly made the phone number field nullable.

Our systems were not prepared for this. Three separate services that consumed customer data from this vendor broke simultaneously. Finding all the places in our codebase where vendor fields were referenced required two days of engineering investigation. Fixing those references required a coordinated deployment of six services — for a change that originated entirely with the vendor and that we had no control over.

This is not a one-time event. It is the predictable outcome of integrating vendor data directly into our systems without a defined boundary. Every new vendor integration we add — and we are planning two more this year — recreates the same fragility.

The specific costs of the recent incident:
- 2 days of senior engineering time diagnosing scope of impact
- 1 day of coordinated multi-service deployment with rollback risk
- 4 hours of customer-facing degradation on one service before the fix reached production
- Unknown indirect cost: the two days of engineering time was not spent on planned roadmap work

---

## What We Are Proposing

We build a single **Anti-Corruption Layer** (ACL) — an adapter service that sits between our internal systems and the vendor's API.

The ACL is responsible for exactly one thing: translating what the vendor gives us into the language our systems use internally. When the vendor changes their API, only the ACL changes. Our six internal services never see the vendor's naming, structure, or quirks — they see a stable internal representation that we control.

In practical terms:
- The vendor calls a customer `account_classification`. Our systems call it `accountType`. The ACL translates.
- The vendor changes the address format. The ACL absorbs that change. Our services do not know it happened.
- We need to switch to a different CRM vendor. We replace the ACL adapter. Our domain services are untouched.

---

## What This Costs

| Item | Estimate |
|---|---|
| Engineering time (initial build) | 1 engineer × 3 weeks |
| Infrastructure (monthly) | $50–$150/month |
| Ongoing mapping maintenance | 4–8 hours per vendor schema change |
| **One-time total** | **~3 engineer-weeks** |
| **Recurring monthly** | **< $150** |

For comparison, the incident last quarter consumed approximately the same engineering time as the initial build — in a single incident.

---

## What We Gain

**Vendor changes affect one service, not six.**
When the CRM releases v4, one developer updates the ACL. No coordinated multi-service deployment. No two-day investigation into which services are affected. No customer-facing degradation while we race to find all the usages.

**We can swap vendors.**
If we want to evaluate a competing CRM, we replace the ACL adapter and run both in parallel. Our domain services see no difference. This negotiating leverage has real commercial value — vendors who know you cannot leave have less incentive to negotiate on price or SLA.

**GDPR compliance: we know where customer PII enters our systems.**
Under GDPR, we must know where personal data is processed and be able to demonstrate data minimization (we only process what we need). Today, vendor data is consumed in six different places with six different assumptions about what fields are present. After this change, there is one entry point. PII is stripped and normalized before it reaches any internal service. Our compliance posture improves materially.

**Future vendor integrations follow a pattern.**
We are planning two additional vendor integrations this year. Each of them, if built without this pattern, recreates the same fragility we experienced last quarter. With the ACL in place, new vendor integrations follow the same structure: an adapter that translates the new vendor's data into our canonical model. The risk of each integration is lower than the last.

---

## What Happens If We Do Not Do This

We will have another incident. The next vendor API change — from the CRM, from the ERP, or from one of the two new integrations planned this year — will again require locating all usages across multiple services, coordinating a multi-service deployment, and absorbing the engineering cost and customer impact of the interval between detection and fix.

The fragility does not decrease over time without intervention. It compounds: each new vendor integration adds more potential blast radius to the next vendor-side change.

---

## What We Are Not Doing

To be precise about scope:
- We are not replacing the CRM vendor or any other existing vendor relationship
- We are not changing any internal domain model or business logic
- We are not building a general-purpose integration platform — this is a targeted adapter for known vendor integrations
- We are not introducing meaningful new latency for users (the ACL adds less than 10ms on a typical vendor API call)
- We are not creating a new team — this is built and maintained by the existing backend platform engineering team

---

## Recommendation

Approve implementation. The three-week investment prevents the recurrence of a class of incident that cost us equivalent time in a single quarter, improves our GDPR compliance posture, and reduces the risk of each future vendor integration. The infrastructure cost is negligible. The organizational cost of inaction is not.

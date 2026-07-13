# Executive Brief — Data Mesh Pattern

**Audience:** CPO, CFO, VP Engineering, Chief Data Officer
**Decision required:** Approve Data Mesh operating model adoption

---

## The Problem We Have Today

Our data engineering team of 11 people has 47 requests in their queue. The average time from ticket submission to a working pipeline in production is 6 weeks.

Business teams cannot get the data they need when they need it. Finance cannot close the books on time because the revenue attribution pipeline is in queue. The product team cannot run an A/B test because the experiment metrics pipeline won't be ready for 5 weeks. The data science team is using a 4-month-old copy of the training dataset because requesting an updated version means going back to the queue.

This is not a people problem. We hired aggressively over the past 18 months and grew the data team to 11 engineers. The queue did not shrink — it grew from 23 to 47. Adding people to this team without changing the model will produce the same result.

The bottleneck is structural. When the Finance team needs a revenue attribution pipeline, a data engineer who has never worked in Finance spends 2–3 weeks learning Finance domain concepts before writing a single line of code: what does "settled" mean in our revenue model? How are cross-currency transactions treated? What are the edge cases for returns that cross a quarter boundary? The Finance team knows all of this instantly. The data engineer must learn it through meetings, documentation, and trial and error. Then Finance finds 4 edge cases they forgot to mention. Then it goes through review. Then it deploys.

Six weeks is optimistic for a pipeline with material business logic.

---

## What We Are Proposing

Move data pipeline ownership to the teams who understand the data.

The Orders team will own Orders data pipelines. Finance will own Finance data pipelines. The Customer Experience team will own Customer Experience data pipelines.

A smaller, more focused central team — the Data Platform team — builds the tools, templates, and guardrails that make this possible. Instead of doing all the data engineering work themselves, they make it easier and safer for domain teams to do it.

This is called a Data Mesh. It is the operating model that Zalando, JPMorgan Chase, Intuit, and other companies our size adopted when they hit the same structural wall we are hitting now.

---

## What This Costs

| Item | Estimate |
|---|---|
| Platform foundation build (tooling, templates, governance automation) | 2–3 engineer months |
| Infrastructure increase | ~$12,000–$15,000/month (up from ~$8,000/month today for warehouse compute alone) |
| Domain team onboarding time | 1–2 weeks per team to learn the standard pipeline tools |
| Estimated time to first domain team operating independently | 6–8 weeks from approval |

The infrastructure increase is driven primarily by adding a data catalog, quality monitoring tooling, and lineage capture — capabilities we do not currently have and that directly enable governance at scale.

The domain team onboarding time is a one-time cost. The platform is designed so that a senior engineer with no data engineering background can build and deploy a functional data product in 2 days using the standard tooling.

---

## What the Business Gains

**Backlog eliminated.** Domain teams deliver data products in 1 week instead of 6. The 47-request queue does not transfer to a new owner — it dissolves because the people who need the data are the people building the pipeline.

**Data quality improves.** The Orders team's revenue pipeline will be built by people who know what "settled" means. Edge cases will be handled correctly the first time. The Finance team will no longer discover that the gross revenue figure in their dashboard is 3% wrong because the data engineer didn't know about a specific return handling rule.

**Analytics teams get data they can trust.** Every data product published through the platform carries a defined owner, a quality SLO (e.g., 99.5% completeness, refreshed within 25 hours), and a versioned contract. Analysts will know when data is late. They will know who to call. They will know which data products are built on which source data.

**Data assets become reusable and canonical.** Today we have six teams each computing "monthly revenue" differently, producing figures that differ by as much as 8%. Under Data Mesh, there is one canonical Orders Revenue data product owned by the Orders team, consumed by Finance, Analytics, and the executive dashboard. One definition. One owner. One place to fix it when the business logic changes.

---

## The Risk of Inaction

The data team backlog will grow. It grew from 23 to 47 in 18 months. At current growth — roughly 1.5 new requests per week from new domains and increased data needs in existing domains — we will have 80+ requests in queue within 18 months.

The cost of that backlog is not just the time the data team spends on it. It is the business decisions that cannot be made, the financial reports that cannot be produced, the experiments that cannot be run, and the AI models that cannot be trained because the data is not available when it is needed.

Slower product decisions. Slower financial reporting. Slower experimentation. These are not hypotheticals — they are the current state, and they will compound.

---

## What We Are Not Doing

To be clear about scope:

- **We are not eliminating the central data team.** They become the platform team that makes all domain teams more capable. This is a higher-leverage role, not a smaller one.
- **We are not making all data public.** Governance gets stronger under this model, not weaker. Every data product has a declared classification, a PII audit, and access controls enforced automatically by the platform. We will have better visibility into who is accessing what than we do today.
- **We are not asking domain teams to become data engineers.** We are asking them to own their data with tools designed to make that straightforward. The platform's job is to hide the complexity.
- **We are not rewriting existing pipelines immediately.** Existing pipelines remain operational. New pipelines are built under the Data Mesh model. Existing pipelines are migrated to domain ownership on a domain-by-domain schedule as bandwidth allows.

---

## Recommendation

Approve adoption. The structural problem is clearly identified, the solution is proven at comparable companies, the cost is bounded and recoverable, and the risk of inaction is measurable and growing.

The first milestone — platform foundation and first domain team operating independently — is achievable in 8 weeks with existing team capacity. We do not need new hires to begin.

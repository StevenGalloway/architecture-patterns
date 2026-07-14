# Team Topology — Data Mesh Pattern

## Conway's Law Is Not a Side Effect — It Is the Design Principle

Data Mesh is the only architecture pattern in this repository that explicitly begins with an org-design decision, not a technical one. Zhamak Dehghani's original formulation was a direct response to Conway's Law: a centralized data architecture produces centralized coupling, and centralized coupling produces the 6-week backlog. The solution is not to optimize the centralized system — it is to restructure teams so that the architecture that emerges from their boundaries is the one you want.

The 47-request backlog with 6-week average wait time was not a capacity problem. It was an organizational mismatch: the teams who understood the data (Orders, Finance, Catalog) could not act on that understanding without routing every request through a 11-person central team that had to learn each domain from scratch. Conway's Law guaranteed the bottleneck. Data Mesh dissolves it by aligning pipeline ownership with domain knowledge.

If you adopt Data Mesh as a technology choice while keeping the centralized team structure, you will get the same bottleneck with extra tooling on top.

---

## Team Type Classification

| Team | Type (Team Topologies) | Primary Responsibility | Size Guidance |
|---|---|---|---|
| **Data Platform Team** | Platform team | Data infrastructure: warehouse compute, orchestration (Airflow/Prefect), data catalog, lineage capture, quality testing library, governance CI gates, self-service portal | 2–8 engineers depending on org scale |
| **Domain Data Teams** | Stream-aligned | Own data products for their domain end-to-end: ingestion pipelines, transformation logic, quality tests, SLOs, on-call rotation for data product incidents | 1 data product owner + domain engineers per domain |
| **Data Governance Council** | Enabling team | Define enterprise standards: naming conventions, PII classification policies, semantic conventions, schema contract formats; review domains for compliance; update standards on a quarterly cadence | 2–4 members (may be part-time) |
| **Consumer Teams** | Stream-aligned (consumers) | Consume data products via declared contracts; do not query source tables directly; declare access requests through the self-service portal | All teams that use data products |

The Governance Council is enabling, not approving. It sets standards and helps domain teams meet them — it does not gate every data product release. The CI/CD policy-as-code gates enforce the standards automatically. The Council reviews the standards, not the individual products.

---

## Conway's Law: The Architectural Foundation

The centralized data model produced a communication bottleneck that was architectural, not accidental:

```
Domain Team (Orders)
      │
      │ "We need a revenue attribution pipeline"
      │ [ticket filed]
      ▼
Central Data Team
      │
      │ Week 1-2: Learn Orders domain concepts
      │ (What is "settled"? How are returns handled?)
      │
      │ Week 2-4: Build pipeline
      │ (Domain team finds edge cases at demo)
      │
      │ Week 4-6: Revise, QA, deploy
      ▼
Orders Domain Team receives pipeline
(Will need to file another ticket when domain logic changes)
```

The communication overhead scales with the number of domains and the complexity of each domain's business logic. Hiring more data engineers reduces the queue length slightly but does not change the structural overhead.

Data Mesh realigns this:

```
Orders Domain Team
      │
      │ Domain knowledge lives here
      │ Pipeline development lives here
      │ Data product ownership lives here
      ▼
Orders Data Product (published via platform tooling)
      │
      ▼
Consumers discover via catalog, consume via contract
```

The Orders team does not need to transfer domain knowledge to build the pipeline — they already have it. The platform team provides the tooling that makes pipeline development accessible. The governance CI gate ensures quality without requiring manual review.

---

## Failure Mode: Org Contradicts Architecture

The most common Data Mesh failure is adopting the technology vocabulary without the organizational change. Signs of this anti-pattern:

- Domain teams "own" their data products on paper, but the central data team still does the implementation when the domain team gets stuck
- The platform team is small (1–2 people) and domain teams are filing tickets to them for routine data product work
- Data products are listed in the catalog but most have the central team listed as the owner
- Domain teams do not have on-call responsibility for their data products — the central team handles incidents for everything

In this failure mode, the platform team becomes the new bottleneck, replacing the old central data team but with even less leverage because domain teams now have two paths to get help (ticket the platform team, or just do it themselves badly).

True Data Mesh requires empowering domain teams with both ownership AND capability. The platform team's job is to make capability cheap to acquire — not to be the capability provider.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform team → Domain teams | X-as-a-service | Platform provides pipeline templates, dbt project scaffolding, catalog registration, quality testing library, lineage capture. Domain teams use these without involving the platform team. |
| Governance Council → Domain teams | Enabling | Quarterly standards review; PII tagging guidance; schema convention updates; office hours for domain teams who need help interpreting a standard. Not a gate on individual data product releases. |
| Domain team → Domain team | X-as-a-service | Consumer team declares a contract against a producer's data product; producer team serves it. No direct collaboration required for standard consumption — the contract is the interface. |
| Domain team → Platform team | Collaboration | Required only when standard tooling doesn't cover a new use case (new source connector type, new warehouse feature, novel quality check pattern). Time-boxed; the output is usually a platform feature, not a one-off solution. |
| Domain team → Governance Council | Collaboration | When a domain team is building a data product that involves a new PII category, a novel semantic definition, or a cross-domain join that creates a new canonical metric. |

The explicit goal is to minimize Collaboration interactions in steady state. If domain teams are collaborating with the platform team weekly for routine work, the platform is not self-serve enough.

---

## Cognitive Load Concern: Domain Teams as Data Engineers

Domain teams are primarily product engineers, not data engineers. Asking them to own data pipelines is a genuine cognitive load increase. This is the most significant people risk in a Data Mesh adoption.

The platform team's primary job is reducing this cognitive load, not building data infrastructure that only platform engineers can use:

| Domain team concern | Platform mitigation |
|---|---|
| "I don't know how to write a dbt model" | Pre-built project template with examples; local DuckDB runner for zero-cost development; documentation with real examples from your warehouse |
| "I don't know what quality tests to write" | Standard quality test library with sensible defaults; CI auto-suggests tests based on field types |
| "I don't know how to handle PII in my pipeline" | PII scanner runs on CI; blocks deploy if PII fields are untagged; catalog field-level classification guide |
| "I don't know what to do when my data product fails" | Automated consumer notification; runbook template in each data product scaffold; clear SLO definition guide |
| "I'm not on-call for data" | Data product on-call is scoped to the domain team's own products; platform provides alerting infrastructure; P1 incidents have clear escalation path |

The measure of platform success is whether a senior product engineer with no data engineering experience can build and deploy a functioning data product in 2 days using the platform tooling, without filing a ticket to the platform team.

---

## Scaling Model

| Scale | Org model |
|---|---|
| Fewer than 5 domains | Lightweight mesh; a shared data team that is transitioning toward domain ownership is still valid. Platform investment is modest — focus on one or two standard tools (dbt + a catalog). The governance CI gate can start simple (schema presence check, owner field required). |
| 5–15 domains | Each domain names a data product owner — this does not need to be a dedicated data engineer. The DPO is responsible for quality and contracts; domain engineers do the work. Platform team provides heavy scaffolding: project templates, quality defaults, access request automation. Governance Council meets quarterly. |
| 15+ domains | Dedicated data capability in each domain (0.5–2 FTE depending on domain data volume). Platform team focuses on standards automation and tooling reliability, not hand-holding. Governance is enforced almost entirely via CI gates. Council reviews patterns and exceptions, not individual products. |

The platform team size should scale sub-linearly with domain count. At 20 domains, you should not have a 20-person platform team. Platform leverage is the point — if the platform requires linear headcount to scale, it is not a platform.

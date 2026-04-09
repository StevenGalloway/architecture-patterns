# Multi-Region Architecture Pattern (Active/Active + Resilience)

## Summary
A **Multi-Region** architecture runs a service in **two or more geographic regions** to improve:
- **availability** (regional failure tolerance)
- **latency** (serve users from the closest region)
- **business continuity** (DR with tested failover)
- **regulatory** needs (data residency / sovereignty)

Two common models:
- **Active/Active**: both regions serve production traffic continuously
- **Active/Passive**: one region serves; the other is warm standby (DR)

---

## Problem
A single-region deployment is vulnerable to:
- regional outages (cloud provider, network, power)
- large-scale incidents (dependency failures, control-plane issues)
- long recovery times if DR is cold or untested
- poor latency for globally distributed users

---

## Forces & Constraints
- Data consistency vs availability (CAP tradeoffs)
- Cross-region replication adds cost and complexity
- Failover must be deterministic and observable
- Regional deployments must be symmetric and automated (IaC)
- Stateful services are the hardest part (databases, queues, caches)

---

## Solution
### Core building blocks
1. **Global traffic management**
   - DNS (Route 53 latency/weighted + health checks) or Global Accelerator
2. **Regional compute stacks**
   - Kubernetes/ECS/VMs in each region, each with its own ingress/LB
3. **State strategy**
   - Prefer *stateless services*; externalize state
   - Use multi-region data stores where appropriate:
     - DynamoDB Global Tables (multi-active)
     - Aurora Global Database (primary + read replicas; promoted on failover)
     - Multi-region object storage replication (S3 CRR)
4. **Observability + Automation**
   - Per-region SLO dashboards, health checks, synthetic probes
   - Runbooks + game days for failover

---

## When to Use
- High availability requirements (e.g., 99.9%+ for customer-facing APIs)
- Global user base and low latency requirements
- Regulated workloads requiring regional isolation
- Critical revenue paths (payments, identity, ordering)

## When Not to Use (or be careful)
- Early-stage or low criticality services (cost/ops overhead)
- Strong consistency requirements with frequent cross-region writes
- Teams without platform/SRE maturity (multi-region needs operational discipline)

---

## Tradeoffs
### Benefits
- tolerant to regional outages
- lower user latency (closest region)
- supports DR and BCP with measurable RTO/RPO

### Costs / Risks
- significantly more cost (duplicate stacks, replication)
- complex failure modes (split brain, partial replication, stale reads)
- operational overhead (deployments, incident management, testing)

---

## Diagrams
- `diagrams/01-context-active-active.mmd`
- `diagrams/02-failover-path.mmd`
- `diagrams/03-data-replication-options.mmd`

---

## ADRs
- `adrs/ADR-001-active-active-vs-active-passive.md`
- `adrs/ADR-002-global-traffic-management.md`
- `adrs/ADR-003-state-and-consistency-strategy.md`
- `adrs/ADR-004-observability-and-slos.md`
- `adrs/ADR-005-failover-testing-gamedays.md`

---

## Example (New Tech)
This example uses **AWS + Terraform** (new stack vs your K8s/Linkerd, Go/OpenFeature, dbt/DuckDB, etc.):
- Two regions (e.g., `us-east-1` + `us-west-2`)
- ECS Fargate service + ALB in each region
- Route 53 latency-based routing with health checks
- DynamoDB Global Table for multi-region state
- S3 Cross-Region Replication (optional) for artifacts/static assets
- Runbooks + scripts for failover drills

See: `examples/aws-terraform-active-active/`.

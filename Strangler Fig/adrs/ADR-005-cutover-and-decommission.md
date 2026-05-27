# ADR-005: Progressive cutover and decommission plan

## Status
Accepted

## Date
2026-03-25

## Context
After the shadow period (ADR-004) establishes that the new service matches the monolith's behavior, the final phase is shifting production traffic to the new service and, ultimately, removing the monolith's handling of that slice entirely.

The risk profile at cutover is different from the risk profile during shadow testing. During shadow testing, errors in the new service have no user impact (the monolith is authoritative). During cutover, errors in the new service affect real users and real billing outcomes. A billing calculation error during cutover is not a shadow diff -- it is a production incident.

Two cutover approaches were considered:

**Hard cutover:** All traffic switches from the monolith to the new service on a specific date and time. Simple to execute, but a bug discovered after cutover requires rolling back all traffic to the monolith simultaneously. If the bug is not detected quickly, users experience billing errors.

**Progressive canary cutover:** Traffic shifts gradually from the monolith to the new service. At each step, the new service's error rate and output quality are verified before proceeding. A bug at 5% traffic is experienced by 5% of users; a rollback reduces traffic back to the previous percentage, limiting exposure.

## Decision
Cutover follows a **progressive canary schedule** with SLO gates and instant rollback capability.

**Canary schedule:**
- 5% → 48-hour hold with continuous monitoring
- 25% → 48-hour hold
- 50% → 72-hour hold
- 100% → final

At each hold period, the following gates must pass before proceeding:
- New service error rate is under 0.5% (measured over the full hold period)
- p99 response latency is within 20% of the monolith's baseline
- Invoice total field diff rate is under 0.01% (the most critical correctness metric)

**Instant rollback path:** The Edge Router's routing configuration can be changed within 60 seconds (propagation time for a router reload). A rollback procedure that reduces the canary percentage to 0% is documented in the cutover runbook and can be executed by any on-call engineer without escalation approval.

**Decommission criteria:** The monolith slice is decommissioned only after:
1. 100% traffic has been routed to the new service for a minimum of 30 days
2. No rollback was triggered during the 30-day period
3. The new service has processed at least one full billing cycle (month-end processing)
4. The engineering team has signed off on decommission readiness

**Decommission sequence:** The monolith's billing code is archived (not deleted) in a tagged commit. The billing tables remain in the monolith's database for 6 months as a read-only archive, then are migrated to cold storage. The code is removed from the deployment artifact after archival.

## Alternatives Considered

**Hard cutover on a single date:** All billing traffic switches to the new service at 9 AM on a pre-announced date. Simpler operationally (single deployment, no canary management). Rejected because the hard cutover provides no opportunity to detect issues before they affect 100% of users. The shadow period (ADR-004) reduces confidence risk but does not eliminate it; a problem that only manifests under production load conditions would not be caught until 100% traffic was on the new service.

**Feature flag-based cutover (no Edge Router canary):** A feature flag in the monolith controls whether billing requests are handled by the local code or proxied to the new service. The flag percentage controls the canary ratio. Rejected because this approach requires the monolith to be the routing authority, which perpetuates the monolith's deployment coupling. An Edge Router canary allows the monolith's billing code to be entirely removed from the routing path without the monolith needing to be aware.

**No decommission (leave the monolith billing code in place):** After 100% traffic is on the new service, leave the monolith's billing code in place as a "warm standby." Rejected because maintaining dead code in the monolith adds to the maintenance burden that the extraction was intended to reduce. Dead code is read during reviews and must be considered during compliance audits. The decommission must happen to realize the simplification benefit.

## Consequences

### Positive
- A bug at 5% canary traffic affects 5% of billing operations; the instant rollback procedure reduces exposure back to 0% in under 60 seconds
- The 30-day post-100% stabilization period before decommission ensures that the new service has processed a full billing cycle (including month-end processing, which has higher volume and different code paths than normal daily processing)
- The 6-month data archival period after code decommission provides a safety net if historical billing data is needed for reconciliation or audits before the data moves to cold storage

### Negative
- The progressive canary schedule adds 8-10 days to the cutover timeline compared to a hard cutover
- The 30-day post-100% stabilization period adds a month of running both the monolith (in standby) and the new service before the monolith slice can be decommissioned

### Risks
- **Decommission blocked indefinitely by conservative sign-off requirements.** If the "engineering team sign-off" requirement is interpreted as requiring unanimous agreement from all stakeholders, it can block decommission indefinitely through committee dynamics. Mitigation: sign-off is defined as: the extraction lead, the SRE on-call lead, and the product owner of the extracted domain. Three specific roles, not "engineering team."

## Review Trigger
Revisit the canary schedule percentages if the first cutover (Billing) reveals that 48-hour hold periods are too long or too short to produce statistically meaningful error rate data. Also revisit the 30-day stabilization period requirement if multiple extractions are in flight simultaneously and the sequential timeline becomes impractical.

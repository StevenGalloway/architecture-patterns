# ADR-002: Define a four-type flag taxonomy with mandatory TTLs and ownership

## Status
Accepted

## Date
2026-01-28

## Context
Three months after shipping the first version of the feature flag system, a review of the flag registry found 47 flags. Of those: 12 had been on 100% for more than 60 days with no associated cleanup ticket, 8 had no owner listed, and 3 referenced teams that had been reorganized out of existence. The remaining 24 were actively being managed.

The problem is that the system treated all flags identically. A kill switch for an emergency disable and a 2-week A/B experiment were both just "flags" with no structural difference. Engineers creating new flags had no guidance about expected lifetime, so most defaulted to permanent. The 12 flags stuck at 100% were almost certainly dead code paths that nobody had gotten around to cleaning up — but without certainty, nobody wanted to remove them.

This is a variant of the same problem the team had with long-lived feature branches: work that should be temporary becomes permanent by default because there is no enforcement mechanism.

## Decision
Define four flag types, each with a maximum TTL and a required owner field:

| Type | TTL | Owner | Required fields |
|------|-----|-------|-----------------|
| **Release** | 30 days | Feature team | `expiresAt`, `linkedTicket` |
| **Experiment** | 90 days | Product/growth team | `expiresAt`, `hypothesis`, `successMetric` |
| **Ops / Kill Switch** | None (annual review) | Platform/on-call team | `reviewedAt` (updated annually) |
| **Permission** | None | Billing/entitlement team | none beyond standard fields |

All flags require `type`, `owner`, and (for Release and Experiment) `expiresAt` at creation time. The management API validates these fields and rejects flag creation requests that are missing them.

An automated job runs daily and:
1. Alerts the owning team when a Release flag's age exceeds 25 days (5-day warning) and 30 days (overdue)
2. Alerts when an Experiment flag exceeds 80 days (warning) and 90 days (overdue)
3. Alerts when any flag's owner references a team that no longer exists in the org directory

Kill switches are reviewed annually. The platform team schedules a 30-minute review each year to confirm each kill switch is still needed and update the `reviewedAt` timestamp.

## Alternatives Considered

**Single flag type with optional TTL:** Keep the current model but add an optional `expiresAt` field. Teams set it if they want staleness alerts. Rejected because "optional" means most flags will not have it — the same outcome as the current state where 12 flags have been stuck at 100% for months. Enforcement requires the field to be mandatory for flag types that should have a lifecycle.

**Two types only (temporary and permanent):** Simpler taxonomy. Temporary flags get a 90-day TTL; permanent flags are for everything else. Rejected because it conflates experiments (which need a hypothesis and success metric) with release flags (which need a linked ticket), and it puts ops kill switches in the same bucket as billing permission flags, which have different ownership and review cadence.

**Lifecycle enforced entirely via code review:** Engineers review all flag creation PRs. Flag type and expiry are discussed in review. Rejected because it requires every reviewer to know the taxonomy and enforce it consistently. Automated enforcement at the API layer is more reliable and does not depend on reviewer memory.

## Consequences

### Positive
- Controlled flag debt with clear accountability per flag; the 47-flag audit finding would be surfaced by automated alerts before it accumulated
- Automated staleness alerts surface cleanup work before it becomes critical technical debt
- Clear ownership prevents flags from being orphaned when teams reorganize
- Required `hypothesis` and `successMetric` fields for Experiment flags force product teams to define success before the experiment runs

### Negative
- Enforcement requires API-layer validation and a CI lint rule — build cost estimated at 2–3 engineer-days
- Teams may resist mandatory expiry dates, especially for flags they believe will be permanent but don't belong in the Ops or Permission categories
- Annual kill switch review requires a formal process and calendar commitment from the platform team

### Risks
- **Permission flags that grow to cover access control logic.** A Permission flag that gates a feature per plan tier may accumulate business logic that should live in the authorization layer. Mitigation: the billing/entitlement team owns Permission flags; they are responsible for ensuring flag evaluations do not substitute for proper RBAC checks.

## Review Trigger
Revisit TTLs if the quarterly cleanup sprint consistently shows that 30 days is too short for typical Release flags (indicating the team's development cycles are longer than assumed). Revisit the annual kill switch review cadence if the number of kill switches grows past 20 — a monthly or quarterly lightweight review may be more practical.

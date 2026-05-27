# ADR-001: Adopt the Strangler Fig modernization approach

## Status
Accepted

## Date
2025-07-30

## Context
The core commerce platform is an 8-year-old Rails monolith that handles billing, order management, inventory, user management, and product catalog in a single application. The application has 340,000 lines of code, 1,800 test files, and a test suite that takes 55 minutes to run. Deployments require a full application restart that causes 3-4 seconds of downtime, which is manageable but becoming unacceptable as traffic grows.

Three teams operate the monolith with significant friction. The Billing team's changes require deploying alongside Inventory team's changes because all code ships together. A bug in a Billing deployment 3 months ago caused a 20-minute outage that affected Order Management even though the Order Management code had not changed.

The engineering leadership assessed two modernization approaches:

**Big-bang rewrite:** Halt feature development, build a new microservices platform from scratch over 12-18 months, and cut over all traffic on a specific date. The estimate was 18 months, with a high-risk cutover and significant business risk from the 12-month feature freeze.

**Incremental modernization (Strangler Fig):** Extract functional slices from the monolith into new services one at a time. Each extracted slice is independently deployable and operated. The monolith continues to run with the remaining functionality while extraction is in progress. No big-bang cutover.

The big-bang rewrite was rejected after an analysis of the 2018 rewrite attempt at a previous organization, which took 24 months (vs. the 12-month estimate), resulted in 6 months of feature freeze, and was ultimately abandoned in favor of the running monolith after the new system's performance was worse than the original.

## Decision
Adopt the **Strangler Fig** pattern as the modernization approach. The existing monolith continues to serve all traffic. Functional slices are extracted to new services in priority order, with each extraction following the same process (seam establishment, data transition, shadow validation, cutover, decommission).

The extraction priority order is determined by the team with the most urgent need and the lowest extraction risk:
1. **Billing service** (highest business value, relatively isolated data model)
2. **Notification service** (outbound-only, no complex data dependencies)
3. **User management service** (complex but well-understood domain)
4. **Order management service** (highest complexity, deferred until pattern is proven)

At any point during the modernization, the architecture may be a partial hybrid: some traffic going to new services and some remaining in the monolith. This is explicitly accepted as a transitional state, not a permanent architecture.

## Alternatives Considered

**Big-bang rewrite:** Build the full replacement system before directing any traffic to it. Rejected after the historical analysis of failed rewrites and the 18-month estimate with high uncertainty. The 2018 attempt at a previous organization was the decisive reference point.

**In-place refactoring (modularizing the monolith without extraction):** Restructure the monolith into well-defined modules (Billing module, Orders module) with strict interfaces between them, without creating separate deployment units. Maintains the single-deployment model while reducing coupling. Rejected because in-place modularization does not solve the deployment coupling problem (billing bugs still affect order management deployments) or the team autonomy problem (all teams must coordinate on every release).

**Parallel development with database sync:** Build the new services in parallel with the monolith, synchronize their databases bidirectionally, and migrate traffic gradually. The monolith and new services coexist with shared data. Rejected because bidirectional database synchronization is operationally complex and error-prone; the data consistency risk is high during the period when both systems are actively writing to the same data.

## Consequences

### Positive
- Each extracted service can be deployed independently, eliminating the coupling between Billing and Order Management deployments
- Teams gain autonomous deployment capability as soon as their slice is extracted, without waiting for the full modernization to complete
- Each extraction follows a repeatable process (seam, data, shadow, cutover, decommission), reducing the risk of each subsequent extraction

### Negative
- The hybrid architecture (partial monolith, partial new services) is more complex to operate than either a pure monolith or a pure microservices architecture; both the monolith and the new services require monitoring and on-call coverage simultaneously
- Governance is required to prevent the modernization from stalling indefinitely, leaving the organization with a "forever hybrid" architecture

### Risks
- **"Forever hybrid" stall.** If the extraction process is slow or if the business deprioritizes modernization in favor of features, the hybrid state persists indefinitely. The monolith continues to accumulate technical debt while new services add operational overhead without eliminating the monolith's maintenance burden. Mitigation: a decommission target date is set for each extraction plan, and the engineering team reports modernization progress (percentage of traffic through new services) as a quarterly metric.

## Review Trigger
Revisit the Strangler Fig approach if the monolith extraction proves significantly more difficult than estimated for the first two slices (Billing, Notifications). If the extraction cost per slice is too high, a different modernization strategy may be warranted.

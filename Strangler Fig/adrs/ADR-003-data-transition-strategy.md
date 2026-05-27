# ADR-003: Data transition strategy for migrated slices

## Status
Accepted

## Date
2025-12-03

## Context
Data ownership is the hardest part of extracting a slice from the monolith. The billing domain's data lives in the monolith's shared database (PostgreSQL): `invoices`, `payments`, `subscriptions`, and `billing_events` tables sit in the same schema as `orders`, `users`, `products`, and dozens of other tables. Some billing tables have foreign key relationships to non-billing tables (e.g., `invoices.user_id` references `users.id`).

Three approaches to data transition were evaluated based on the specific constraints of the Billing extraction:

**Can the new Billing service share the monolith's database?** Sharing the database would be the fastest extraction path: the new Billing service points to the same PostgreSQL instance and the same schema. The monolith and new service coexist on the same data. This is operationally simple but creates the worst long-term coupling: the new service inherits the monolith's schema design, and schema changes in the monolith can break the new service.

**Can billing data be migrated to a new database?** The new Billing service would have its own database, populated from the monolith's data via CDC or a migration job. The new service is the authoritative owner of billing data in its own database. The monolith reads billing data through an API call to the new service rather than directly from the database.

**Can the two systems write to both databases in parallel?** Both the monolith and the new service write billing data to both databases, with a reconciliation process to detect discrepancies. This allows both systems to be authoritative simultaneously, which is useful for shadow testing, but creates write coordination complexity.

## Decision
For each extracted slice, the data transition strategy is chosen based on the slice's data characteristics. Three strategies are available; the appropriate strategy is selected per slice and documented in the slice's extraction plan.

**Strategy 1: Shared database (temporary):** The new service uses the monolith's database during the shadow and early canary phases. The new service has read-only access to the monolith's tables; any writes must go through the monolith's data access layer via an internal API call (not direct table writes). This strategy is acceptable only as a temporary state with a committed exit date. Time limit: 90 days maximum.

Applied to: Notification service extraction (minimal data requirements, short migration path).

**Strategy 2: CDC replication into new domain store:** The monolith publishes changes to billing tables via Debezium CDC. The new Billing service subscribes and maintains its own database populated from the event stream. During the transition period, the monolith is the write authority; the new service reads from its replicated copy. At cutover, the new service becomes the write authority and the monolith reads via API.

Applied to: Billing service extraction (complex data, requires its own schema design).

**Strategy 3: Parallel writes with reconciliation:** Both systems write billing data during a limited verification window. A reconciliation job runs every 15 minutes and compares the two systems' data, emitting discrepancy metrics. This strategy is used only during shadow testing to verify that the new service would produce the same data as the monolith for the same inputs. Not used in production after cutover.

Applied to: All extractions during shadow phase validation.

## Alternatives Considered

**Permanent shared database:** The new service uses the monolith's database indefinitely, with no migration to a dedicated database. Rejected because it defeats the architectural goal of the extraction: the new service would be coupled to the monolith's schema and could not evolve its data model independently. Any schema change to the billing tables would require coordinating the monolith and the new service.

**Direct foreign key migration (preserve all relationships):** Move billing tables to a new database while maintaining foreign key constraints to the monolith's tables via cross-database references (PostgreSQL foreign data wrappers). Rejected because cross-database foreign keys eliminate the transactional guarantee that foreign key constraints exist to provide. A billing record that references a user ID in the monolith's database cannot be protected by a database-level constraint.

**Event sourcing the billing domain from scratch:** Rebuild the billing domain using event sourcing rather than migrating the existing relational data. Start fresh from the Strangler Fig cutover date; historical billing data remains queryable in the monolith for the archival retention period. Rejected because historical billing data must be queryable in the new service for regulatory and customer service purposes; an event-sourced rebuild that cannot query pre-migration history is not acceptable.

## Consequences

### Positive
- The shared database strategy allows rapid progress for simple slices (Notification) without data migration overhead
- The CDC replication strategy for Billing provides a clean handover: the new service's data model is designed from domain principles, not inherited from the monolith's legacy schema
- The reconciliation job during shadow testing provides quantitative confidence before cutover: zero discrepancies is the cutover gate, not subjective assessment

### Negative
- The CDC replication approach requires Debezium CDC infrastructure that is not currently deployed; this adds setup time to the Billing extraction
- During the transition period with two systems writing data (parallel writes), data integrity depends on the reconciliation job; failures in the reconciliation job reduce confidence in the parallel write state

### Risks
- **Exceeding the 90-day shared database limit.** If a slice that uses the shared database strategy is delayed past its 90-day limit, the architectural coupling problem the limit was designed to prevent reappears. Mitigation: the 90-day limit is tracked as a migration metric; slices approaching the limit trigger an escalation to the engineering leadership for deprioritization review.

## Review Trigger
Revisit the shared database time limit (90 days) if the CDC replication infrastructure takes longer than expected to deploy, causing the Billing extraction to use the shared database beyond its intended scope.

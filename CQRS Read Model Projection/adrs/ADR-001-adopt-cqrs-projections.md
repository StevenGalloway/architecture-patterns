# ADR-001: Adopt CQRS with event-driven read model projections

## Status
Accepted

## Date
2025-05-14

## Context
The Orders service was initially built with a single PostgreSQL database serving both write operations (creating and updating orders) and read operations (customer order history, merchant dashboards, fulfillment lists). As the product grew, three distinct query patterns emerged that had irreconcilable requirements:

**Customer order history:** Required sorting by date with pagination, filtering by status, and joining to shipment tracking data. Response time target: under 100ms at p99.

**Merchant fulfillment dashboard:** Required real-time counts of open orders by state, grouped by SKU and warehouse, with live refresh every 30 seconds.

**Analytics queries:** Full table scans with aggregate functions, used by the business intelligence team for daily reporting.

All three patterns competed for the same database resources. Index optimization for customer history queries degraded analytics query performance. The fulfillment dashboard's high-frequency polling held connection pool slots that intermittently caused timeouts on write operations. Attempts to tune the database for one pattern reliably degraded another.

The write side had its own problems: adding read-optimized indexes to the orders table to support new query patterns required full-table rewrites that caused multi-minute write latency spikes during deployments. New query requirements from the product team were blocked on schema migration coordination with the write team.

## Decision
Adopt **CQRS** (Command Query Responsibility Segregation) with event-driven read model projections:

- The **write side** handles commands (CreateOrder, UpdateOrderStatus, CancelOrder) and enforces all domain invariants. It writes to a write-optimized PostgreSQL database. On successful writes, it emits domain events to the internal event bus.
- A **projector** service consumes domain events and maintains denormalized read models optimized for specific query patterns. Different read models are maintained in different stores: customer order history in PostgreSQL, fulfillment dashboard in Redis, analytics in a column-store.
- The **query side** serves reads exclusively from read models. It never queries the write database.

## Alternatives Considered

**Database read replicas:** Add PostgreSQL read replicas to distribute read load. Rejected because replicas solve the read/write resource contention but not the schema optimization conflict. A replica index change requires replication lag consideration and still uses the same normalized schema, which cannot be optimized simultaneously for both customer history (row-level access patterns) and analytics (full-table aggregations).

**Materialized views in the write database:** Maintain materialized views for complex queries, refreshed on a schedule or on write. Rejected because materialized view refresh at write time adds latency to the write path; periodic refresh allows staleness that is invisible to the read side. Materialized views are also not portable to different storage backends (Redis for the fulfillment dashboard requires a different approach entirely).

**Event sourcing instead of CQRS projections:** Store all state as an append-only event log and derive current state by replaying events. Rejected as an initial approach because full event sourcing requires the entire write side to be redesigned around event replay semantics. CQRS projections can be added to an existing write model without rewriting the command side.

## Consequences

### Positive
- Read models can be evolved independently of the write schema; adding a new query pattern requires adding a new read model and projector, not modifying the write-side database
- Write operations no longer compete with read operations for database resources; write latency is insulated from read query complexity
- The fulfillment dashboard's Redis read model supports the 30-second refresh pattern at a fraction of the load that PostgreSQL polling produced

### Negative
- Reads are eventually consistent; query results reflect events processed by the projector, which may lag behind the write side by a few hundred milliseconds to a few seconds under normal conditions
- Operational complexity increases: projection lag, replay tooling, and event versioning require active maintenance that a single-database approach does not

### Risks
- **Projection falling behind under write spikes.** If order creation volume spikes (flash sale, product launch), the projector may fall behind. Read models serve stale data until the projector catches up. Mitigation: monitor projector lag as a primary metric; alert if lag exceeds 5 seconds.

## Review Trigger
Revisit the read model store choices if projector lag becomes a persistent problem under production load. Revisit the separation into a dedicated projector service if write volume drops or the team size decreases such that the operational overhead of a separate projector is not justified by the performance benefit.

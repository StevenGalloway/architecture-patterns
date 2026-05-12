# ADR-001: Adopt Event Sourcing for the Account domain

## Status
Accepted

## Date
2025-06-04

## Context
The Account domain manages financial transactions, balance adjustments, and fee applications. These operations have two properties that make traditional CRUD storage problematic: they require a complete, unmodifiable audit trail for regulatory compliance, and they need deterministic replay for reconciliation and dispute resolution.

The previous implementation stored only the current account balance in a relational table. The balance was updated in place on each transaction. When a dispute was filed claiming that a charge had been applied incorrectly, the engineering team had to reconstruct the transaction sequence from application logs -- which were not structured for this purpose, had gaps due to log rotation, and lacked the business context needed to answer "why was this fee applied at this point in time."

A regulatory audit request required producing a complete 18-month transaction history for 12 accounts. The reconstruction took 3 days and involved cross-referencing application logs, database change logs, and third-party payment provider records. The reconstructed history could not be proven complete -- there was no way to guarantee that all state changes had been logged.

Beyond compliance, CRUD state also made a class of bugs difficult to diagnose: a balance discrepancy of $0.03 persisted across multiple accounts for weeks because there was no way to determine which operation had caused it. An event-sourced store would have made the answer immediately available by replaying the account's event history.

## Decision
Adopt **Event Sourcing** for the Account domain. Account state is not stored directly. Instead, an append-only event store records every business fact that affects an account: `AccountOpened`, `DepositReceived`, `WithdrawalApplied`, `FeeCharged`, `DisputeResolved`, `AccountClosed`. Current account state is derived by replaying events from the beginning of the account's history (with snapshot optimization for performance; see ADR-003 for concurrency controls).

The event store is the system of record. The relational account balance table becomes a projection, rebuilt from events, used for query performance. Projections are derived data and can be discarded and rebuilt; the event log cannot.

The scope is limited to the Account domain in the initial deployment. Other domains with less strict audit requirements continue to use conventional CRUD storage until a specific need for event sourcing is demonstrated.

## Alternatives Considered

**Audit logging alongside CRUD storage:** Maintain the current state table and add an append-only audit log table that records all state changes. Provides auditability without event sourcing semantics. Rejected because it requires maintaining two representations of truth and ensuring they stay in sync. The $0.03 discrepancy incident demonstrated that the state table and the audit log can diverge when bugs exist in the synchronization path.

**Temporal tables (database-level row versioning):** Use database temporal table features (PostgreSQL's `period` columns or `SYSTEM_TIME` versioning) to retain historical row versions. Provides point-in-time query capability. Rejected because temporal tables record state snapshots, not business events. The difference between "fee charged" and "balance changed by the same amount" matters for regulatory reporting; temporal tables record the latter but not the former.

**Event streaming without event store (Kafka as the log):** Use Kafka as the durable event log. Rejected as the primary event store because Kafka's retention model is time-based or size-based, not infinite. An account event from 5 years ago must be available for replay; Kafka's retention guarantees do not extend to indefinite storage. A dedicated event store (PostgreSQL append-only table with explicit retention policy of "retain forever") provides the necessary durability guarantees.

## Consequences

### Positive
- Complete audit trail: every business fact that affected an account is recorded with its timestamp, actor, and context. Regulatory queries that previously took days take minutes
- Deterministic replay: the $0.03 discrepancy class of bug is now diagnosable by replaying the account's events and observing where the balance diverges from expectation
- New read models can be created from historical events without changing the write side; a new regulatory report format is a new projection, not a schema migration

### Negative
- Current state reads require either replaying events or querying a projection; direct SQL queries to "get the current balance" require an additional layer compared to CRUD
- Event schema governance becomes a long-term operational commitment; events stored today must be processable by projectors written years from now

### Risks
- **Scope creep into non-audit domains.** Event sourcing's appeal may lead to adoption in domains where CRUD is sufficient, adding complexity without commensurate benefit. Mitigation: the "adopt event sourcing" decision requires explicit architectural review for each new domain.

## Review Trigger
Revisit if the regulatory requirements for audit trail retention change, which would affect the event log retention policy. Revisit scope if another domain develops the same audit and replay requirements as the Account domain.

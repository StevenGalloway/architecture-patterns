# Security Architecture — Event Sourcing Pattern

## Threat Model

Event Sourcing introduces a security profile that is distinct from traditional CRUD persistence. The event log is simultaneously the most valuable asset in the system (complete business history, audit evidence, source of truth) and a uniquely fragile one: events cannot be corrected or deleted without breaking the audit guarantee. A single unauthorized append is a permanent, irreversible corruption of the historical record.

The immutability guarantee that makes Event Sourcing powerful for compliance is also what makes security failures uniquely severe. In a CRUD system, a data corruption incident can often be corrected by updating a row. In an event-sourced system, a fabricated event becomes permanent history.

```
Commands → Command Handler → Event Store (append-only) → Projectors → Read Models → Queries
               ↑                    ↑                         ↑
         (write path            (system of              (read path
          auth boundary)         record)                  boundary)
```

---

## Attack Surface

| Attack Surface | Threat | Severity |
|---|---|---|
| Event log (append) | **Unauthorized event injection** — attacker writes fabricated events that corrupt aggregate state. A fabricated `MoneyDeposited` event increases an account balance without a corresponding transaction. | Critical |
| Event log (read) | **Unauthorized historical replay** — attacker reads all events exposes the complete business history: every transaction, every balance, every customer action across all time. Scope is worse than a CRUD data breach because it includes deleted or superseded data. | Critical |
| Snapshot store | **Snapshot poisoning** — corrupted or tampered snapshot causes aggregate to load incorrect state without replaying events that would have corrected it. Idempotency is defeated. | High |
| Event schema | **Schema downgrade attack** — deploying an old projector binary that cannot handle new event versions causes silent data corruption in read models. Downstream financial reports become incorrect without any visible error. | High |
| Replay / backfill pipeline | **Replay against production read models** — an unauthorized or misconfigured replay operation replaces production read model data with historical or test data. Live queries return stale or incorrect results. | High |
| Admin / ops tooling | **Unauthorized replay trigger** — attacker or misconfigured automation triggers a full historical replay causing a denial-of-service on the event store and downstream projectors. | Medium |
| Audit log completeness | **Event log gaps** — partitioning bugs, network splits, or out-of-band deletes produce gaps in the event sequence. The audit trail appears complete but is missing business facts, causing regulatory audit failures. | Medium |
| Downstream event consumers | **Malicious event publication to downstream broker** — events published to Kafka/Kinesis are tampered before downstream consumers process them, causing their read models to diverge from the authoritative event store. | Medium |

---

## Write Path Security

### Command Handler Authorization

The write path is the most critical security boundary. Only the command handler (aggregate) service may append events to the event store. This must be enforced at multiple layers:

**Database-level enforcement:**
- The event store database user for the command handler service has `INSERT` only on the `events` table — no `UPDATE`, no `DELETE`, no `SELECT` on aggregate streams it does not own
- A separate read-only user is created for projectors and replay jobs — `SELECT` only, no write access
- Database superuser credentials are stored in a secrets manager, not in application config, and are not used by any application service

**Network-level enforcement:**
- Event store is in a private subnet with no public ingress
- Only the command handler service's security group / network policy may reach the event store on its write port
- Projectors reach the event store's read endpoint (read replica or separate endpoint) — not the write primary

**Application-level enforcement:**
- Command handlers validate authentication (valid identity) and authorization (caller is permitted to issue this command type) before evaluating any invariants
- Command authorization uses the Identity Provider's token — the aggregate refuses to process any command that does not carry a valid, unexpired identity claim

### Idempotent Append Verification

The append API must enforce:
- `event_id` uniqueness (UUID v4 or v7) — duplicate event_id is rejected, not appended as a second copy
- Optimistic concurrency check (`expected_version`) — prevents concurrent command handlers from appending conflicting events
- Schema validation before persistence — malformed or unversioned events are rejected at the boundary, not after storage

---

## Read Path Security

### Projector Access Controls

Projectors are read-only consumers of the event log. They must not have write access to the event store under any circumstances:
- Projector service account: `SELECT` on the events table, no write permissions
- Projectors write only to their own read model store, not back to the event store
- Read model stores are accessible only by the query API service and the projector — no direct end-user access to the read model database

### Query API Authorization

The query API serves read model data. It enforces:
- **Authentication**: valid Identity Provider token on every request
- **Tenant isolation**: queries are scoped to the authenticated identity's tenant or user context — a customer query for "my account balance" never returns another customer's data
- **No raw event log exposure**: the query API serves only projected read models, never raw event streams. Raw event access requires explicit ops authorization.

---

## Immutability Enforcement

The append-only guarantee is the foundation of Event Sourcing's audit and compliance value. Immutability must be enforced by controls at multiple layers, because application-level discipline alone is insufficient:

| Layer | Control |
|---|---|
| **Database constraints** | `events` table has no `UPDATE` trigger, and a database-level policy or trigger blocks `UPDATE`/`DELETE` on committed rows |
| **Permissions** | No application service account has `UPDATE` or `DELETE` on the `events` table |
| **Periodic integrity check** | Automated job verifies event sequence continuity (no gaps in `aggregate_version` sequences) and compares event log checksums against a separate integrity log |
| **Write-once object storage** | For archival tiers (S3 Glacier), use Object Lock (WORM) to enforce regulatory immutability at the storage layer |
| **Audit of audit** | Access to the events table (including read access) is logged. The log of access to the event log is itself immutable and stored separately. |

---

## Replay Isolation

Replay operations carry unique risk: they process the full event history and write to read model stores. A replay that runs against the production read model without isolation corrupts live data.

**Required controls:**

1. **Replay isolation environment**: Replays run against a snapshot of the event log in an isolated environment (separate compute, separate read model database), never against production read models directly

2. **Replay authorization**: Triggering a replay requires elevated access (separate IAM role or Vault policy). All replay triggers are logged with: operator identity, target projection, event range, timestamp, approval reference

3. **Read model swap pattern**: When a replay completes, the result is in a new read model (e.g., `account_balances_v2`). A traffic cut-over swaps the query API's target from `account_balances_v1` to `account_balances_v2` atomically. The old read model is kept for 24 hours before deletion.

4. **Replay dry-run mode**: Replay jobs support a dry-run mode that processes events and validates output without writing to the target read model. Use this to validate schema compatibility before committing a full replay.

---

## GDPR and Immutability Reconciliation

**The core conflict:** GDPR Article 17 (right to erasure) requires the ability to delete a data subject's personal data. Event Sourcing's immutability guarantee says events cannot be deleted. These requirements directly contradict each other.

**Resolution approach: Crypto-shredding**

Rather than embedding PII directly in event payloads, encrypt PII fields in events with a per-subject encryption key:

```
Event payload: { "account_id": "acc-123", "encrypted_name": "<AES-256 ciphertext>" }
Key store:     { "subject_id": "user-456", "encryption_key": "<AES-256 key>", "key_status": "active" }
```

When a right-to-erasure request is received:
1. The subject's encryption key is deleted from the key store
2. All events containing that subject's encrypted PII are now permanently unreadable (the ciphertext remains, but decryption is impossible)
3. The event log is formally intact (events were not deleted), but PII is effectively erased

**Documented in:** ADR-002 (event schema versioning and retention policy) must explicitly document the crypto-shredding approach and which fields are encrypted per-subject.

**Limitations:**
- The encrypted ciphertext remains in the event log (storage is not freed)
- Non-PII event data (business facts like transaction amounts) remains readable — this is acceptable under GDPR if the data cannot be linked to an identified individual
- The key store itself is a high-value target and must be protected with the same rigor as the event store

---

## Compliance Relevance

| Standard | Event Sourcing's Role |
|---|---|
| **SOC 2 CC6.1** | The immutable event log provides direct evidence for logical access controls. Every access and change is recorded with timestamp, identity, and action type. |
| **SOC 2 CC6.2** | Event sequence integrity (version ordering, gap detection) provides evidence that the audit trail is complete and tamper-evident. |
| **PCI DSS Req 10** | Transaction events constitute audit log records. Immutability satisfies the "protect audit logs from modification" requirement. Cardholder data in events must be encrypted at rest (field-level encryption, not just disk encryption). |
| **PCI DSS Req 3.4** | PAN (Primary Account Number) must be rendered unreadable. If PAN appears in any event payload, it must be tokenized or encrypted — not stored in plaintext even in an immutable event. |
| **GDPR Art. 5(1)(e)** | Storage limitation — events cannot be kept longer than necessary. Implement tiered archival with automated expiry for events beyond the regulatory retention window (7 years for financial data). |
| **GDPR Art. 17** | Right to erasure — reconciled via crypto-shredding (see above). Document the approach in your privacy impact assessment. |
| **GDPR Art. 22** | Automated decision-making — if AI decisions are sourced as events, the event payload must contain enough context to satisfy the right to explanation (see AI-INTEGRATION.md). |

---

## Security Review Checklist

Before any Event Sourcing system change reaches production:

- [ ] Event store write access is restricted to the aggregate/command handler service account only
- [ ] No direct SQL `UPDATE` or `DELETE` permissions exist on the event log table for any application service account
- [ ] Event log is encrypted at rest (database-level encryption at minimum; field-level encryption for PII fields)
- [ ] GDPR crypto-shredding strategy is documented and implemented for all PII-bearing event types
- [ ] Projector service account has `SELECT` only — no write access to the event store
- [ ] Replay pipeline runs in an isolated environment, never against production read models directly
- [ ] Admin replay/backfill operations require elevated access and generate an immutable audit log entry
- [ ] Event schema changes pass CI schema compatibility check before merge
- [ ] Snapshot store has the same access controls as the event log (no weaker permissions)
- [ ] Event `event_id` uniqueness constraint is enforced at the database level (not just application level)
- [ ] Optimistic concurrency check (`expected_version`) cannot be bypassed by any API path
- [ ] Access to raw event log is logged and those access logs are stored separately from the event log itself
- [ ] Downstream event publication to message broker uses signed or integrity-verified payloads
- [ ] Key store for crypto-shredded events is protected with the same access controls as the event store

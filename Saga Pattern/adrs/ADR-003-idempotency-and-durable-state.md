# ADR-003: Persist saga state durably and enforce idempotent event handling

## Status
Accepted

## Date
2025-11-19

## Context
Because we use at-least-once message delivery, the orchestrator will occasionally receive duplicate events. Without idempotency guards, a duplicate `PaymentAuthorized` event could advance the saga state machine incorrectly -- for example, triggering a second `ReserveInventory` command for an order that already has stock reserved. We also need the orchestrator to survive process restarts cleanly. If the orchestrator crashes mid-saga and loses its in-memory state, restarting it must allow it to recover from the last known good state rather than re-executing completed steps.

Both problems -- duplicate handling and crash recovery -- point to the same solution: durable, authoritative saga state that every operation reads before acting.

## Decision
Saga state is persisted to an embedded BoltDB store (key: `saga:{saga_id}`, value: JSON-serialized state record). The state record includes: current state, a list of completed step names, and a set of processed message IDs.

The orchestrator applies the following rules on every inbound event:
1. Load the current saga record from BoltDB by `saga_id`
2. Check whether the inbound `message_id` is already in the processed set -- if yes, ack and return without state transition
3. Validate that the event is legal given the current state (e.g., `PaymentAuthorized` is only valid from `STARTED`)
4. Apply the transition, append the `message_id` to the processed set, and write the updated record back atomically
5. Publish the next command only after the state write succeeds

Processed message IDs are retained for 72 hours then pruned to prevent unbounded growth. Sagas older than 72 hours that produce a duplicate event will re-process it -- acceptable since compensation at that point would be triggered anyway.

## Alternatives Considered

**In-memory state with event sourcing for recovery:** Keep state in memory; on restart, replay all saga events from the message log to reconstruct state. Rejected because it requires RabbitMQ to retain messages long enough for replay, which conflicts with our standard queue TTL policy. It also complicates startup time proportional to total saga history.

**Postgres instead of BoltDB:** Would provide stronger transactional guarantees and easier querying for ops. Rejected for this reference implementation because it introduces an external dependency. The production recommendation is to use Postgres for any deployment where the orchestrator runs as more than one instance.

**Optimistic locking with version field:** Use a version counter and compare-and-swap on state updates to prevent concurrent orchestrator instances from conflicting. This is the correct approach for multi-instance deployments. Deferred to the production hardening phase; the current implementation assumes a single orchestrator instance.

## Consequences

### Positive
- Orchestrator restarts recover cleanly with no manual intervention and no re-execution of completed steps
- Duplicate events are silently discarded; the saga does not double-charge or double-reserve
- Every state transition is an auditable record with a timestamp

### Negative
- BoltDB is an embedded store and does not support concurrent access from multiple process instances; horizontal scaling of the orchestrator requires switching to an external store
- The processed message ID set grows without bound until the 72-hour prune runs; under very high order volume this set can become large
- State schema changes (adding new saga states or fields) require a migration plan for in-flight sagas

## Review Trigger
Revisit when deploying the orchestrator as more than one instance for high availability. At that point, BoltDB must be replaced with a shared store (Postgres, Redis) that supports atomic compare-and-swap updates.

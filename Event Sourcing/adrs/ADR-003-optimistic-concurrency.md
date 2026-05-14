# ADR-003: Enforce optimistic concurrency with expected aggregate version

## Status
Accepted

## Date
2025-10-08

## Context
The Account domain allows concurrent command processing: a user may have multiple browser sessions active simultaneously, and backend batch jobs may issue commands against the same account concurrently with user-initiated actions. In an event-sourced system, the danger of concurrent writes is not just stale state (as in CRUD) -- it is appending events that are semantically invalid given the aggregate's actual current state.

A specific scenario: a user initiates a withdrawal and a fee application batch job targets the same account simultaneously. The withdrawal command handler loads the account's events (current balance: $100), validates that sufficient funds exist, and prepares to append a `WithdrawalApplied` event. Concurrently, the fee application handler loads the same events, applies a $5 fee, and appends `FeeCharged`. By the time the withdrawal's `WithdrawalApplied` event is appended, the account's actual state has changed (balance is now $95, not $100), but the withdrawal handler's validation was based on the $100 balance. If the withdrawal amount was $98, the handler would have allowed a withdrawal that would take the balance negative.

Without concurrency control at the event store level, this scenario results in the event store containing events that were valid when validated but are inconsistent when applied in sequence.

## Decision
The event store enforces optimistic concurrency control using the **expected aggregate version** pattern.

Every append operation includes an `expected_version` value -- the `aggregate_version` of the last event the command handler loaded before performing its validation. The event store appends the new event only if the current `aggregate_version` for that aggregate matches `expected_version`. If another writer has appended an event since the command handler loaded the state, the `aggregate_version` will be higher than `expected_version` and the append is rejected with a 409 Conflict.

The command handler's retry strategy:
1. On 409, reload the aggregate from the event store (including all events since the last load)
2. Re-validate the command intent against the updated state
3. If the command is still valid, retry the append with the new `expected_version`
4. If the command is no longer valid (e.g., the balance was reduced by the intervening event), return a business error to the caller

The maximum retry count is 3. Commands that fail all 3 retries due to persistent contention are returned to the caller as a retriable error.

## Alternatives Considered

**Pessimistic locking (lock the aggregate row before reading):** Acquire a database row lock on the aggregate before loading events. Only one writer at a time can process commands for a given account. Rejected because locking during the entire command-process-append cycle (which may involve external calls for validation) holds the lock for an indeterminate duration, causing contention under moderate concurrency. Optimistic concurrency is more appropriate for low-to-medium contention scenarios.

**Serializable aggregate processing via a single-process queue:** Route all commands for a given account through a single queue consumer that processes them sequentially. Eliminates concurrency conflicts by construction. Rejected because it requires a message queue infrastructure for command routing, adds queuing latency to every command, and creates a hot path problem if a single account has high command volume (the queue for that account becomes a bottleneck).

**Conflict-free operations (no concurrency control needed):** Design all operations as commutative so that the order of concurrent writes does not affect the result. Balance operations are explicitly not commutative (withdrawing $98 from a $100 account and a $95 account produces different validity outcomes), so this approach cannot be applied to the financial domain.

## Consequences

### Positive
- Concurrent writes to the same account are safe: the event store guarantees that events are only appended when the aggregate's state matches the handler's expectations
- The retry mechanism handles low-to-medium contention automatically without surfacing errors to users; only high contention (3 consecutive conflicts) surfaces as an error
- The implementation requires no distributed locks or queue infrastructure -- it is purely a database-level check on the `aggregate_version` column

### Negative
- High contention on a single aggregate (many concurrent commands targeting the same account) causes repeated retry cycles and increased latency; the pattern is designed for low-to-medium contention, not high contention scenarios
- Command handlers must be designed for retry correctness: any external side effects (calling a third-party API as part of command validation) must not be repeated on retry, or must be idempotent

### Risks
- **Command handlers with non-idempotent side effects.** A command handler that calls an external payment processor during validation will call it again on retry, potentially charging a customer twice. Mitigation: external calls during command processing must use idempotency keys derived from the command's identity, not generated per-attempt.

## Review Trigger
Revisit if any single account consistently experiences high command contention (more than 10% of commands requiring more than one retry attempt). At that point, consider whether account-level command serialization via a dedicated queue is warranted for high-frequency accounts.

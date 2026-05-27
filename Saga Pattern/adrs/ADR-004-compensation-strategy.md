# ADR-004: Implement compensating transactions in reverse completion order

## Status
Accepted

## Date
2026-01-21

## Context
When a saga step fails after earlier steps have already succeeded, the business state is partially applied. We have charged a payment authorization, or reserved inventory, without completing the full order. Leaving this state in place means the customer is holding a reserved charge that will never result in a fulfilled order. We need a mechanism to undo completed steps cleanly and return the system to a consistent pre-order state.

The challenge is that compensations run in a system that is already in a degraded state -- the failure that stopped the saga may also be affecting the services we need to call for compensation. Compensations must therefore be designed to tolerate retries without causing additional damage (idempotent), and they must be observable so on-call can verify whether compensation completed or is stuck.

## Decision
For each participant service step, we define an explicit compensating action:

| Step | Forward action | Compensation |
|------|---------------|-------------|
| Payment | Authorize charge | Void/refund authorization |
| Inventory | Reserve stock | Release reservation |
| Shipping | Arrange shipment | Cancel shipment |

Compensation rules:
- Compensations execute strictly in reverse order of successfully completed steps. If only Payment completed before failure, only Payment is compensated. If Payment and Inventory completed, Inventory is compensated first, then Payment.
- Each compensation command is published to the participant's command queue using the same RabbitMQ topology as forward commands. This means compensation benefits from the same retry and dead-letter queue handling.
- Each compensation command carries the original `saga_id` and a `compensation: true` flag so participant services can apply any compensation-specific logic.
- A compensation is considered complete when the orchestrator receives the corresponding confirmation event.
- If a compensation step fails after retries are exhausted, the saga moves to a `COMPENSATION_FAILED` state and an alert fires. Manual intervention is required.

## Alternatives Considered

**Pivot transactions (sagas that skip compensation):** Some saga designs allow a "pivot" point -- steps before the pivot can be compensated, steps after cannot and are allowed to complete regardless. We considered this for Shipping since cancelling a shipment may not always be possible. Rejected for now; we handle this edge case in the Shipping service's cancel handler, which returns a specific error code that triggers a manual intervention alert rather than retrying.

**Immediate synchronous compensation:** When a failure occurs, compensate synchronously before returning an error to the client. Rejected because the compensation itself can fail, and coupling the client response to compensation completion makes the error response indefinitely delayed. Async compensation with a status endpoint is cleaner.

**Saga store-based compensation state:** Track compensation state separately from forward saga state. Rejected for complexity; the existing state machine handles compensation as additional states (COMPENSATING, COMPENSATION_FAILED) without needing a separate model.

## Consequences

### Positive
- Compensation logic is co-located with forward logic in the orchestrator, making the full workflow readable in one place
- Async compensation via the existing queue topology means compensation retries are handled automatically
- The `COMPENSATION_FAILED` state is an explicit, alertable terminal state rather than a silent data inconsistency

### Negative
- Each participant service must implement both a forward handler and a compensation handler, increasing code surface
- Testing compensation paths requires simulating failures at each step of the saga, which makes integration tests more complex
- A `COMPENSATION_FAILED` state requires manual resolution; there is no automated path out of it

## Review Trigger
Revisit if any compensation action becomes truly non-reversible (e.g., a physical goods shipment that has already left the warehouse). At that point, we need a formal policy for what to offer the customer instead of a technical rollback.

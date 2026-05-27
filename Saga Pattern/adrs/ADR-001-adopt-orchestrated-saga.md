# ADR-001: Adopt an orchestrated saga for multi-service order processing

## Status
Accepted

## Date
2025-07-16

## Context
Order processing in this system touches three independent services: Payment, Inventory, and Shipping. Each owns its own database and has no shared transactional boundary with the others. Early in the project we handled this with a sequential service call chain inside the Orders API -- call Payment, then Inventory, then Shipping -- and rolled back manually on failure. This worked until we hit a production incident where the Payment authorization succeeded, the Inventory reservation succeeded, but a Shipping service deploy caused the third call to time out. We had charged the customer and reserved stock but created no shipment. Resolving that by hand took two engineers an afternoon.

We ruled out two-phase commit because no service in the stack supports XA transactions, and introducing that dependency would have created tight coupling between teams that deploy independently. We needed a pattern that preserved service autonomy while guaranteeing that a multi-step business operation either completed fully or rolled back in a predictable, auditable way.

## Decision
We implement an orchestrated saga for order processing. A dedicated Saga Orchestrator service owns the workflow state machine and drives each step by publishing commands to service queues via RabbitMQ. Services execute local transactions and publish result events back to the orchestrator. The orchestrator transitions its internal state based on events and issues the next command, or triggers compensations if a step fails.

Specific implementation choices:
- State machine has six states: STARTED, PAYMENT_OK, INVENTORY_OK, COMPLETED, COMPENSATING, FAILED
- Saga state is persisted to a durable store after every transition so restarts are safe
- Each command carries a `saga_id` and `correlation_id` for end-to-end tracing
- The orchestrator retries idempotent commands up to three times with exponential backoff before declaring a step failed
- Compensation executes in reverse order of successful steps only

We chose orchestration over choreography because the workflow has strict ordering requirements and we wanted a single place where the complete state of any in-flight order is visible. Choreography would have spread that logic across three services with no central state.

## Alternatives Considered

**Choreography-based saga:** Each service listens for domain events and publishes its own events to trigger the next step. Rejected because debugging a stuck or partially-completed order would require correlating events across three separate service logs with no central state. The visibility tradeoff was not worth the reduced coupling for this workflow.

**Synchronous call chain with manual rollback:** The original approach we replaced. Rejected because the payment/inventory/no-shipment incident was its direct result. Error handling was ad-hoc and non-idempotent, meaning a retry could double-charge a customer.

**Distributed transaction (2PC):** Would require all three services to support XA or a compatible protocol. None do, and introducing that constraint would block independent deployments. The coordination cost is too high.

## Consequences

### Positive
- A stuck or partially-completed order has one place to diagnose: the orchestrator state store
- Compensations are explicit, versioned, and independently testable
- Services remain autonomous -- Payment, Inventory, and Shipping have no direct knowledge of each other
- New workflow steps (e.g., fraud check) can be inserted in the orchestrator without modifying participant services
- The state machine produces a clean audit trail: every transition is a timestamped record

### Negative
- The orchestrator is a new critical dependency; if it is unavailable, no new orders can start
- Each step requires a compensating action, roughly doubling the code surface for workflow logic
- Testing all compensation paths requires a more complex test harness than the original synchronous approach

### Risks
- **Orchestrator state store corruption** leaves an order permanently stuck. Mitigation: daily backups, a manual recovery runbook, and an alert that fires when any saga has not progressed in over 30 minutes.

## Review Trigger
Revisit if we add more than two additional workflow steps. At that point the state machine complexity may justify adopting a dedicated workflow engine (Temporal, Conductor) rather than maintaining a hand-rolled orchestrator.

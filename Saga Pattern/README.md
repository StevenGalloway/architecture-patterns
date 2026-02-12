# Saga Pattern (Distributed Transactions)

## Summary
A **Saga** is a coordination pattern for achieving **data consistency across multiple services** without using distributed locks or 2-phase commit. A saga breaks a business transaction into a sequence of **local transactions**, each with a corresponding **compensating action**.

If a step fails, previously completed steps are compensated (undone) to restore a consistent state.

Two common saga styles:
- **Orchestrated Saga** (central coordinator drives the workflow) ✅ *used in this repo*
- **Choreographed Saga** (services react to events; no central coordinator)

This package focuses on “enterprise-ready” saga concerns:
- idempotency and at-least-once delivery
- compensations and failure handling
- timeouts / retries / dead-lettering strategy
- durable saga state
- observability and traceability (correlation IDs)

---

## Problem
In microservices architectures, a single business operation can span multiple services:
- Order creation
- Payment authorization
- Inventory reservation
- Shipping scheduling

Using a single ACID transaction across services is typically infeasible. Without a pattern, partial failures cause inconsistent state (e.g., payment captured but inventory not reserved).

---

## Constraints & Forces
- Services own their data (no shared database)
- Distributed systems have partial failures, timeouts, and retries
- Most message buses provide **at-least-once delivery** (duplicates)
- Steps must be reversible (compensations) or designed as “try-confirm-cancel”
- You must provide operational controls: replay, visibility, and dead-letter handling

---

## Solution: Orchestrated Saga
A **Saga Orchestrator** manages a state machine:
1. Create order (saga started)
2. **Authorize payment**
3. **Reserve inventory**
4. **Arrange shipping**
5. Complete order

On failure, orchestrator triggers compensations in reverse order:
- Cancel shipping
- Release inventory
- Refund/void payment

---

## When to Use
- Multi-step transactions across services must be consistent
- You can define compensations / cancel actions
- You can tolerate eventual consistency and asynchronous completion

## When Not to Use
- Strict global ACID consistency required for every operation
- No meaningful compensation exists (or business won’t accept it)
- Team lacks operational maturity for message-based workflows

---

## Tradeoffs
### Benefits
- Avoids distributed locking and 2PC
- Clear failure model and business-level rollbacks
- Scales independently per service

### Costs / Risks
- Complex orchestration logic and state management
- Compensations can be imperfect (external side effects)
- Requires strong idempotency and observability

---

## Failure Modes & Mitigations
1. **Duplicate message delivery**
   - Mitigation: idempotency keys + processed-message store
2. **Step timeouts / hung workflows**
   - Mitigation: timeouts, retries, DLQ, manual resolution runbooks
3. **Compensation fails**
   - Mitigation: retry + alert; design compensations to be idempotent
4. **Orchestrator crash loses saga state**
   - Mitigation: durable saga store (e.g., DB) + resume on restart
5. **Out-of-order events**
   - Mitigation: state machine guards + versioned saga state

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-orchestrated-saga-sequence.mmd`
- `diagrams/03-compensation-flow.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-orchestrated-saga.md`
- `adrs/ADR-002-messaging-and-delivery-semantics.md`
- `adrs/ADR-003-idempotency-and-durable-state.md`
- `adrs/ADR-004-compensation-strategy.md`
- `adrs/ADR-005-timeouts-retries-and-ops.md`

---

## Example (Different Tech)
This example uses **Go + RabbitMQ + BoltDB** (different from the previous Node/Python examples):
- `orchestrator`: saga state machine + durable store
- `payment-service`: authorize + refund
- `inventory-service`: reserve + release
- `shipping-service`: arrange + cancel

See `examples/go-saga/`.

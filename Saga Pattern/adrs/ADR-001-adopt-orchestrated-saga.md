# ADR-001: Adopt an orchestrated Saga for multi-service order processing

## Status
Accepted

## Date
2026-01-11

## Context
Order processing spans Payment, Inventory, and Shipping services. We require consistency without distributed locking or 2-phase commit.

## Decision
Implement an **orchestrated Saga**:
- a central orchestrator drives step execution and compensations
- services remain autonomous with local transactions
- state machine and durable saga state enable recovery

## Consequences
### Positive
- clear ownership of the workflow and rollback logic
- predictable failure handling and observability
- services stay decoupled (no shared DB)

### Negative
- orchestrator becomes a critical component
- additional complexity: state machine, retries, DLQs, and runbooks

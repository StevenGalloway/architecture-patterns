# ADR-004: Use compensating actions in reverse order of completion

## Status
Accepted

## Date
2026-01-11

## Context
If a later step fails, earlier steps must be undone to restore business consistency.

## Decision
For each local transaction, define an idempotent compensation:
- Payment: Refund/Void authorization
- Inventory: Release reservation
- Shipping: Cancel shipment

Compensations execute **in reverse order** of completed steps.

## Consequences
- clear rollback semantics
- compensations must be designed to be safe, idempotent, and observable

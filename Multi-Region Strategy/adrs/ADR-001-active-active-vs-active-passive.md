# ADR-001: Choose Active/Active for critical customer-facing APIs

## Status
Accepted

## Date
2026-01-11

## Context
We require low latency and high availability. DR should be continuously exercised rather than rarely invoked.

## Decision
Adopt **Active/Active** for tier-1 APIs where multi-region data stores can support the required consistency and where user experience benefits from latency routing.

## Consequences
- better availability and lower latency
- higher cost and more complex incident scenarios (partial failures)

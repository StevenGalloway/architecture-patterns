# ADR-004: Enforce timeouts and cancellation for bulkhead-protected calls

## Status
Accepted

## Date
2026-01-11

## Context
If calls are allowed to hang, they will hold bulkhead permits, reducing capacity and causing avoidable saturation.

## Decision
- apply strict timeouts to downstream calls
- cancel in-flight requests where supported
- ensure permits are always released (finally/Drop)

## Consequences
- improves steady-state capacity and recovery
- requires careful timeout budgeting and consistent client configuration

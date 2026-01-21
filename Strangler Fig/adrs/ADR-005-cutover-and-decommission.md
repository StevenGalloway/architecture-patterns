# ADR-005: Progressive cutover and decommission plan

## Status
Accepted

## Date
2026-01-11

## Context
Once verification indicates parity, we need a safe way to shift traffic and ultimately remove legacy components.

## Decision
- Perform **canary cutover** (5% → 25% → 100%) with SLO and diff gates
- Keep **instant rollback** path via router rules
- After stable 100% traffic for an agreed period:
  - remove legacy route
  - archive legacy module
  - decommission legacy infrastructure for that slice

## Consequences
- Reduced long-term operational cost and complexity
- Requires strict readiness criteria and a documented runbook

# ADR-004: Use shadow reads and output comparison before cutover

## Status
Accepted

## Date
2026-01-11

## Context
Legacy behavior is often undocumented. We need to validate the new service matches expectations before routing production traffic.

## Decision
Run **shadow mode** before cutover:
- Legacy remains authoritative
- Edge Router sends shadow requests to the new service (no side effects)
- Compare outputs and emit metrics (diff rate, field mismatches)
- Maintain golden datasets and replay harness for regression

## Consequences
- Higher confidence cutover
- Extra compute and operational complexity during the shadow phase

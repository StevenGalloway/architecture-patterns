# ADR-001: Prefer Canary releases over Blue/Green for high-traffic services

## Status
Accepted

## Date
2026-01-11

## Context
We deploy frequently and need to minimize blast radius while validating changes against real traffic.

## Decision
Use **Canary** releases (progressive traffic shifting + analysis) for high-traffic services. Use Blue/Green when we need instant cutover or environment parity testing.

## Consequences
- safer rollouts with automated gating
- requires traffic splitting and robust observability

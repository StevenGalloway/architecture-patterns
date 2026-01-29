# ADR-002: Event contracts are versioned and backward-compatible

## Status
Accepted

## Date
2026-01-11

## Context
Events are long-lived integration contracts. Consumers (projectors, analytics) may lag behind producers. Breaking event changes can cause incidents and block deployments.

## Decision
- All events include: `event_id`, `type`, `version`, `occurred_at`, `aggregate_id`, `aggregate_version`
- Evolution rules:
  - prefer additive fields
  - never change meaning of existing fields
  - deprecate fields with a sunset period
  - bump `version` on incompatible changes and support dual-read in projectors

## Consequences
- safer long-term evolution
- requires compatibility testing and governance

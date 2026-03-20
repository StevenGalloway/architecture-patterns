# ADR-004: Automatic abort and rollback on analysis failure

## Status
Accepted

## Date
2026-01-11

## Context
Manual intervention increases mean time to mitigate and can create inconsistent outcomes.

## Decision
Configure rollouts to:
- **abort** on analysis failure
- **set canary weight to 0%**
- **promote stable** as the active version
and page on-call with clear rollout context.

## Consequences
- faster mitigation and reduced blast radius
- requires careful threshold tuning to avoid flapping

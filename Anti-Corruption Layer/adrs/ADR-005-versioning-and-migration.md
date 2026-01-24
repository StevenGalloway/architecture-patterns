# ADR-005: Support versioned mappings and safe migration

## Status
Accepted

## Date
2026-01-11

## Context
Vendors sometimes introduce new versions or gradually roll out schema changes. We need a safe way to update mappings without breaking consumers.

## Decision
- Implement mapping versions (v1/v2) in the ACL
- Choose mapping version based on:
  - vendor version header (preferred), or
  - field presence detection (fallback), and/or
  - feature flag rollouts
- Maintain backward compatible canonical model or version it if necessary

## Consequences
- Safer migration with controlled rollout
- Adds operational complexity and governance requirements

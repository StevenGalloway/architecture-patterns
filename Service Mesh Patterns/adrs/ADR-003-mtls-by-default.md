# ADR-003: Enforce mTLS-by-default for meshed workloads

## Status
Accepted

## Date
2026-01-11

## Context
Service-to-service traffic must be encrypted and authenticated to reduce lateral movement risk and simplify compliance.

## Decision
Enable **mTLS by default** for workloads participating in the mesh and use service identities for authentication.

## Consequences
- stronger security baseline and reduced configuration drift
- requires certificate lifecycle monitoring and incident runbooks

# ADR-001: Enforce rate limiting at the edge

## Status
Accepted

## Date
2026-01-11

## Context
We need to protect backend services from spikes and abuse while providing consistent, centrally managed policies.

## Decision
Implement rate limiting at the **edge/API gateway** so limits are applied before traffic reaches internal services.

## Consequences
- reduces blast radius and protects upstream dependencies
- requires gateway configuration governance and testing
